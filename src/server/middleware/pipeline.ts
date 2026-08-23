/**
 * Middleware pipeline for the programmable routing server.
 *
 * The pipeline runs registered middleware in two phases:
 *
 * 1. **Request phase** — `process()` is called on each middleware (in
 *    registration order) whose `match()` returned true.  The first
 *    middleware to return a `ShortCircuitResult` wins; subsequent
 *    middleware is skipped and the short-circuit body is sent directly
 *    to the client.
 *
 * 2. **Response phase** — `transform()` is called on each middleware
 *    in **reverse** registration order, only if the request was
 *    forwarded to the backend (not short-circuited).
 */

import type {
    Middleware,
    MiddlewareContext,
    MiddlewareResult,
} from './types.ts';
import type { ChatCompletionResponse } from '../types.ts';

// ---------------------------------------------------------------------------
// Pipeline class
// ---------------------------------------------------------------------------

export class MiddlewarePipeline {
    private readonly middlewares: Middleware[] = [];

    /** Register a middleware.  Appended to the end of the pipeline. */
    register(middleware: Middleware): void {
        if (this.middlewares.some((m) => m.name === middleware.name)) {
            throw new Error(`Middleware "${middleware.name}" is already registered`);
        }
        this.middlewares.push(middleware);
    }

    /** Remove a middleware by name.  Returns true if it was found. */
    unregister(name: string): boolean {
        const idx = this.middlewares.findIndex((m) => m.name === name);
        if (idx === -1) return false;
        this.middlewares.splice(idx, 1);
        return true;
    }

    /** Return a shallow copy of all registered middleware. */
    list(): Middleware[] {
        return [...this.middlewares];
    }

    /** Get a middleware by name, or undefined. */
    get(name: string): Middleware | undefined {
        return this.middlewares.find((m) => m.name === name);
    }

    /**
     * Run the request phase.  Returns the first `ShortCircuitResult`
     * (if any middleware short-circuited) or the last `ForwardResult`.
     *
     * If no middleware activates, returns a default `ForwardResult`
     * containing the original request body.
     */
    async process(ctx: MiddlewareContext): Promise<MiddlewareResult> {
        let currentRequest = ctx.body;

        for (const mw of this.middlewares) {
            // Skip if match() returns false (or is absent → always match)
            if (mw.match && !mw.match(ctx)) continue;
            if (!mw.process) continue;

            // Update context with the (possibly modified) request
            const localCtx: MiddlewareContext = {
                ...ctx,
                body: currentRequest,
            };

            const result = await mw.process(localCtx);

            if (result.type === 'short-circuit') {
                return result;
            }

            // ForwardResult — update the running request and continue
            currentRequest = result.request;
        }

        // No middleware short-circuited — forward the (possibly modified) request
        if (!currentRequest) {
            throw new Error('Pipeline produced no request to forward');
        }

        return { type: 'forward', request: currentRequest };
    }

    /**
     * Run the response phase.  Each middleware's `transform()` is
     * called in reverse registration order.
     */
    async transform(
        ctx: MiddlewareContext,
        response: ChatCompletionResponse,
    ): Promise<ChatCompletionResponse> {
        let current = response;

        for (let i = this.middlewares.length - 1; i >= 0; i--) {
            const mw = this.middlewares[i];
            if (!mw.transform) continue;
            if (mw.match && !mw.match(ctx)) continue;
            current = await mw.transform(ctx, current);
        }

        return current;
    }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const middlewarePipeline = new MiddlewarePipeline();
export default middlewarePipeline;
