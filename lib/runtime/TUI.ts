import { ExitSignal, AbortError, exit, EXIT_FAIL, EXIT_OK } from './core.ts';
import { isInteractive, nonInteractive } from './Module.ts';
import { CLI } from './CLI.ts';
import type { ModuleMeta, MainCallback } from './CLI.ts';
import { CLEAR_SCREEN } from '../supports/symbols.ts';

// ---------------------------------------------------------------------------
// TUI — a CLI subclass for full-screen interactive (Enquirer-heavy)
// interfaces. TUI inherits all of CLI's behavior (Commander arg parsing,
// terminal helpers, signal handling) and overrides execute() to clear
// the screen after the run. main always receives (Arguments, positional)
// just like CLI.
//
// Enquirer is lazily imported at runtime — loaded only when a TUI member
// method actually constructs a prompt, keeping it off every module's
// startup path.
// ---------------------------------------------------------------------------

export class TUI<M extends ModuleMeta = ModuleMeta> extends CLI<M> {
    clearScreen: boolean;

    constructor(file: string, main?: MainCallback<M>, meta?: M) {
        super(file, main, meta);
        this.clearScreen = !!meta?.clearScreen; // default false
    }

    clear() {
        if (this.isInteractive() && this.clearScreen) {
            process.stdout.write(CLEAR_SCREEN);
        }
    }

    /**
     * Run the TUI module. Delegates to CLI's execute (which parses argv
     * via Commander and invokes the wrapped main), then clears the screen
     * so the next shell line doesn't clash with TUI output.
     */
    async execute(args: string[] = []) {
        // --help is not interactive: let Commander intercept it before the
        // interactive gate bails, so TUI modules answer --help in
        // non-interactive environments too.
        if (this.wantsHelp(args)) {
            return super.execute(args);
        }
        const run = this.runInteractively(() => super.execute(args), {
            message: `tui: ${this.path} requires an interactive terminal (stdin is not a TTY).`
        });
        const result = await run();
        this.clear();
        return result;
    }

    /**
     * Lazily import the enquirer library at runtime — Enquirer therefore
     * loads only when a prompt is actually constructed.
     */
    async createInterface() {
        const { default: Enquirer } = await import('enquirer');
        return Enquirer;
    }

    async confirm(message: string, initial = false) {
        const run = this.runInteractively(
            async () => {
                const Enquirer = await this.createInterface();
                const prompt = new Enquirer.Confirm({ name: 'confirm', message, initial });
                try {
                    return await prompt.run();
                } catch {
                    throw new AbortError();
                }
            },
            { fallback: async () => initial }
        );
        return run();
    }

    async input(message: string, options: {
        initial?: string;
        validate?: ((value: string) => boolean | string) | null;
        nonInteractiveBehavior?: 'fail' | 'default';
    } = {}) {
        const { initial = '', validate = null, nonInteractiveBehavior = 'fail' } = options;
        const run = this.runInteractively(
            async () => {
                const Enquirer = await this.createInterface();
                const prompt = new Enquirer.Input({
                    name: 'input',
                    message,
                    initial,
                    validate: validate ?? undefined
                });
                try {
                    const result = await prompt.run();
                    return result?.trim() || initial;
                } catch {
                    throw new AbortError();
                }
            },
            {
                message: 'cannot prompt for input.',
                // 'fail' (default) → bail with a nonInteractive ExitSignal through
                // the exit() machinery; 'default' → bail with the initial value.
                fallback: nonInteractiveBehavior === 'fail' ? null : async () => initial
            }
        );
        return run();
    }

    async select(message: string, choices: (string | { name: string; message?: string })[], options: {
        initial?: number;
        limit?: number;
        nonInteractiveBehavior?: 'fail' | 'default';
    } = {}) {
        const { initial = 0, limit = 10, nonInteractiveBehavior = 'fail' } = options;
        const run = this.runInteractively(
            async () => {
                const Enquirer = await this.createInterface();
                const prompt = new Enquirer.Select({
                    name: 'select',
                    message,
                    choices,
                    initial,
                    limit
                });
                try {
                    return await prompt.run();
                } catch {
                    throw new AbortError();
                }
            },
            {
                message: 'cannot prompt for selection.',
                fallback:
                    nonInteractiveBehavior === 'fail'
                        ? null
                        : async () => {
                            const choice = choices[initial];
                            return typeof choice === 'string' ? choice : choice.name;
                        }
            }
        );
        return run();
    }
}

// ---------------------------------------------------------------------------
// Interface — composes UX flows as sequences of TUI -> TUI stages.
//
// Where a Module wraps a single main callback, an Interface wraps a chain
// of stages run through the exit() machinery. Each stage is either a TUI
// instance (run via its execute()) or a step function `(ctx, prev)`; a
// stage's result decides continuation — dispatched entirely by exit()'s
// argument kind (function-level polymorphism, no duck typing):
//   - exit(0)        → ADVANCE to the next stage
//   - exit("string") → TERMINATE the flow; the string is the explanation,
//     printed by the signal's onExit during complete(); the flow's code
//     is the string kind's code (EXIT_FAIL)
//   - exit(n) / n≠0  → TERMINATE the flow with code n
//   - any other value (function stages) → ADVANCE, passed to the next
//     stage as `prev`
//
// Flow-as-main: a TUI/CLI main callback may simply `return exit(flow)` —
// exit()'s kind dispatch wraps the flow as an ExitSignal submodule, and
// the Runtime drives the whole chain through complete(). No duck typing
// at the callsite; the same one-line pattern as every other result kind.
//
// CLI-runtime guard: constructing an Interface from a CLI runtime (stdin
// not a TTY) returns exit() — a nonInteractive ExitSignal — instead of an
// instance. A returned object replaces `this` in a JS constructor, so a
// main can uniformly `return exit(Interface.createInterface(...))` and
// the Runtime bails through the standard machinery without ever building
// the flow.
// ---------------------------------------------------------------------------

export class Interface {
    name!: string;
    path!: string;
    tui!: TUI;
    stages!: any[];

    constructor(name: string, { tui = null, stages = [] }: { tui?: TUI | null; stages?: any[] } = {}) {
        // CLI-runtime guard: a returned object replaces the constructed
        // instance, so callers uniformly `return` the result.
        if (!isInteractive()) {
            return nonInteractive(
                `cannot construct interface "${name}" — an interactive (TUI) runtime is required.`
            ) as unknown as Interface;
        }
        this.name = name;
        this.path = name;
        this.tui = (tui || new TUI(`${name}.interface`)) as TUI;
        this.stages = [...stages];
    }

    /** Append a stage (TUI instance or `(ctx, prev)` step) — fluent. */
    stage(step: any): this {
        this.stages.push(step);
        return this;
    }

    /**
     * Run the stage chain. Returns the flow's exit code: 0 when every
     * stage advanced (each returning exit(0)), or the terminating stage's
     * code — including the string kind's EXIT_FAIL when a stage returns
     * exit("explanation"). Because execute() is Module-shaped,
     * ExitSignal's submodule kind runs the whole flow — a main callback
     * simply `return exit(flow)`.
     */
    async execute(args: any[] = []): Promise<number> {
        let prev: unknown;
        for (const step of this.stages) {
            const result =
                typeof step === 'function'
                    ? await step({ tui: this.tui, args, prev })
                    : await step.execute(args);

            if (result instanceof ExitSignal) {
                const code = await result.complete();
                if (code !== 0) return code;
                prev = undefined;
            } else if (typeof result === 'number') {
                if (result !== 0) return result;
                prev = undefined;
            } else {
                prev = result;
            }
        }
        return 0;
    }

    // ------------------------------------------------------------------
    // Prompt factories — parametrisable confirm/input/select/query creators.
    //
    // Each returns a submodule-level TUI runnable: a thenable object with
    // execute(args) that resolves to the prompt's value — or bails with a
    // nonInteractive ExitSignal through the runInteractively machinery.
    // Runnables dual-dispatch:
    //   - "return value" — await iface.select(...)  → the choice
    //   - "return exit"  — exit(iface.select(...))  → ExitSignal's
    //     submodule kind runs the runnable and folds the result to an
    //     exit code
    // and they drop straight into stage() chains as TUI-shaped stages.
    //
    // Effectful steps that produce no value (logging, spawning, ...) are
    // plain function stages — `flow.stage(() => console.log('hi'))` —
    // which never touch the interactive gate. There is deliberately no
    // print() factory for that.
    // ------------------------------------------------------------------

    /**
     * Wrap `run` in a submodule-level runnable gated by the Interface's
     * own TUI instance — same non-interactive bail/fallback semantics as
     * every other prompt path.
     */
    _runnable(
        run: () => unknown,
        { message = 'interactive input required', fallback = null }: { message?: string; fallback?: (() => unknown) | null } = {}
    ) {
        const tui = this.tui;
        const runnable = {
            tui,
            async execute() {
                const gate = tui.runInteractively(run, { message, fallback });
                return await gate();
            },
            then(onFulfilled?: (value: unknown) => unknown, onRejected?: (err: unknown) => unknown) {
                return runnable.execute().then(onFulfilled, onRejected);
            }
        };
        return runnable;
    }

    confirm(message: string, initial = false) {
        return this._runnable(() => this.tui.confirm(message, initial), {
            fallback: async () => initial
        });
    }

    input(message: string, options: Record<string, unknown> = {}) {
        const nonInteractiveBehavior = options.nonInteractiveBehavior ?? 'fail';
        return this._runnable(() => this.tui.input(message, options as any), {
            message: 'cannot prompt for input.',
            fallback: nonInteractiveBehavior === 'fail' ? null : async () => options.initial ?? ''
        });
    }

    select(message: string, choices: any[], options: Record<string, unknown> = {}) {
        const nonInteractiveBehavior = options.nonInteractiveBehavior ?? 'fail';
        return this._runnable(() => this.tui.select(message, choices, options as any), {
            message: 'cannot prompt for selection.',
            fallback:
                nonInteractiveBehavior === 'fail'
                    ? null
                    : async () => {
                        const choice = choices[(options.initial as number) ?? 0];
                        return typeof choice === 'string' ? choice : choice.name;
                    }
        });
    }

    /**
     * Escape hatch for bespoke Enquirer prompts (AutoComplete, MultiSelect,
     * keypress handlers, ...): parametrise the prompt class, its full
     * options object, and an optional setup(prompt) callback for wiring
     * handlers before run(). Resolves to the raw Enquirer result.
     */
    query(promptType: string, options: Record<string, unknown> = {}, setup: ((prompt: any) => void) | null = null) {
        return this._runnable(async () => {
            const Enquirer = await this.tui.createInterface();
            const PromptClass = (Enquirer as unknown as Record<string, new (opts: Record<string, unknown>) => { run(): Promise<unknown> }>)[
                promptType
            ];
            if (!PromptClass) {
                throw new Error(`Unknown prompt type: ${promptType}`);
            }
            const prompt = new PromptClass(options);
            if (typeof setup === 'function') setup(prompt);
            try {
                return await prompt.run();
            } catch {
                throw new AbortError();
            }
        });
    }

    /**
     * The single entry point for call sites: build an Interface with the
     * print/prompt/query factories attached. In a CLI runtime the
     * constructor returns exit() — callers uniformly `return` it.
     */
    static createInterface(name = 'interface', options = {}): Interface {
        return new Interface(name, options as any);
    }
}

/**
 * Construct-signature merge for `Interface`.
 *
 * The constructor's CLI-runtime guard returns an `ExitSignal` instead of
 * an instance (a returned object replaces `this` in a JS constructor).
 * This merge widens the construct signature so the union is visible to
 * the type checker: `new Interface(...)` is `Interface | ExitSignal`, and
 * callers narrow with `instanceof ExitSignal` before touching the flow's
 * members.
 */
export interface Interface {
    new (name: string, options?: { tui?: TUI | null; stages?: any[] }): Interface | ExitSignal;
}
