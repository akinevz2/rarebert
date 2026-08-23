/**
 * Core type definitions for the OpenAI-compatible programmable routing
 * middleware server.
 *
 * All server-side TypeScript types live here.  Middleware-specific types
 * are in `middleware/types.ts` and re-exported for convenience.
 */

// ---------------------------------------------------------------------------
// Server configuration
// ---------------------------------------------------------------------------

/** Configuration accepted by {@link OpenAIServer}'s constructor. */
export interface ServerConfig {
    /** TCP port to listen on. */
    port: number;
    /**
     * Backend baseURL to forward requests to.  Must include the API
     * prefix (e.g. `http://localhost:11434/v1`).
     */
    baseURL: string;
    /** Optional override for the SQLite database path. */
    dbPath?: string;
    /** Optional idle timeout in ms before triggering introspection. */
    idleTimeoutMs?: number;
}

/** Partial config — every field is optional; defaults are applied. */
export type PartialServerConfig = Partial<ServerConfig>;

// ---------------------------------------------------------------------------
// OpenAI API types (subset relevant to forwarding + short-circuiting)
// ---------------------------------------------------------------------------

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_call_id?: string;
}

export interface ChatCompletionRequest {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
    tools?: unknown[];
    [key: string]: unknown;
}

export interface ChatCompletionResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: ChatMessage;
        finish_reason: string;
    }>;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

export interface ModelListResponse {
    object: string;
    data: Array<{
        id: string;
        object: string;
        created: number;
        owned_by: string;
    }>;
}

// ---------------------------------------------------------------------------
// Bash-command classification + tokenisation
// ---------------------------------------------------------------------------

/**
 * Binary classification result for a single message.
 *
 * `isBashCommand` — the model determined the message is a direct request
 * to execute a bash command.
 */
export interface ClassificationResult {
    /** Original message content that was classified. */
    message: string;
    /** True if the model classified this as a direct bash command request. */
    isBashCommand: boolean;
    /** Model's raw classification response (for debugging / audit). */
    rawResponse: string;
    /** Timestamp of classification. */
    classifiedAt: number;
}

/**
 * A tokenised bash-command pattern stored in the database and KV cache.
 *
 * The `tokens` array is a normalised representation of the command
 * (e.g. `["ls", "-la"]`) used for prefix matching against future
 * messages.  `pattern` is the original canonical form.
 */
export interface BashCommandPattern {
    /** Unique id (auto-incremented by SQLite). */
    id?: number;
    /** Canonical command string, e.g. `ls -la`. */
    pattern: string;
    /** Normalised token array, e.g. `["ls", "-la"]`. */
    tokens: string[];
    /** The original user message that produced this pattern. */
    sourceMessage: string;
    /** Timestamp the pattern was recorded. */
    createdAt: number;
}

// ---------------------------------------------------------------------------
// Server handle (returned by OpenAIServer.start())
// ---------------------------------------------------------------------------

/**
 * Handle returned by {@link OpenAIServer.start}.
 *
 * `stopped` resolves with an exit code (0 = clean, non-zero = error)
 * when the server finishes listening.  Call `close()` to initiate a
 * graceful shutdown.
 */
export interface ServerHandle {
    /** Resolves with the exit code once the server has stopped. */
    stopped: Promise<number>;
    /** Gracefully close the server. */
    close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Re-export middleware types for single-import convenience
// ---------------------------------------------------------------------------

export type {
    Middleware,
    MiddlewareContext,
    MiddlewareResult,
    ShortCircuitResult,
    ForwardResult,
} from './middleware/types.ts';
