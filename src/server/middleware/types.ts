/**
 * Middleware type definitions for the programmable routing pipeline.
 *
 * A middleware participates in two phases:
 *
 * 1. **Request phase** — `match()` decides whether to activate, then
 *    `process()` either short-circuits (returns a direct response) or
 *    returns a (possibly modified) request for forwarding.
 *
 * 2. **Response phase** — `transform()` may modify the backend response
 *    before it is sent to the client.
 */

import type {
    ChatCompletionRequest,
    ChatCompletionResponse,
} from '../types.ts';

// ---------------------------------------------------------------------------
// Middleware result discriminated union
// ---------------------------------------------------------------------------

/**
 * Returned by {@link Middleware.process} when the middleware wants to
 * short-circuit the pipeline and return a direct response to the client
 * without forwarding to the backend.
 */
export interface ShortCircuitResult {
    type: 'short-circuit';
    /** HTTP status code to send (default 200). */
    status?: number;
    /** JSON body to send as the response. */
    body: unknown;
    /**
     * Optional messages to append to the conversation context so the
     * model sees what happened (e.g. a wrapped user message indicating
     * the command was executed and its results).
     */
    contextMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/**
 * Returned by {@link Middleware.process} when the request should be
 * forwarded to the backend (optionally after modification).
 */
export interface ForwardResult {
    type: 'forward';
    /** The (possibly modified) request body to forward. */
    request: ChatCompletionRequest;
}

/** Union of all possible middleware process outcomes. */
export type MiddlewareResult = ShortCircuitResult | ForwardResult;

// ---------------------------------------------------------------------------
// Middleware context
// ---------------------------------------------------------------------------

/**
 * Context passed to every middleware invocation.  Provides access to
 * the parsed request, the server's shared services, and metadata.
 */
export interface MiddlewareContext {
    /** The incoming HTTP request path (e.g. `/v1/chat/completions`). */
    path: string;
    /** The HTTP method (GET, POST, …). */
    method: string;
    /** Parsed request body (for POST endpoints with JSON). */
    body: ChatCompletionRequest | null;
    /** Raw request headers. */
    headers: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Middleware interface
// ---------------------------------------------------------------------------

/**
 * A pluggable middleware in the routing pipeline.
 *
 * Implementations may override any combination of `match`, `process`,
 * and `transform`.  A middleware that only implements `transform` acts
 * as a response post-processor; one that implements `match` + `process`
 * can short-circuit requests.
 */
export interface Middleware {
    /** Unique name for registration / deregistration. */
    name: string;

    /**
     * Decide whether this middleware should activate for the given
     * context.  If omitted, the middleware activates for every request.
     */
    match?(ctx: MiddlewareContext): boolean;

    /**
     * Process the request.  Return a {@link ShortCircuitResult} to
     * respond directly, or a {@link ForwardResult} to continue the
     * pipeline (optionally with a modified request).
     *
     * Only called when `match()` returned true (or is absent).
     */
    process?(ctx: MiddlewareContext): Promise<MiddlewareResult>;

    /**
     * Transform the backend response before it is sent to the client.
     * Called in reverse registration order.
     */
    transform?(
        ctx: MiddlewareContext,
        response: ChatCompletionResponse,
    ): Promise<ChatCompletionResponse>;
}
