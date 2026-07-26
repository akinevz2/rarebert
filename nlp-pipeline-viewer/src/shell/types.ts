/**
 * Shared types for the rarebert shell frontend.
 *
 * The backend bridge (`stream_subprocess.py`) emits three kinds of SSE
 * frames during a command run:
 *
 *     event: open   data: {"session": "ses-...", "argv": [...], "shell": "make"}
 *     event: line   data: {"line": "..."}     # repeated
 *     event: bytes  data: {"data": "<base64>"} # only for REPL
 *     event: done   data: {"returncode": 0, "rejected"?: true, "noop"?: true}
 *
 * This module is a pure data file — no Vue, no DOM, no fetch.
 */

export type ShellEventKind = "open" | "line" | "bytes" | "done";

export interface ShellOpenEvent {
    session: string;
    argv?: string[];
    shell?: string;
}

export interface ShellLineEvent {
    line: string;
}

export interface ShellBytesEvent {
    /** base64-encoded bytes — decode with `atob` for the raw payload. */
    data: string;
}

export interface ShellDoneEvent {
    returncode: number;
    /** True when the shell rejected the line before spawning anything. */
    rejected?: boolean;
    /** True when the line was empty / a comment and nothing was run. */
    noop?: boolean;
}

export interface ShellFrame {
    event: ShellEventKind;
    payload:
    | ShellOpenEvent
    | ShellLineEvent
    | ShellBytesEvent
    | ShellDoneEvent;
}

/**
 * Parse a single SSE event block (text up to the first blank line) into
 * a structured frame.  Returns ``null`` for frames we don't care about
 * (e.g. comments, heartbeat lines).
 */
export function parseSseFrame(block: string): ShellFrame | null {
    let eventName: ShellEventKind | null = null;
    const dataLines: string[] = [];

    for (const raw of block.split("\n")) {
        const line = raw.replace(/\r$/, "");
        if (!line || line.startsWith(":")) {
            continue;
        }
        if (line.startsWith("event: ")) {
            eventName = line.slice(7).trim() as ShellEventKind;
        } else if (line.startsWith("data: ")) {
            dataLines.push(line.slice(6));
        }
    }

    if (!eventName || dataLines.length === 0) {
        return null;
    }

    try {
        const payload = JSON.parse(dataLines.join("\n"));
        return { event: eventName, payload };
    } catch {
        return null;
    }
}