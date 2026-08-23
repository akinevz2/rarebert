/**
 * OpenAI-compatible HTTP server with programmable routing middleware.
 *
 * Listens on a configurable port (default 11444) and forwards
 * OpenAI-compatible API requests to a backend baseURL (default
 * http://localhost:11434/v1).
 *
 * Requests pass through a {@link MiddlewarePipeline} before being
 * forwarded.  Middleware may short-circuit a request (return a direct
 * response) or transform the forwarded request / backend response.
 *
 * During idle moments (no pending requests), the server triggers
 * introspection analysis on recent conversation messages to learn
 * new bash-command patterns for short-circuiting.
 *
 * Uses only Node.js built-ins: `node:http`, global `fetch`,
 * `node:sqlite`.  No external npm dependencies.
 */

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { database } from './database.ts';
import { kvCache } from './kv.ts';
import { middlewarePipeline } from './middleware/pipeline.ts';
import { BashShortCircuitMiddleware } from './middleware/bash-shortcircuit.ts';
import type {
    ServerConfig,
    PartialServerConfig,
    ServerHandle,
    Middleware,
    ChatCompletionRequest,
    ChatCompletionResponse,
    ModelListResponse,
    MiddlewareContext,
} from './types.ts';
import { log } from './logger.ts';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------


// verbose flag control
const HOST = !!process.env.SERVER_BACKEND || process.argv.some(arg => arg.startsWith('--host'));
const VERBOSE = !!process.env.SERVER_VERBOSE || process.argv.some(arg => arg === '--verbose');
const DEFAULT_PORT = 11444;
const DEFAULT_BASE_URL = process.env.SERVER_BACKEND_URL || 'http://localhost:11434/v1';
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

// Server startup banner
log.success(`🖥️  OpenAI-compatible server starting on port ${DEFAULT_PORT}`);
log.info(`🔗  Forwarding requests to ${DEFAULT_BASE_URL}`);
log.info(`🧠  Bash short-circuit middleware initialising`);

// Known short-circuit patterns (populated during introspection)
const knownShortcircuits: Set<string> = new Set();

// ---------------------------------------------------------------------------
// OpenAIServer class
// ---------------------------------------------------------------------------

export class OpenAIServer {
    private readonly config: ServerConfig;
    private server: http.Server | null = null;
    private running = false;

    /** Number of requests currently in flight. */
    private activeRequests = 0;

    /** Idle timer handle. */
    private idleTimer: ReturnType<typeof setTimeout> | null = null;

    /** Resolves when the server stops (part of ServerHandle). */
    private stoppedResolver: ((code: number) => void) | null = null;

    /** Bash short-circuit middleware instance (for introspection access). */
    private bashMiddleware: BashShortCircuitMiddleware | null = null;

    constructor(config: PartialServerConfig = {}) {
        this.config = {
            port: config.port ?? DEFAULT_PORT,
            baseURL: (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
            dbPath: config.dbPath,
            idleTimeoutMs: config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
        };
    }

    // ---- lifecycle --------------------------------------------------------

    /**
     * Start listening.  Returns a {@link ServerHandle} whose `stopped`
     * promise resolves with an exit code when the server closes.
     */
    start(): ServerHandle {
        if (this.running) {
            throw new Error('Server is already running');
        }

        // Register built-in middleware
        this.bashMiddleware = new BashShortCircuitMiddleware({
            baseURL: this.config.baseURL,
        });
        middlewarePipeline.register(this.bashMiddleware);

        this.server = http.createServer((req, res) => {
            this.handleRequest(req, res).catch((err) => {
                console.error(`[server] unhandled error: ${(err as Error).message}`);
                this.sendError(res, 500, 'Internal Server Error');
            });
        });

        const stopped = new Promise<number>((resolve) => {
            this.stoppedResolver = resolve;
        });

        const handle: ServerHandle = {
            stopped,
            close: () => this.close(),
        };

        this.server.listen(this.config.port, () => {
            console.log(`[server] listening on http://localhost:${this.config.port}`);
            console.log(`[server] forwarding to ${this.config.baseURL}`);
            this.running = true;
            this.scheduleIdleCheck();
        });

        this.server.on('error', (err) => {
            console.error(`[server] listen error: ${err.message}`);
            this.running = false;
            if (this.stoppedResolver) this.stoppedResolver(1);
        });

        return handle;
    }

    /** Gracefully close the server. */
    async close(): Promise<void> {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }

        if (this.server) {
            await new Promise<void>((resolve) => {
                this.server!.close(() => resolve());
            });
            this.server = null;
        }

        this.running = false;
        database.close();
        if (this.stoppedResolver) this.stoppedResolver(0);
    }

    // ---- request handling -------------------------------------------------

    /**
     * Main request handler.  Parses the body, builds a MiddlewareContext,
     * runs the pipeline, and either short-circuits or forwards.
     */
    private async handleRequest(
        req: IncomingMessage,
        res: ServerResponse,
    ): Promise<void> {
        this.activeRequests++;
        this.cancelIdleCheck();

        try {
            const url = new URL(
                req.url ?? '/',
                `http://localhost:${this.config.port}`,
            );
            const path = url.pathname;
            const method = req.method ?? 'GET';

            // Health check — no middleware, no forwarding
            if (path === '/v1/health' || path === '/health') {
                this.sendJson(res, 200, { status: 'ok' });
                return;
            }

            // Parse JSON body for POST requests
            let body: ChatCompletionRequest | null = null;
            if (method === 'POST') {
                const raw = await this.readBody(req);
                if (raw) {
                    try {
                        body = JSON.parse(raw) as ChatCompletionRequest;
                    } catch {
                        this.sendError(res, 400, 'Invalid JSON body');
                        return;
                    }
                }
            }

            const ctx: MiddlewareContext = {
                path,
                method,
                body,
                headers: req.headers as Record<string, string>,
            };

            // Models endpoint — cached, no middleware
            if (path === '/v1/models' && method === 'GET') {
                await this.handleModels(res);
                return;
            }

            // Run middleware pipeline for chat completions
            if (path === '/v1/chat/completions' && method === 'POST') {
                await this.handleChatCompletions(ctx, res);
                return;
            }

            // All other paths — forward directly
            await this.forwardRaw(req, res, body);
        } finally {
            this.activeRequests--;
            if (this.activeRequests === 0) {
                this.scheduleIdleCheck();
            }
        }
    }

    /**
     * Handle /v1/chat/completions with middleware pipeline.
     */
    private async handleChatCompletions(
        ctx: MiddlewareContext,
        res: ServerResponse,
    ): Promise<void> {
        if (!ctx.body) {
            this.sendError(res, 400, 'Missing request body');
            return;
        }

        try {
            const result = await middlewarePipeline.process(ctx);

            if (result.type === 'short-circuit') {
                this.sendJson(res, result.status ?? 200, result.body);
                return;
            }

            // Forward to backend
            const backendResponse = await this.forwardToBackend(
                result.request,
                ctx.path,
            );

            // Run response transforms
            const transformed = await middlewarePipeline.transform(
                ctx,
                backendResponse,
            );

            this.sendJson(res, 200, transformed);
        } catch (err) {
            console.error(
                `[server] chat/completions error: ${(err as Error).message}`,
            );
            this.sendError(res, 502, 'Bad Gateway');
        }
    }

    /**
     * Handle GET /v1/models with KV caching.
     */
    private async handleModels(res: ServerResponse): Promise<void> {
        const cached = kvCache.get('models');
        if (cached) {
            this.sendJson(res, 200, JSON.parse(cached));
            return;
        }

        try {
            const response = await fetch(`${this.config.baseURL}/models`);
            if (!response.ok) {
                this.sendError(res, response.status, 'Backend error');
                return;
            }
            const data = (await response.json()) as ModelListResponse;
            kvCache.set('models', JSON.stringify(data), 300_000); // 5 min TTL
            this.sendJson(res, 200, data);
        } catch (err) {
            console.error(
                `[server] models fetch error: ${(err as Error).message}`,
            );
            this.sendError(res, 502, 'Failed to fetch models from backend');
        }
    }

    // ---- forwarding -------------------------------------------------------

    /**
     * Forward a parsed chat-completion request to the backend.
     *
     * The incoming `path` includes the `/v1` prefix (e.g.
     * `/v1/chat/completions`).  Since `baseURL` already includes `/v1`
     * (e.g. `http://ws-rarebox:11434/v1`), we strip the leading `/v1`
     * from `path` to avoid a double-prefix 404.
     */
    private async forwardToBackend(
        body: ChatCompletionRequest,
        path: string,
    ): Promise<ChatCompletionResponse> {
        const strippedPath = path.replace(/^\/v1/, '');
        const response = await fetch(`${this.config.baseURL}${strippedPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Backend returned ${response.status}: ${text}`);
        }

        return (await response.json()) as ChatCompletionResponse;
    }

    /**
     * Forward a raw request (non-chat endpoints) to the backend,
     * streaming the response back.
     */
    private async forwardRaw(
        req: IncomingMessage,
        res: ServerResponse,
        parsedBody: ChatCompletionRequest | null,
    ): Promise<void> {
        try {
            // Strip /v1 prefix from incoming URL to avoid double-prefix
            // since baseURL already includes /v1
            const strippedUrl = (req.url ?? '/').replace(/^\/v1/, '');
            const url = `${this.config.baseURL}${strippedUrl}`;
            const headers: Record<string, string> = {};
            for (const [key, value] of Object.entries(req.headers)) {
                if (value && !['host', 'connection'].includes(key)) {
                    headers[key] = Array.isArray(value) ? value.join(',') : value;
                }
            }

            const body = parsedBody ? JSON.stringify(parsedBody) : undefined;

            const response = await fetch(url, {
                method: req.method ?? 'GET',
                headers,
                body,
            });

            res.writeHead(response.status, {
                'content-type': response.headers.get('content-type') ??
                    'application/json',
            });

            const text = await response.text();
            res.end(text);
        } catch (err) {
            console.error(
                `[server] forward error: ${(err as Error).message}`,
            );
            this.sendError(res, 502, 'Bad Gateway');
        }
    }

    // ---- idle / introspection --------------------------------------------

    /**
     * Schedule an idle check.  If no requests arrive within
     * `idleTimeoutMs`, trigger introspection.
     */
    private scheduleIdleCheck(): void {
        if (!this.running || this.activeRequests > 0) return;
        if (this.idleTimer) clearTimeout(this.idleTimer);

        this.idleTimer = setTimeout(() => {
            this.runIntrospection().catch((err) => {
                console.error(
                    `[server] introspection error: ${(err as Error).message}`,
                );
            });
        }, this.config.idleTimeoutMs);
    }

    private cancelIdleCheck(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    /**
     * Run introspection on recent classified messages.
     * In the initial implementation, this is a no-op placeholder —
     * introspection requires conversation history which is not yet
     * persisted.  The infrastructure is in place for future use.
     */
    private async runIntrospection(): Promise<void> {
        // TODO: When conversation history persistence is implemented,
        // retrieve recent conversations and pass them to
        // bashMiddleware.introspect(messages).
        //
        // For now, we just log that the idle trigger fired.
        if (this.config.idleTimeoutMs !== DEFAULT_IDLE_TIMEOUT_MS) {
            console.log('[server] idle — introspection would run now');
        }
    }

    // ---- utilities --------------------------------------------------------

    /** Read the full request body as a string. */
    private readBody(req: IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            let data = '';
            req.on('data', (chunk) => (data += chunk));
            req.on('end', () => resolve(data));
            req.on('error', reject);
        });
    }

    /** Send a JSON response. */
    private sendJson(res: ServerResponse, status: number, body: unknown): void {
        const json = JSON.stringify(body);
        res.writeHead(status, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(json),
        });
        res.end(json);
    }

    /** Send an error response. */
    private sendError(
        res: ServerResponse,
        status: number,
        message: string,
    ): void {
        this.sendJson(res, status, { error: { message, type: 'server_error' } });
    }

    // ---- public API -------------------------------------------------------

    /** Return the current server configuration. */
    getConfig(): ServerConfig {
        return { ...this.config };
    }

    /** Register an additional middleware at runtime. */
    registerMiddleware(middleware: Middleware): void {
        middlewarePipeline.register(middleware);
    }

    /** Unregister a middleware by name. */
    unregisterMiddleware(name: string): boolean {
        return middlewarePipeline.unregister(name);
    }

    /** List all registered middleware. */
    listMiddleware(): Middleware[] {
        return middlewarePipeline.list();
    }
}

export default OpenAIServer;
