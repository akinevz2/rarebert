/**
 * Bash-command short-circuit middleware.
 *
 * This is the first concrete middleware in the programmable routing
 * pipeline.  It implements two related behaviours:
 *
 * 1. **Short-circuit** — When an incoming chat-completion message
 *    matches a known tokenised bash-command pattern (stored in the
 *    database + KV cache), the command is executed locally and the
 *    result is returned directly to the client as a wrapped assistant
 *    message.  The request never reaches the backend.
 *
 * 2. **Introspection** — During idle moments (no pending requests),
 *    previous conversation messages are sent to the model for binary
 *    classification: "is this a direct bash command request?"  If yes,
 *    the command is tokenised and stored as a pattern for future
 *    matching.
 *
 * Security: a strict allowlist of commands is enforced.  Only commands
 * in {@link ALLOWED_COMMANDS} may be executed.  This list is intentionally
 * small and read-only to start with.
 */

import { spawn } from 'node:child_process';
import type {
    Middleware,
    MiddlewareContext,
    MiddlewareResult,
    ShortCircuitResult,
} from './types.ts';
import type {
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatMessage,
    ClassificationResult,
    BashCommandPattern,
} from '../types.ts';
import { database } from '../database.ts';
import { kvCache, KVCache } from '../kv.ts';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Commands that are allowed to be short-circuited.
 * Start conservative — read-only, non-destructive commands only.
 */
const ALLOWED_COMMANDS = new Set([
    'ls',
    'pwd',
    'cat',
    'echo',
    'grep',
    'head',
    'tail',
    'wc',
    'find',
    'which',
    'whoami',
    'date',
    'uname',
    'df',
    'du',
    'env',
    'git',
    'node',
    'npm',
    'npx',
    'tsc',
]);

/** Maximum execution time for a short-circuited command (ms). */
const COMMAND_TIMEOUT_MS = 10_000;

/** KV cache key prefix for bash patterns. */
const PATTERN_KEY_PREFIX = 'bash-pattern:';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the last user message from a chat-completion request.
 * Returns null if there are no user messages.
 */
function lastUserMessage(messages: ChatMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') return messages[i].content;
    }
    return null;
}

/**
 * Tokenise a user message into a potential command + args.
 * Strips leading whitespace and common conversational prefixes.
 * Returns null if the message doesn't look like a command.
 */
function tokeniseCommand(message: string): string[] | null {
    const trimmed = message.trim();

    // Strip common conversational prefixes
    const stripped = trimmed
        .replace(/^(please\s+)?(run|execute|do)\s+/i, '')
        .replace(/^(can\s+you\s+)?(run|execute)\s+/i, '')
        .replace(/^`/, '')
        .replace(/`$/, '')
        .trim();

    if (!stripped) return null;

    // Reject multi-line messages (likely not a simple command)
    if (stripped.includes('\n')) return null;

    // Split on whitespace
    const tokens = stripped.split(/\s+/);
    if (tokens.length === 0) return null;

    // First token must be an allowed command
    if (!ALLOWED_COMMANDS.has(tokens[0])) return null;

    return tokens;
}

/**
 * Execute a command locally and return its stdout/stderr.
 * Rejects if the command times out or exits non-zero.
 */
function executeCommand(
    tokens: string[],
    cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
        const [cmd, ...args] = tokens;
        const child = spawn(cmd, args, {
            cwd,
            timeout: COMMAND_TIMEOUT_MS,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (d) => (stdout += d.toString()));
        child.stderr.on('data', (d) => (stderr += d.toString()));

        child.on('error', reject);

        child.on('close', (code) => {
            resolve({ stdout, stderr, code: code ?? 0 });
        });
    });
}

/**
 * Build a synthetic ChatCompletionResponse wrapping a command result
 * as an assistant message.
 */
function buildCommandResponse(
    pattern: BashCommandPattern,
    result: { stdout: string; stderr: string; code: number },
): ChatCompletionResponse {
    const output = result.stdout.trim() || result.stderr.trim() || '(no output)';
    const content =
        result.code === 0
            ? `$ ${pattern.pattern}\n${output}`
            : `$ ${pattern.pattern}\n(exit code ${result.code})\n${result.stderr.trim() || output}`;

    return {
        id: `cmd_${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'rarebert-bash-shortcircuit',
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content,
                },
                finish_reason: 'stop',
            },
        ],
        usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        },
    };
}

// ---------------------------------------------------------------------------
// Middleware class
// ---------------------------------------------------------------------------

export class BashShortCircuitMiddleware implements Middleware {
    readonly name = 'bash-shortcircuit';

    /** Working directory for command execution (defaults to cwd). */
    private cwd: string;

    /** Base URL of the backend (for introspection classification calls). */
    private baseURL: string;

    /** Model to use for introspection classification. */
    private introspectModel: string;

    /** Typed KV cache for BashCommandPattern objects. */
    private patternCache: KVCache<BashCommandPattern>;

    constructor(opts: {
        cwd?: string;
        baseURL: string;
        introspectModel?: string;
    }) {
        this.cwd = opts.cwd ?? process.cwd();
        this.baseURL = opts.baseURL;
        this.introspectModel = opts.introspectModel ?? 'glm-4.7-flash:q8_0';
        this.patternCache = new KVCache<BashCommandPattern>(500);
    }

    // ---- match ------------------------------------------------------------

    /**
     * Activate only for POST /v1/chat/completions requests that have
     * a body with messages.
     */
    match(ctx: MiddlewareContext): boolean {
        return (
            ctx.method === 'POST' &&
            ctx.path === '/v1/chat/completions' &&
            ctx.body !== null &&
            Array.isArray(ctx.body.messages) &&
            ctx.body.messages.length > 0
        );
    }

    // ---- process ----------------------------------------------------------

    /**
     * Check if the last user message matches a known bash-command
     * pattern.  If so, execute the command and short-circuit.
     */
    async process(ctx: MiddlewareContext): Promise<MiddlewareResult> {
        if (!ctx.body) return { type: 'forward', request: ctx.body! };

        const userMsg = lastUserMessage(ctx.body.messages);
        if (!userMsg) return { type: 'forward', request: ctx.body };

        const tokens = tokeniseCommand(userMsg);
        if (!tokens) return { type: 'forward', request: ctx.body };

        // Check KV cache first (hot path)
        const cacheKey = PATTERN_KEY_PREFIX + tokens.join(' ');
        const cachedPattern = this.patternCache.get(cacheKey);

        let pattern: BashCommandPattern | null = cachedPattern;

        // Fall back to database prefix matching
        if (!pattern) {
            const dbMatches = database.matchPatterns(tokens);
            if (dbMatches.length > 0) {
                pattern = dbMatches[0];
                // Warm the KV cache
                this.patternCache.set(cacheKey, pattern, 60_000);
            }
        }

        if (!pattern) {
            // No known pattern — but the message looks like an allowed command.
            // Store it as a new pattern for future matching.
            pattern = {
                pattern: tokens.join(' '),
                tokens,
                sourceMessage: userMsg,
                createdAt: Date.now(),
            };
            database.savePattern(pattern);
            this.patternCache.set(cacheKey, pattern, 60_000);

            // Still forward to backend — we only short-circuit known patterns
            // that have been introspected.  This is a conservative default.
            return { type: 'forward', request: ctx.body };
        }

        // We have a known pattern — execute the command
        try {
            const result = await executeCommand(tokens, this.cwd);
            const response = buildCommandResponse(pattern, result);

            const shortCircuit: ShortCircuitResult = {
                type: 'short-circuit',
                status: 200,
                body: response,
                contextMessages: [
                    {
                        role: 'assistant',
                        content: response.choices[0].message.content,
                    },
                ],
            };
            return shortCircuit;
        } catch (err) {
            // Command failed — forward to backend as fallback
            console.error(
                `[bash-shortcircuit] command execution failed: ${(err as Error).message}`,
            );
            return { type: 'forward', request: ctx.body };
        }
    }

    // ---- introspection ----------------------------------------------------

    /**
     * Run introspection analysis on a set of conversation messages.
     *
     * For each message, asks the backend model to classify whether it
     * is a direct bash command request.  If yes, tokenises and stores
     * the pattern.
     *
     * This is called by the server during idle moments.
     */
    async introspect(messages: ChatMessage[]): Promise<void> {
        const userMessages = messages.filter((m) => m.role === 'user');

        for (const msg of userMessages) {
            // Skip messages we've already classified
            const existing = kvCache.get(`classified:${msg.content}`);
            if (existing) continue;

            const tokens = tokeniseCommand(msg.content);
            if (!tokens) continue; // Not a command-like message

            // Ask the model to classify
            const classification = await this.classifyMessage(msg.content);

            database.saveClassification(classification);
            kvCache.set(`classified:${msg.content}`, '1', 300_000);

            if (classification.isBashCommand) {
                const pattern: BashCommandPattern = {
                    pattern: tokens.join(' '),
                    tokens,
                    sourceMessage: msg.content,
                    createdAt: Date.now(),
                };
                database.savePattern(pattern);
                this.patternCache.set(
                    PATTERN_KEY_PREFIX + pattern.pattern,
                    pattern,
                    60_000,
                );
                console.log(
                    `[bash-shortcircuit] learned pattern: ${pattern.pattern}`,
                );
            }
        }
    }

    /**
     * Send a classification request to the backend model.
     * Returns a binary result: is this a direct bash command request?
     */
    private async classifyMessage(message: string): Promise<ClassificationResult> {
        const prompt = `You are a binary classifier. Determine whether the following user message is a direct request to execute a bash command.

Respond with exactly one word: "YES" or "NO".

A message is a direct bash command request if:
- It asks to run, execute, or perform a shell command
- It contains a command-like string (e.g. "ls -la", "git status")
- It is a simple instruction to run something in the terminal

A message is NOT a direct bash command request if:
- It asks a general question
- It requests code to be written or explained
- It is conversational or explanatory

User message: "${message}"

Classification:`;

        try {
            const response = await fetch(`${this.baseURL}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.introspectModel,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0,
                    max_tokens: 5,
                }),
            });

            if (!response.ok) {
                return {
                    message,
                    isBashCommand: false,
                    rawResponse: `HTTP ${response.status}`,
                    classifiedAt: Date.now(),
                };
            }

            const data = (await response.json()) as ChatCompletionResponse;
            const rawResponse =
                data.choices[0]?.message?.content?.trim() ?? '';

            const isBashCommand = /^yes/i.test(rawResponse);

            return {
                message,
                isBashCommand,
                rawResponse,
                classifiedAt: Date.now(),
            };
        } catch (err) {
            console.error(
                `[bash-shortcircuit] classification request failed: ${(err as Error).message}`,
            );
            return {
                message,
                isBashCommand: false,
                rawResponse: `error: ${(err as Error).message}`,
                classifiedAt: Date.now(),
            };
        }
    }
}
