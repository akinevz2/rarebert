"""List WoW discussion sessions with first/last user-message summaries.

Usage examples:
  make wow-list-sessions
  make wow-list-sessions ARG='DB=/path/to/rarebert.db'
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

from devlib import parse_kv_args, run


def connect_db(path: str) -> sqlite3.Connection:
    """Open the WoW database and ensure required tables exist."""
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
        """
    )
    conn.commit()
    return conn


def compact_one_line(text: str, limit: int = 88) -> str:
    """Trim whitespace and cap message length for compact display."""
    cleaned = " ".join(text.split())
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 3].rstrip() + "..."


def list_sessions_with_user_edges(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """Return sessions with first/last user messages and message count."""
    return conn.execute(
        """
        WITH session_counts AS (
            SELECT session_id, COUNT(*) AS message_count
            FROM wow_messages
            GROUP BY session_id
        ),
        first_user AS (
            SELECT m.session_id, m.content
            FROM wow_messages m
            JOIN (
                SELECT session_id, MIN(id) AS min_id
                FROM wow_messages
                WHERE role = 'user'
                GROUP BY session_id
            ) x ON x.session_id = m.session_id AND x.min_id = m.id
        ),
        last_user AS (
            SELECT m.session_id, m.content
            FROM wow_messages m
            JOIN (
                SELECT session_id, MAX(id) AS max_id
                FROM wow_messages
                WHERE role = 'user'
                GROUP BY session_id
            ) x ON x.session_id = m.session_id AND x.max_id = m.id
        )
        SELECT
            s.id,
            s.name,
            s.model,
            s.host,
            s.updated_utc,
            COALESCE(c.message_count, 0) AS message_count,
            fu.content AS first_user_message,
            lu.content AS last_user_message
        FROM wow_sessions s
        LEFT JOIN session_counts c ON c.session_id = s.id
        LEFT JOIN first_user fu ON fu.session_id = s.id
        LEFT JOIN last_user lu ON lu.session_id = s.id
        ORDER BY s.updated_utc DESC
        """
    ).fetchall()


def print_report(rows: list[sqlite3.Row]) -> None:
    """Print sessions in a readable table and one-line summaries."""
    if not rows:
        print("No WoW discussion sessions found.")
        return

    print(f"{'SESSION':<20} {'MODEL':<20} {'HOST':<22} {'MSGS':>4} UPDATED")
    print("-" * 92)

    for row in rows:
        first = row["first_user_message"]
        last = row["last_user_message"]
        first_line = compact_one_line(str(first)) if first else "(no user messages)"
        last_line = compact_one_line(str(last)) if last else "(no user messages)"

        print(
            f"{str(row['name'])[:20]:<20} "
            f"{str(row['model'])[:20]:<20} "
            f"{str(row['host'])[:22]:<22} "
            f"{int(row['message_count']):>4} "
            f"{str(row['updated_utc'])[:19]}"
        )
        print(f"  first user: {first_line}")
        print(f"  last user : {last_line}")
        print()


def usage() -> None:
    """Print usage text."""
    print("Usage: python3 wow-list-sessions.py [DB=<path/to/rarebert.db>]")


def main() -> int:
    try:
        args = parse_kv_args(sys.argv[1:])
        db_path = args.get("DB", "").strip()
        if not db_path:
            db_path = str(Path(".") / "rarebert.db")

        conn = connect_db(db_path)
        try:
            rows = list_sessions_with_user_edges(conn)
        finally:
            conn.close()

        print_report(rows)
        return 0
    except (ValueError, sqlite3.Error) as exc:
        print(f"Error: {exc}")
        usage()
        return 2


if __name__ == "__main__":
    raise SystemExit(run(main))
