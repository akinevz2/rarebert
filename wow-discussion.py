"""World of Warcraft TBC discussion assistant powered by local Ollama.

Usage examples:
  make wow-discussion TOPIC="best pre-raid holy paladin pieces" WHOM=qwen3.6:27b-q4_K_M
  make wow-discussion SESSION=arena SEARCH=1 TOPIC="arms warrior pvp stat priority"
  make wow-discussion SESSION=arena RECALL="resilience" TOPIC="summarise previous advice"
  make wow-discussion SESSION=arena RESET=1
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import textwrap
from datetime import datetime, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote_plus
from urllib.request import Request, urlopen

from devlib import (
    database_path,
    env_bool,
    env_or_arg,
    list_available_ollama_hosts,
    parse_kv_args,
    prompt_text,
    run,
    select_ollama_host_tui,
)


DEFAULT_MODEL = os.getenv("WOW_MODEL", "qwen3.6:27b-q4_K_M")
DEFAULT_HOST = os.getenv("OLLAMA_HOST", "")
DEFAULT_DB = os.getenv("WOW_DB", "")
DEFAULT_SEARCH = os.getenv("WOW_SEARCH", "0") == "1"

SYSTEM_PROMPT = textwrap.dedent(
    """
    You are a World of Warcraft theorycrafting assistant focused strictly on
    The Burning Crusade Classic / Anniversary (patch 2.4.3 era).

    Scope rules:
    - Answer only TBC Classic / Anniversary questions.
    - If asked about non-TBC eras (Retail, Wrath, SoD, etc), politely decline and
      redirect to TBC context.
    - Show assumptions (spec, role, PvE/PvP, phase) if not provided.
    - For gear tradeoffs, show a compact side-by-side stat comparison and verdict.
    - Do not fabricate item IDs, exact coefficients, or obscure mechanics.
    - If uncertain, state uncertainty and suggest verification on wowhead.com/tbc or
      warcraft.wiki.gg.

    Style:
    - Concise, practical, and TBC terminology.
    - Prefer bullet points when listing priorities.
    """
).strip()


def model_suggestions() -> list[str]:
    """Collect model suggestions from persisted Ollama hosts."""
    names: list[str] = []
    seen: set[str] = set()
    for host in list_available_ollama_hosts():
        for model in host.get("models", []):
            candidate = str(model).strip()
            if candidate and candidate not in seen:
                seen.add(candidate)
                names.append(candidate)
    return names


def normalize_base_url(where_value: str) -> str:
    """Normalize host or host:port into full Ollama base URL."""
    value = where_value.strip().rstrip("/")
    if value.startswith(("http://", "https://")):
        return value
    if re.search(r":\d+$", value):
        return f"http://{value}"
    return f"http://{value}:11434"


def now_utc() -> str:
    """Return UTC timestamp in ISO format."""
    return datetime.now(timezone.utc).isoformat()


def connect_db(path: str) -> sqlite3.Connection:
    """Open SQLite connection and ensure required tables and indices."""
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS wow_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            model TEXT NOT NULL,
            host TEXT NOT NULL,
            created_utc TEXT NOT NULL,
            updated_utc TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS wow_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL REFERENCES wow_sessions(id) ON DELETE CASCADE,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_utc TEXT NOT NULL
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS wow_messages_fts USING fts5(
            content,
            content='wow_messages',
            content_rowid='id'
        );

        CREATE TRIGGER IF NOT EXISTS wow_messages_ai AFTER INSERT ON wow_messages BEGIN
            INSERT INTO wow_messages_fts(rowid, content) VALUES (new.id, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS wow_messages_ad AFTER DELETE ON wow_messages BEGIN
            INSERT INTO wow_messages_fts(wow_messages_fts, rowid, content)
            VALUES ('delete', old.id, old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS wow_messages_au AFTER UPDATE ON wow_messages BEGIN
            INSERT INTO wow_messages_fts(wow_messages_fts, rowid, content)
            VALUES ('delete', old.id, old.content);
            INSERT INTO wow_messages_fts(rowid, content) VALUES (new.id, new.content);
        END;
        """
    )
    conn.commit()
    return conn


def get_or_create_session(conn: sqlite3.Connection, name: str, model: str, host: str) -> int:
    """Get existing session by name or create it with current model/host."""
    row = conn.execute("SELECT id FROM wow_sessions WHERE name = ?", (name,)).fetchone()
    ts = now_utc()
    if row is not None:
        conn.execute(
            "UPDATE wow_sessions SET model = ?, host = ?, updated_utc = ? WHERE id = ?",
            (model, host, ts, int(row["id"])),
        )
        conn.commit()
        return int(row["id"])

    cur = conn.execute(
        """
        INSERT INTO wow_sessions (name, model, host, created_utc, updated_utc)
        VALUES (?, ?, ?, ?, ?)
        """,
        (name, model, host, ts, ts),
    )
    conn.commit()
    return int(cur.lastrowid)


def reset_session(conn: sqlite3.Connection, name: str) -> bool:
    """Delete one session and all messages. Return True if it existed."""
    row = conn.execute("SELECT id FROM wow_sessions WHERE name = ?", (name,)).fetchone()
    if row is None:
        return False

    session_id = int(row["id"])
    conn.execute("DELETE FROM wow_messages WHERE session_id = ?", (session_id,))
    conn.execute("DELETE FROM wow_sessions WHERE id = ?", (session_id,))
    conn.commit()
    return True


def save_message(conn: sqlite3.Connection, session_id: int, role: str, content: str) -> None:
    """Persist one message row."""
    conn.execute(
        """
        INSERT INTO wow_messages (session_id, role, content, created_utc)
        VALUES (?, ?, ?, ?)
        """,
        (session_id, role, content, now_utc()),
    )
    conn.execute(
        "UPDATE wow_sessions SET updated_utc = ? WHERE id = ?",
        (now_utc(), session_id),
    )
    conn.commit()


def load_history(conn: sqlite3.Connection, session_id: int) -> list[dict[str, str]]:
    """Load session message history ordered by insertion."""
    rows = conn.execute(
        "SELECT role, content FROM wow_messages WHERE session_id = ? ORDER BY id ASC",
        (session_id,),
    ).fetchall()
    return [{"role": str(row["role"]), "content": str(row["content"])} for row in rows]


def search_session(conn: sqlite3.Connection, session_id: int, query: str, limit: int = 5) -> list[dict[str, str]]:
    """FTS lookup over one session's messages."""
    rows = conn.execute(
        """
        SELECT m.role, m.content
        FROM wow_messages_fts f
        JOIN wow_messages m ON f.rowid = m.id
        WHERE f MATCH ?
          AND m.session_id = ?
        LIMIT ?
        """,
        (query, session_id, limit),
    ).fetchall()
    return [{"role": str(row["role"]), "content": str(row["content"])} for row in rows]


def list_sessions(conn: sqlite3.Connection) -> None:
    """Print sessions sorted by recent activity."""
    rows = conn.execute(
        """
        SELECT name, model, host, updated_utc
        FROM wow_sessions
        ORDER BY updated_utc DESC
        """
    ).fetchall()

    if not rows:
        print("No WoW discussion sessions found.")
        return

    print(f"{'SESSION':<22} {'MODEL':<24} {'HOST':<24} UPDATED")
    print("-" * 92)
    for row in rows:
        print(
            f"{str(row['name']):<22} "
            f"{str(row['model']):<24} "
            f"{str(row['host']):<24} "
            f"{str(row['updated_utc'])[:19]}"
        )


def web_search(topic: str, max_results: int = 4) -> str:
    """Simple DDG HTML scrape for TBC references without third-party deps."""
    scoped = (
        f"{topic} "
        "site:wowhead.com/tbc OR site:warcraft.wiki.gg "
        "OR site:icy-veins.com/tbc-classic"
    )
    url = f"https://html.duckduckgo.com/html/?q={quote_plus(scoped)}"
    request = Request(url, headers={"User-Agent": "Mozilla/5.0 wow-discussion/1.0"})

    try:
        with urlopen(request, timeout=12) as response:  # nosec B310: intentional HTTP endpoint
            html = response.read().decode("utf-8", errors="replace")
    except Exception as exc:  # noqa: BLE001
        return f"[search unavailable: {exc}]"

    titles = re.findall(r'class="result__a"[^>]*>(.*?)</a>', html, re.DOTALL)
    snippets = re.findall(r'class="result__snippet"[^>]*>(.*?)</a>', html, re.DOTALL)
    hrefs = re.findall(r'class="result__url"[^>]*>(.*?)</a>', html, re.DOTALL)

    def clean(text: str) -> str:
        text = re.sub(r"<[^>]+>", "", text)
        text = re.sub(r"\s+", " ", text)
        return text.strip()

    lines: list[str] = []
    for idx in range(max_results):
        if idx >= len(titles) and idx >= len(snippets):
            break
        title = clean(titles[idx]) if idx < len(titles) else "(untitled)"
        snippet = clean(snippets[idx]) if idx < len(snippets) else ""
        href = clean(hrefs[idx]) if idx < len(hrefs) else ""
        lines.append(f"[{idx + 1}] {title}\n    {href}\n    {snippet}")

    if not lines:
        return "[search returned no parsable results]"
    return "\n\n".join(lines)


def build_search_context(topic: str) -> str:
    """Build extra prompt context from lightweight web search."""
    print("[search] querying sources...", file=sys.stderr)
    results = web_search(topic)
    return (
        "=== WEB SEARCH RESULTS (supplement only; do not fabricate details) ===\n"
        + results
        + "\n=== END WEB SEARCH RESULTS ==="
    )


def ollama_chat(host: str, model: str, messages: list[dict[str, str]]) -> str:
    """Send chat request to Ollama /api/chat and stream the response."""
    endpoint = f"{normalize_base_url(host)}/api/chat"
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "options": {"temperature": 0.65, "num_ctx": 8192},
    }
    request = Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    full: list[str] = []
    with urlopen(request, timeout=120) as response:  # nosec B310: intentional HTTP endpoint
        print("\n[Assistant] ", end="", flush=True)
        for raw in response:
            line = raw.decode("utf-8").strip()
            if not line:
                continue
            try:
                chunk = json.loads(line)
            except json.JSONDecodeError:
                continue

            token = chunk.get("message", {}).get("content", "")
            if token:
                print(token, end="", flush=True)
                full.append(token)
            if chunk.get("done"):
                print()
                break

    return "".join(full).strip()


def print_usage_hint() -> None:
    """Print concise usage guidance."""
    print("Usage: python3 wow-discussion.py TOPIC=<question> [WHOM=<model>] [SESSION=<name>]")
    print("       [WHERE=<host[:port]>] [SEARCH=1] [RECALL=<query>] [LIST=1] [RESET=1]")


def main() -> int:
    try:
        args = parse_kv_args(sys.argv[1:])

        topic = env_or_arg(args, "TOPIC")
        model = env_or_arg(args, "WHOM", DEFAULT_MODEL)
        session_name = env_or_arg(args, "SESSION", "default")
        where = env_or_arg(args, "WHERE", DEFAULT_HOST)
        recall_query = env_or_arg(args, "RECALL")
        list_only = env_bool("LIST") or args.get("LIST", "0") == "1"
        reset = env_bool("RESET") or args.get("RESET", "0") == "1"
        search = DEFAULT_SEARCH or env_bool("SEARCH") or args.get("SEARCH", "0") == "1"

        if not session_name:
            session_name = prompt_text("Session name (SESSION)", default="default")

        db_path = env_or_arg(args, "DB", DEFAULT_DB)
        if not db_path:
            db_path = str(database_path())

        conn = connect_db(db_path)
        try:
            if list_only:
                list_sessions(conn)
                return 0

            if reset:
                removed = reset_session(conn, session_name)
                if removed:
                    print(f"[reset] cleared session '{session_name}'")
                else:
                    print(f"[reset] no existing session named '{session_name}'")
                if not topic and not recall_query:
                    return 0

            session_id = get_or_create_session(conn, session_name, model, where)

            if recall_query:
                results = search_session(conn, session_id, recall_query)
                if not results:
                    print(f"[recall] no matches for '{recall_query}'")
                else:
                    print(f"[recall] {len(results)} match(es):")
                    for idx, row in enumerate(results, start=1):
                        snippet = row["content"].replace("\n", " ")[:260]
                        print(f"  {idx}. [{row['role']}] {snippet}")
                if not topic:
                    return 0

            if not topic:
                topic = prompt_text("Discussion topic/question (TOPIC)")

            if not model:
                model = prompt_text(
                    "Model (WHOM)",
                    default=DEFAULT_MODEL,
                    suggestions=model_suggestions(),
                )

            if not where:
                where = select_ollama_host_tui("Select an Ollama host for wow-discussion")

            history = load_history(conn, session_id)
            user_content = topic
            if search:
                user_content = f"{topic}\n\n{build_search_context(topic)}"

            outbound = [{"role": "system", "content": SYSTEM_PROMPT}, *history, {"role": "user", "content": user_content}]

            print(f"\n[session={session_name}] [model={model}] [host={where}] [search={'on' if search else 'off'}]")
            print(f"[You] {topic}")

            response = ollama_chat(where, model, outbound)
            save_message(conn, session_id, "user", topic)
            save_message(conn, session_id, "assistant", response)
            return 0
        finally:
            conn.close()
    except (ValueError, RuntimeError, HTTPError, URLError, sqlite3.Error) as exc:
        print(f"Error: {exc}")
        print_usage_hint()
        return 2


if __name__ == "__main__":
    raise SystemExit(run(main))
