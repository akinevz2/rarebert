import { z } from 'zod';
import {
    ExitSignal,
    AbortError,
    exit,
    EXIT_FAIL,
    EXIT_OK
} from './core.ts';
import { Module } from './Module.ts';

// ---------------------------------------------------------------------------
// CLI — a Module with zod-backed argv parsing and terminal I/O helpers.
//
// Formerly Commander-driven; since the typed-arguments milestone the real
// parse engine is local: each module's ModuleMeta (OptionSpec[]/ArgSpec[])
// is resolved into a zod object schema and a small tokenizer that mirrors
// the Commander semantics this codebase relies on:
//
//   - `--flag value` / `--flag=value`, short flags `-m value` / `-mvalue`,
//     boolean short clusters (`-vy`), kebab→camelCase keys
//     (`--skip-integrity` → `skipIntegrity`)
//   - `--no-x` negation: Commander negation semantics — `opts.x` defaults
//     to `true` and `--no-x` sets it `false`
//   - inline value labels (`--trace <name>`, `-m, --model <id>`) → string;
//     `type: 'int'/'float'` → number; `'array'` → comma-split/repeatable
//     string[]; `choices` → string (validated)
//   - `--` terminator: everything after is positional
//   - `allowUnknownOption`: unknown tokens pass through to `positional`
//     VERBATIM (unparsed flag + any following value tokens stay raw) — this
//     is the contract memo.ts's raw-argv ACTIONS dispatch relies on
//   - unknown options without `allowUnknownOption` reject with Commander's
//     `error: unknown option '--x'` message shape; missing values error
//     `error: option '<display>' argument missing`; missing required
//     positional args error `error: missing required argument '<name>'`
//
// main callbacks receive an assured Arguments instance — an Array subclass
// of the positional args with the parsed opts merged — so legacy
// `main(opts, positional)` property access (`args.debug`) keeps working,
// and (with the `Args<typeof meta>` annotation) the same access is
// compile-time checked against the meta's own declared options.
// ---------------------------------------------------------------------------

export class Arguments extends Array<any> {
    /**
     * Build an Arguments from a parsed invocation. Named `fromInvocation`
     * (not a static `from` override): overriding `Array.from`'s signature
     * breaks the class's static side under tsc.
     */
    static fromInvocation(parsed: ParsedInvocation, positional: string[] = []): Arguments {
        // The spread constructor on the subclass — honours the iterable /
        // length contract and keeps the instance an `Arguments` (Array.from
        // would widen the result to a plain array).
        const inst = new Arguments(...(Array.isArray(positional) ? positional : []));
        (inst as any).parsed = parsed;
        for (const [key, value] of Object.entries(parsed.opts)) {
            (inst as any)[key] = value;
        }
        return inst;
    }

    /** Parsed option values (the schema-validated record). */
    get opts(): Record<string, unknown> {
        return (this as any).parsed.opts;
    }

    /** The parsed invocation state (opts record + rawArgs + helpText). */
    get parsedState(): ParsedInvocation {
        return (this as any).parsed;
    }

    /** Raw-argv presence check for a flag token (works for undeclared flags). */
    has(flag: string): boolean {
        return (this as any).parsed?.rawArgs?.includes(flag) ?? false;
    }

    /** This module's rendered help text. */
    help(): string {
        return (this as any).parsed?.helpText ?? '';
    }
}

/** Process exit codes shared by every module. */
export type ExitCode = number;

/** Declared flag; the zod engine owns parsing. `type` selects the value parser. */
export interface OptionSpec {
    /** Long flag name without dashes, e.g. `debug` → `--debug`. */
    flag?: string;
    /** Value label, e.g. `<file>` — appended to the flag when present. */
    label?: string;
    alias?: string;
    description?: string;
    type?: 'int' | 'float' | 'array' | string;
    /** Allowed values when `type` is `'choices'`-shaped (choices parser). */
    choices?: string[];
    default?: unknown;
}

/** Positional declaration. `required` is enforced by the engine itself. */
export interface ArgSpec {
    name: string;
    required?: boolean;
    description?: string;
}

/** Declarative module metadata; rendered into `--help`. */
export interface ModuleMeta {
    name: string;
    description: string;
    usage?: string;
    options?: readonly OptionSpec[];
    args?: readonly ArgSpec[];
    /** Suppress the CLI-level --help interception (the args reach parsing). */
    skipHelpIntercept?: boolean;
    allowUnknownOption?: boolean;
    /** TUI only: clear the screen after the module finishes. */
    clearScreen?: boolean;
}

/**
 * Literal-preserving meta declaration. Declare modules with
 *
 *     const meta = defineMeta({ ... });
 *
 * — the generic-const modifier keeps flag string literals (`'--trace <name>'`)
 * narrow so `OptsOf<typeof meta>`/`Args<typeof meta>` derive real keys.
 * (`satisfies ModuleMeta` alone would widen every flag property to `string`
 * and collapse the derived opts object into an index signature.)
 */
export function defineMeta<const M extends ModuleMeta>(meta: M): M {
    return meta;
}

// ---------------------------------------------------------------------------
// Type-level flag-string surgery — the typed-arguments seam.
//
// These mappers derive the compile-time opts object from a module's meta,
// mirroring the runtime key/type resolution in `resolveOption` exactly:
//   StripLabel → LongName(+negation unwrap) → CamelCase key, and the value
//   kind comes from the inline value label / spec.type / spec.choices.
// ---------------------------------------------------------------------------

/** Union→intersection: merges per-spec single-property object types. */
export type UnionToIntersection<U> =
    (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void ? I : never;

/** Strip an inline value label: '--trace <name>' → '--trace'; '-m, --model <id>' → '-m, --model'. */
export type StripLabel<F extends string> =
    F extends `${infer Head} <${string}>` ? StripLabel<Head>
    : F extends `${infer Head} [${string}]` ? StripLabel<Head>
    : F;

/** Reduce a (label-stripped) flag string to its long name: '-m, --model' → 'model'; 'no-memos' keeps the prefix. */
export type LongName<F extends string> =
    F extends `${string}, --${infer Long}` ? Long
    : F extends `--${infer Long}` ? Long
    : F extends `-${infer Rest}` ? Rest
    : F;

/** kebab-case → camelCase at the type level ('skip-integrity' → 'skipIntegrity'). */
export type CamelCase<S extends string> =
    S extends `${infer Head}-${infer Tail}${infer Rest}`
    ? `${Head}${Capitalize<Tail>}${CamelCase<Rest>}`
    : S;

/** Compile-time key for a flag string, mirroring runtime camelCase + `--no-x` negation unwrap. */
export type FlagKey<F extends string> = FlagKeyImpl<StripLabel<F>>;
type FlagKeyImpl<F extends string> = LongName<F> extends infer L extends string
    ? (L extends `no-${infer Negated}` ? CamelCase<Negated> : CamelCase<L>)
    : never;

/** Does the flag string declare an inline value label? */
type HasLabel<F extends string> =
    F extends `${string} <${string}>` ? true
    : F extends `${string} [${string}]` ? true
    : false;

/** Value type for one option spec (negation overrides everything → boolean). */
type FlagValue<Spec extends OptionSpec> =
    Spec extends { flag: infer F extends string }
    ? F extends `--no-${string}` | `${string}, --no-${string}` ? boolean
    : Spec extends { type: 'int' | 'float' } ? number
    : Spec extends { type: 'array' } ? string[]
    : Spec extends { choices: readonly string[] } ? string
    : HasLabel<F> extends true ? string
    : Spec extends { label: string } ? string
    : boolean
    : boolean;

/** One spec → one single-property object (flagless specs contribute nothing). */
export type OneOpt<Spec extends OptionSpec> =
    Spec extends { flag: infer F extends string }
    ? { [K in FlagKey<F>]: FlagValue<Spec> }
    : {};

/**
 * Compile-time opts object for a meta — the same keys/values the zod
 * engine produces at runtime. Declare metas with `defineMeta({...})` —
 * the generic-const modifier keeps flag literals narrow for the mapping.
 */
export type OptsOf<M extends ModuleMeta> =
    NonNullable<M['options']> extends readonly []
    ? {}
    : UnionToIntersection<OneOpt<NonNullable<M['options']>[number]>> extends infer O
    ? [O] extends [never] ? {} : O extends object ? O : {}
    : {};

/** Typed Arguments seam: the Arguments contract ∩ the meta's declared opts. */
export type Args<M extends ModuleMeta = ModuleMeta> = Arguments & OptsOf<M>;

/** Positional type. Always `string[]`: argv tolerates excess arguments, so per-spec tuple claims would be unsound. */
export type Positional<M extends ModuleMeta = ModuleMeta> = string[];

// ---------------------------------------------------------------------------
// Parsed invocation + engine
// ---------------------------------------------------------------------------

/** The full outcome of parsing one module invocation's argv. */
export interface ParsedInvocation {
    /** Parsed option values, keyed by camelCased long name (schema-validated, defaults applied). */
    opts: Record<string, unknown>;
    /** Positional / unparsed tokens (unknown flags included when `allowUnknownOption`). */
    positional: string[];
    /** The argv tokens this invocation saw, verbatim. */
    rawArgs: string[];
    /** This module's rendered help text. */
    helpText: string;
}

/** An invalid-argument complaint carrying the Commander-shaped message. */
class InvalidArgumentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidArgumentError';
    }
}

/** kebab-case → camelCase at runtime ('skip-integrity' → 'skipIntegrity'). */
function camelCase(name: string): string {
    return name.replace(/-([a-zA-Z0-9])/g, (_all, c: string) => c.toUpperCase());
}

interface DecodedFlag {
    short?: string;
    long: string;
    label?: string;
}

/**
 * Decompose a Commander-style flag display string:
 *   '-m, --model <id>' → { short: 'm', long: 'model', label: '<id>' }
 *   '--trace <name>'   → { long: 'trace', label: '<name>' }
 *   '--struct'         → { long: 'struct' }
 *   '-v, --verbose'    → { short: 'v', long: 'verbose' }
 *   '-m'               → { short: 'm', long: 'm' }
 */
function decodeFlag(display: string): DecodedFlag | null {
    const trimmed = display.trim();
    if (!trimmed) return null;
    let label: string | undefined;
    let rest = trimmed;
    const labelMatch = /\s+(<[^>]*>|\[[^\]]*\])$/.exec(rest);
    if (labelMatch) {
        label = labelMatch[1];
        rest = rest.slice(0, labelMatch.index);
    }
    let short: string | undefined;
    let long: string | undefined;
    for (const seg of rest.split(/\s*,\s*/)) {
        const m = /^(-{1,2})([A-Za-z][\w-]*)$/.exec(seg.trim());
        if (!m) return null;
        if (m[1] === '--') long = m[2];
        else {
            if (m[2].length !== 1) return null;
            short = m[2];
        }
    }
    if (!long && !short) return null;
    return { short, long: long ?? short!, label };
}

interface ResolvedOption {
    spec: OptionSpec;
    /** Commander-style display: composite short/long + inline label. */
    display: string;
    short?: string;
    long: string;
    /** camelCased opts key — negation unwraps `no-` (`--no-memos` → `memos`). */
    key: string;
    /** True for `--no-x` specs (Commander negation: default true). */
    negated: boolean;
    /** True when the flag consumes a value. */
    takesValue: boolean;
    schema: z.ZodTypeAny;
}

/** Resolve one OptionSpec to its runtime registry entry (mirrors `FlagKey`/`FlagValue`). */
function resolveOption(rawSpec: OptionSpec, index: number): ResolvedOption | null {
    const display = CLI.flagString(rawSpec);
    const decoded = decodeFlag(display);
    if (!decoded || !decoded.long) return null;
    const long = decoded.long;
    const negated = long.startsWith('no-');
    const key = negated ? camelCase(long.slice(3)) : camelCase(long);
    const kind = rawSpec.type;
    const takesValue =
        !negated && (decoded.label !== undefined || rawSpec.label !== undefined || kind !== undefined);

    // The coercion itself stays with CLI.typeParser (int/float/array/choices
    // semantics + Commander-shaped complaints); zod then validates the shape
    // and applies defaults.
    let schema: z.ZodTypeAny;
    if (negated) schema = z.boolean().default(true);
    else if (kind === 'array') schema = z.array(z.string()).optional();
    else if (kind === 'int' || kind === 'float') schema = z.number().optional();
    else if (rawSpec.choices) schema = z.string().optional();
    else if (takesValue) schema = z.string().optional();
    else schema = z.boolean().optional();
    if (rawSpec.default !== undefined && !negated) schema = schema.default(rawSpec.default as never);

    void index;
    const spec = rawSpec;
    return { spec, display, short: decoded.short, long, key, negated, takesValue, schema };
}

/**
 * Parse one module invocation's argv against its meta. Throws
 * InvalidArgumentError with Commander-shaped messages; converts to
 * ExitSignal-observable failures one layer up (exit(err) kind).
 */
function parseModuleArgvImpl(meta: ModuleMeta, argv: string[]): ParsedInvocation {
    const registry: ResolvedOption[] = [];
    for (const spec of meta.options || []) {
        const resolved = resolveOption(spec, registry.length);
        if (resolved) registry.push(resolved);
    }
    const byLong = new Map(registry.map((r) => [`${r.negated ? '--' : '--'}${r.long}`, r]));
    const byShort = new Map(registry.filter((r) => r.short).map((r) => [r.short!, r]));

    const positional: string[] = [];
    const raw: Record<string, unknown> = {};
    let onlyPositional = false;

    const missingValue = (r: ResolvedOption) =>
        new InvalidArgumentError(`error: option '${r.display}' argument missing`);
    const coerce = (r: ResolvedOption, value: string): unknown => {
        const parser = CLI.typeParser(r.spec);
        try {
            return parser ? parser(value, undefined) : value;
        } catch (err) {
            throw new InvalidArgumentError(
                `error: option '${r.display}' argument invalid. Reason: ${(err as Error).message}`
            );
        }
    };

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];

        if (onlyPositional) {
            positional.push(token);
            continue;
        }
        if (token === '--') {
            onlyPositional = true;
            continue;
        }

        // Long flag: --flag, --flag=value
        if (token.startsWith('--') && token.length > 2) {
            const eq = token.indexOf('=');
            const flagPart = eq === -1 ? token : token.slice(0, eq);
            const eqValue = eq === -1 ? undefined : token.slice(eq + 1);
            const found = byLong.get(flagPart);
            if (found) {
                if (found.takesValue) {
                    const value = eqValue !== undefined ? eqValue : argv[++i];
                    if (value === undefined || (typeof value === 'string' && value.startsWith('-') && value !== '-')) {
                        throw missingValue(found);
                    }
                    raw[found.key] = coerce(found, value);
                } else {
                    if (eqValue !== undefined) {
                        throw new InvalidArgumentError(
                            `error: unknown option '${flagPart}=${eqValue}'`
                        );
                    }
                    raw[found.key] = found.negated ? false : true;
                }
            } else if (meta.allowUnknownOption) {
                positional.push(token);
            } else {
                throw new InvalidArgumentError(`error: unknown option '${flagPart}'`);
            }
            continue;
        }

        // Short flag cluster: -m value, -mvalue, -vy
        if (token.startsWith('-') && token !== '-' && token.length > 1) {
            const chars = token.slice(1);
            for (let c = 0; c < chars.length; c++) {
                const short = chars[c];
                const found = byShort.get(short);
                if (!found) {
                    if (!meta.allowUnknownOption) {
                        throw new InvalidArgumentError(`error: unknown option '-${short}'`);
                    }
                    // Unknown short inside a cluster: keep the whole token raw.
                    positional.push(token);
                    break;
                }
                if (found.takesValue) {
                    let rest = chars.slice(c + 1);
                    if (rest.startsWith('=')) rest = rest.slice(1);
                    if (rest) {
                        raw[found.key] = coerce(found, rest);
                    } else {
                        const value = argv[++i];
                        if (value === undefined || (value.startsWith('-') && value !== '-')) {
                            throw missingValue(found);
                        }
                        raw[found.key] = coerce(found, value);
                    }
                    // cluster ends at the value-taking short
                    break;
                }
                raw[found.key] = found.negated ? false : true;
            }
            // value consumes the rest of the cluster; unknown path pushed raw
            continue;
        }

        positional.push(token);
    }

    // Coercion is done; let the zod schema validate + apply defaults
    // (negation default true, meta defaults).
    const schema = z.object(Object.fromEntries(registry.map((r) => [r.key, r.schema])));
    const result = schema.safeParse(raw);
    if (!result.success) {
        const issue = result.error.issues[0];
        const path = issue?.path?.join('.') ?? '';
        const resolved = registry.find((r) => r.key === path);
        throw new InvalidArgumentError(
            `error: option '${resolved?.display ?? path}' argument invalid. Reason: ${issue?.message ?? 'invalid value'}`
        );
    }
    const opts = result.data as Record<string, unknown>;

    // Required positional enforcement (engine-side; Commander used to own it).
    const specs = meta.args || [];
    let requiredSeen = 0;
    for (const spec of specs) if (spec.required) requiredSeen++;
    if (requiredSeen > positional.length) {
        const missing = specs.map((s) => s.required).lastIndexOf(true);
        throw new InvalidArgumentError(
            `error: missing required argument '${specs[missing]?.name ?? specs[requiredSeen - 1]?.name}'`
        );
    }

    return { opts, positional, rawArgs: argv, helpText: CLI.renderHelp(meta) };
}

// ---------------------------------------------------------------------------
// CLI class
// ---------------------------------------------------------------------------

export class CLI<M extends ModuleMeta = ModuleMeta> extends Module {
    constructor(file: string, main?: MainCallback<M>, meta?: M) {
        super(file, main as any, meta as any);
        this.runner = main ? this.wrap(meta as M, main as MainCallback<M>) : null;
    }

    /**
     * Build the zod parse engine over `meta` and return a runner. The main
     * callback receives (Arguments, positional) where Arguments is the
     * parsed-options-merged positional array and positional is the
     * (unknown-flag-tolerant) positional list.
     */
    wrap(meta: M, main: MainCallback<M>): (args?: string[]) => Promise<unknown> {
        return async (args: string[] = []) => {
            if (!meta.skipHelpIntercept && this.wantsHelp(args)) {
                process.stdout.write(CLI.renderHelp(meta) + '\n');
                return exit(0);
            }

            let parsed: ParsedInvocation;
            try {
                parsed = CLI.parseModuleArgv(meta, args);
            } catch (err) {
                if (err instanceof AbortError) throw err;
                return exit(err as Error);
            }

            try {
                return await main(
                    Arguments.fromInvocation(parsed, parsed.positional) as Args<M>,
                    parsed.positional
                );
            } catch (err) {
                if (err instanceof AbortError) throw err;
                return exit(err as Error);
            }
        };
    }

    /** Check if args contain a help flag. */
    wantsHelp(args: string[] = []): boolean {
        return args.includes('--help') || args.includes('-h');
    }

    /** Parse one invocation's argv against module metadata. */
    static parseModuleArgv<M extends ModuleMeta>(meta: M, argv: string[]): ParsedInvocation {
        return parseModuleArgvImpl(meta, argv);
    }

    /** Normalize an option spec to a Commander-style display string. */
    static flagString(opt: OptionSpec): string {
        let flag = opt.flag || '';
        let label = opt.label || '';
        if (flag && !flag.startsWith('-')) flag = `--${flag}`;
        if (label && label.startsWith('<') && label.endsWith('>')) {
            if (!flag.includes(' ')) flag = `${flag} ${label}`;
        }
        return flag || label;
    }

    /** Build a value parser for an option spec (null = boolean flag). */
    static typeParser(opt: OptionSpec): ((v: string, prev?: any) => unknown) | null {
        if (opt.type === 'int') {
            return (v: string) => {
                const n = parseInt(v, 10);
                if (isNaN(n)) throw new InvalidArgumentError(`Must be an integer`);
                return n;
            };
        }
        if (opt.type === 'float') {
            return (v: string) => {
                const n = parseFloat(v);
                if (isNaN(n)) throw new InvalidArgumentError(`Must be a number`);
                return n;
            };
        }
        if (opt.type === 'array') {
            return (v: string, prev: string[] = []) => {
                return v.includes(',') ? v.split(',').map((s) => s.trim()) : [...prev, v];
            };
        }
        if (opt.choices) {
            const choices = new Set(opt.choices);
            return (v: string) => {
                if (!choices.has(v)) throw new InvalidArgumentError(`Must be one of: ${opt.choices!.join(', ')}`);
                return v;
            };
        }
        const flagStr = CLI.flagString(opt);
        if (/\s<[^>]+>/.test(flagStr) || /\s\[[^\]]+\]/.test(flagStr)) {
            return (v: string) => v;
        }
        return null;
    }

    /**
     * Render this module's help text (Commander-styled successor to
     * program.helpInformation()): usage line, description, Options and
     * Arguments blocks built from the meta.
     */
    static renderHelp(meta: ModuleMeta): string {
        const registry: ResolvedOption[] = (meta.options || [])
            .map((spec, i) => resolveOption(spec, i))
            .filter((r): r is ResolvedOption => r !== null);
        const usage =
            meta.usage ||
            [
                '[options]',
                ...(meta.args || []).map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
            ].join(' ');
        const lines: string[] = [];
        lines.push(`Usage: ${meta.name} ${usage}`);
        lines.push('');
        lines.push(meta.description);
        if (registry.length) {
            lines.push('');
            lines.push('Options:');
            const rows = registry.map((r) => [`  ${r.display}`, r.spec.description || '']);
            const width = Math.max(...rows.map(([flag]) => flag.length));
            for (const [flag, description] of rows) {
                lines.push(`${flag.padEnd(width)}  ${description}`);
            }
        }
        if ((meta.args || []).length) {
            lines.push('');
            lines.push('Arguments:');
            for (const a of meta.args!) {
                lines.push(`  ${a.required ? `<${a.name}>` : `[${a.name}]`}  ${a.description || ''}`);
            }
        }
        return lines.join('\n');
    }
}

/** Main callback signature — returns an exit-machinery value or throws. */
export type MainCallback<M extends ModuleMeta = ModuleMeta> = (
    args: Args<M>,
    positional: Positional<M>
) => unknown;

// DEPRECATED — the lowercase `cli` singleton is gone. Terminal helpers and
// the abort/signal machinery live as free functions in ./Module.ts (imported
// directly by lib/ code) and as Module/CLI/TUI instance methods.
export { Module, ExitSignal, exit, EXIT_FAIL, EXIT_OK, AbortError };
