/**
 * ShellClient — pure TypeScript wrapper around the bridge's
 * ``POST /api/run-stream`` endpoint.
 *
 * One ``ShellClient`` instance represents one browser tab's view of the
 * rarebert shell.  It owns no UI state; callers subscribe to its event
 * stream and render however they like (xterm.js in our case).
 *
 * Public surface:
 *   * ``submit(command, shell?)``  — runs one command, returns an
 *     ``AsyncIterable<ShellFrame>`` so callers can ``for await`` it or
 *     attach a Promise chain.
 *   * ``cancel()``                 — aborts the in-flight request.
 *   * ``ready`` / ``idle``         — booleans the UI can read.
 *
 * There is no shared singleton; create a new client per mount.
 */

import {
    type ShellEventKind,
    type ShellFrame,
    parseSseFrame,
} from "./types";

/** Default endpoint path; Vite proxies ``/api`` to the bridge. */
const DEFAULT_ENDPOINT = "/api/run-stream";

export interface ShellClientOptions {
    /** Path or full URL of the run-stream endpoint. */
    endpoint?: string;
    /** AbortSignal triggered when the caller wants to cancel. */
    signal?: AbortSignal;
    /** ``fetch`` override for testing. */
    fetchImpl?: typeof fetch;
}

export class ShellClient {
    readonly endpoint: string;
    private readonly opts: ShellClientOptions;
    private readonly fetchImpl: typeof fetch;
    private _ready = false;
    private _idle = true;
    private _currentAbort: AbortController | null = null;

    constructor(opts: ShellClientOptions = {}) {
        this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
        this.opts = opts;
        // Bind ``fetch`` to ``globalThis`` so the browser doesn't throw
        // "Illegal Invocation" when we invoke the captured reference
        // through a different receiver.  Without ``.bind`` here the
        // bundled reference ends up as a free function pointer, which
        // some engines (notably Safari) reject.
        const baseFetch: typeof fetch =
            opts.fetchImpl ?? fetch.bind(globalThis);
        this.fetchImpl = baseFetch;
    }

    get ready(): boolean {
        return this._ready;
    }

    get idle(): boolean {
        return this._idle;
    }

    /**
     * Run one command and yield frames as they arrive.  Throws
     * ``ShellClientError`` on network / HTTP errors.
     */
    async *submit(command: string, shell = "make"): AsyncIterable<ShellFrame> {
        if (!this._idle) {
            throw new ShellClientError("another command is already running");
        }
        this._idle = false;
        this._currentAbort = new AbortController();
        if (this.opts.signal) {
            this.opts.signal.addEventListener("abort", () => this._currentAbort?.abort());
        }

        try {
            const response = await this.fetchImpl(this.endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ shell, command }),
                signal: this._currentAbort.signal,
            });
            if (!response.ok) {
                throw new ShellClientError(`HTTP ${response.status} ${response.statusText}`);
            }
            if (!response.body) {
                throw new ShellClientError("response has no body");
            }
            this._ready = true;

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            // Drain the stream, splitting on the SSE blank-line delimiter.
            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                buffer += decoder.decode(value, { stream: true });

                let idx: number;
                while ((idx = buffer.indexOf("\n\n")) >= 0) {
                    const block = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    const frame = parseSseFrame(block);
                    if (frame) {
                        yield frame;
                        if (frame.event === ("done" as ShellEventKind)) {
                            return;
                        }
                    }
                }
            }
        } finally {
            this._ready = false;
            this._idle = true;
            this._currentAbort = null;
        }
    }

    /**
     * Cancel the in-flight request, if any.  No-op when idle.
     */
    cancel(): void {
        this._currentAbort?.abort();
    }
}

export class ShellClientError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ShellClientError";
    }
}