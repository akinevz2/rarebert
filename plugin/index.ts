/**
 * rarebert — OpenCode plugin bootstrapping rarebert's self-hosting loop.
 *
 * Goal: as parts of rarebert get fixed, surface them to the live session as
 * tools, so the fixed tooling can be used to fix the remaining codebase.
 * Every tool here is a thin, safe wrapper over `bun launch.ts <command>`
 * executed at the rarebert project root — no reimplemented logic, no writes
 * outside what the underlying command itself performs.
 *
 * Tool inventory (namespace `rarebert`):
 *   rarebert_check    — `bun launch.ts check [files...] [--json|--struct|--trace]`
 *   rarebert_analyze  — `bun launch.ts analyze <module...> [--trace] [--graph]`
 *   rarebert_memo     — `bun launch.ts memo [flags...] [modules...]`
 *   rarebert_probe    — live health check of each surface (see below)
 *
 * The probe exists because rarebert currently has surfaces that fail
 * *silently* (exit 0, "integrity: ok", zero bindings). Agents in a live
 * session should run `rarebert_probe` first when a result looks suspicious,
 * and trust the probe's verdict over a green status line.
 *
 * Layout contract: this plugin expects to live at `<rarebert>/plugin`, so the
 * project root is one directory up (verified by the presence of launch.ts).
 * Override with the RAREBERT_ROOT environment variable when relocated.
 */
import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

const execFileAsync = promisify(execFile)

const here =
    typeof (import.meta as { dir?: string }).dir === "string"
        ? (import.meta as { dir: string }).dir
        : path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

interface RunResult {
    code: number
    stdout: string
    stderr: string
}

/** Run `bun launch.ts <args...>` at `root`. Never throws; returns exit state. */
async function launch(
    root: string,
    args: string[],
    opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<RunResult> {
    const timeoutMs = opts.timeoutMs ?? 120_000
    try {
        const { stdout, stderr } = await execFileAsync("bun", ["launch.ts", ...args], {
            cwd: root,
            timeout: timeoutMs,
            maxBuffer: 16 * 1024 * 1024,
            encoding: "utf8",
            signal: opts.signal,
        })
        return { code: 0, stdout, stderr }
    } catch (err) {
        const e = err as { code?: number; killed?: boolean; stdout?: string; stderr?: string; message?: string }
        if (e.killed) {
            return {
                code: e.code ?? 124,
                stdout: e.stdout ?? "",
                stderr: e.stderr ?? `timed out after ${timeoutMs}ms`,
            }
        }
        return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? String(err) }
    }
}

/** Shape a RunResult as tool content: clean output on success, diagnostic on failure. */
function asContent(result: RunResult): string {
    const out = result.stdout.trimEnd()
    if (result.code === 0 && out) return out
    if (result.code === 0) return "(no output)"
    const err = result.stderr.trim()
    return `exit ${result.code}\n${out}${err ? `\nstderr:\n${err}` : ""}`
}

// ---------------------------------------------------------------------------
// Project root resolution
// ---------------------------------------------------------------------------

function resolveRoot(ctx: { location?: { directory?: string } }): string {
    const fromEnv = process.env.RAREBERT_ROOT
    if (fromEnv && fs.existsSync(path.join(fromEnv, "launch.ts"))) return fromEnv

    // Normal placement: <rarebert>/plugin → root is one up.
    const candidate = path.resolve(here, "..")
    if (fs.existsSync(path.join(candidate, "launch.ts"))) return candidate

    // Fallback: the directory this plugin instance was loaded from.
    return ctx.location?.directory ?? candidate
}

// ---------------------------------------------------------------------------
// Probe — live health check of each surfaced surface
// ---------------------------------------------------------------------------

interface SurfaceVerdict {
    surface: string
    ok: boolean
    detail: string
}

const PROBE_MODULE = "scripts/memo.ts"

async function probeSurfaces(root: string, signal?: AbortSignal): Promise<string> {
    const verdicts: SurfaceVerdict[] = []

    // 1. Launcher reachable.
    const help = await launch(root, ["--help"], { timeoutMs: 60_000, signal })
    verdicts.push({
        surface: "launcher",
        ok: help.code === 0,
        detail: help.code === 0 ? "bun launch.ts dispatches" : `exit ${help.code}`,
    })

    // 2. Analyze bindings — the known silent failure: 0/0/0 summary when the
    //    language support modules fail to load.
    const analysis = await launch(root, ["analyze", PROBE_MODULE], { signal })
    const summary = analysis.stdout.match(
        /summary:\s*(\d+) imports;\s*(\d+) declarations;\s*(\d+) exports/
    )
    let analyzeOk = false
    if (summary) {
        const [imports, declarations, exports] = summary.slice(1).map(Number)
        analyzeOk = imports > 0 || declarations > 0 || exports > 0
    }
    verdicts.push({
        surface: "analyze/bindings",
        ok: analysis.code === 0 && analyzeOk,
        detail: summary
            ? analyzeOk
                ? `bindings live (${summary[1]} imports, ${summary[2]} declarations)`
                : "bindings EMPTY — 0 imports/declarations/exports reported (language supports failing to load; check lib/supports/lang*.js imports)"
            : `no summary line in output (exit ${analysis.code})`,
    })

    // 3. Check syntax pass.
    const check = await launch(root, ["check", PROBE_MODULE], { signal })
    verdicts.push({
        surface: "check/syntax",
        ok: check.code === 0 && /0 syntax failures/.test(check.stdout),
        detail: check.code === 0 ? check.stdout.match(/(\d+) syntax failures/)?.[0] ?? "ok" : `exit ${check.code}`,
    })

    // 4. Memo read surface (non-mutating).
    const memo = await launch(root, ["memo", "--oldest"], { signal })
    verdicts.push({
        surface: "memo",
        ok: memo.code === 0,
        detail: memo.code === 0 ? "memo CLI responds" : `exit ${memo.code}`,
    })

    const lines = verdicts.map(
        (v) => `  ${v.ok ? "ok" : "DEGRADED"}  ${v.surface.padEnd(18)} ${v.detail}`
    )
    const allOk = verdicts.every((v) => v.ok)
    return [`rarebert probe — ${allOk ? "all surfaces live" : "degraded surfaces present"}:`, ...lines].join("\n")
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

interface ToolDef {
    name: string
    description: string
    input: Record<string, unknown>
    execute: (
        input: any,
        context?: { sessionID?: string; signal?: AbortSignal }
    ) => Promise<{ content: string }>
}

export default Plugin.define({
    id: "rarebert",
    async setup(ctx) {
        const root = resolveRoot(ctx)

        const tools: ToolDef[] = [
            {
                name: "probe",
                description:
                    "Live health check of rarebert's own tooling surfaces (launcher, analyze bindings, check syntax, memo). Run this before trusting suspicious results — rarebert has surfaces that fail silently with green output.",
                input: { type: "object", properties: {}, additionalProperties: false },
                execute: async (_input, context) => ({
                    content: await probeSurfaces(root, context?.signal),
                }),
            },
            {
                name: "check",
                description:
                    "Run `bun launch.ts check`: node --check syntax verification plus cross-module binding integrity over rarebert modules (imports resolve to real exports; broken/missing/unused/duplicate/dropped bindings reported). With no files, checks all modules. Use rarebert_probe first if a result looks suspicious — rarebert has surfaces that historically failed silently.",
                input: {
                    type: "object",
                    properties: {
                        files: {
                            type: "array",
                            items: { type: "string" },
                            description: "Module paths (e.g. scripts/memo.ts) to scope the check to, including their import trees. Omit to check all modules.",
                        },
                        json: { type: "boolean", description: "Emit machine-readable output." },
                        struct: { type: "boolean", description: "Also dump exports/imports per module." },
                        trace: { type: "string", description: "Walk the binding graph for NAME." },
                        memos: { type: "boolean", description: "Also print the memo DAG." },
                    },
                    additionalProperties: false,
                },
                execute: async ({ files, json, struct, trace, memos }, context) => {
                    const args = ["check"]
                    for (const f of files ?? []) args.push(f)
                    if (json) args.push("--json")
                    if (struct) args.push("--struct")
                    if (trace) args.push("--trace", trace)
                    if (memos) args.push("--memos")
                    return {
                        content: asContent(await launch(root, args, { timeoutMs: 240_000, signal: context?.signal })),
                    }
                },
            },
            {
                name: "analyze",
                description:
                    "Run `bun launch.ts analyze`: condensed source map (imports, top-level declarations, exports), full dependency tracing (--trace module::name), or the resolved import graph (--graph) for rarebert modules.",
                input: {
                    type: "object",
                    properties: {
                        modules: {
                            type: "array",
                            items: { type: "string" },
                            description: "Module paths, basenames, or stems (e.g. scripts/memo.ts, memo). Required unless graph is set.",
                        },
                        trace: { type: "string", description: "module::name or module::outer::inner qualified trace." },
                        graph: { type: "boolean", description: "Print the resolved import graph." },
                    },
                    required: [],
                    additionalProperties: false,
                },
                execute: async ({ modules, trace, graph }, context) => {
                    const args = ["analyze", ...(modules ?? [])]
                    if (trace) args.push("--trace", trace)
                    if (graph) args.push("--graph")
                    return {
                        content: asContent(await launch(root, args, { timeoutMs: 180_000, signal: context?.signal })),
                    }
                },
            },
            {
                name: "memo",
                description:
                    "Run `bun launch.ts memo`: print or manage rarebert's local memo sidecars. Default (no args/modules): prints ALL memos as a dependency DAG, ordered by reference-chain depth (deepest first) then memo age (oldest first) — so the last memo printed is the youngest, least-referenced one. Scope the print with modules. Non-mutating flags: ['--oldest'] prints the most-forgotten memo (the first row of the DAG print). Mutating flags (use deliberately): ['--add', '<module>', '<memo text>'] — supports rich-memo shapes like '@see-line(42, race in flush ordering)' or '@smell(7, long function)' interleaved with plain strings; ['--forget', '--oldest'] drops exactly one memo; ['--drop', '<module>', '<indices>'] drops by index (1-based, -1 = last); ['--commit', '--yes'] snapshots to git notes (irreversible without --recall); ['--recall', '<ref>'], ['--log'].",
                input: {
                    type: "object",
                    properties: {
                        args: {
                            type: "array",
                            items: { type: "string" },
                            description: "Raw memo flags, e.g. ['--oldest'] or ['--forget', '--oldest'] or ['--add', 'scripts/analyze.ts', 'memo text'].",
                        },
                        modules: {
                            type: "array",
                            items: { type: "string" },
                            description: "Module paths to scope printing to.",
                        },
                    },
                    additionalProperties: false,
                },
                execute: async ({ args, modules }, context) => {
                    if ((args ?? []).includes("--forget") && !(args ?? []).includes("--oldest")) {
                        return {
                            content:
                                "refused: `--forget <module>` wipes a whole sidecar. Confirm with the user, or use `--forget --oldest` (drops exactly one memo), or `--drop <module> <indices>`.",
                        }
                    }
                    return {
                        content: asContent(
                            await launch(root, ["memo", ...(args ?? []), ...(modules ?? [])], {
                                timeoutMs: 120_000,
                                signal: context?.signal,
                            })
                        ),
                    }
                },
            },
        ]

        await ctx.tool.transform((editor) => {
            editor.namespace({
                name: "rarebert",
                description: "rarebert toolbox: run rarebert's own launch.ts commands from the live session.",
            })
            for (const tool of tools) {
                editor.add({
                    name: tool.name,
                    description: tool.description,
                    input: tool.input as never,
                    options: { namespace: "rarebert", codemode: true },
                    execute: tool.execute as never,
                })
            }
        })

        console.log(`rarebert plugin: ${tools.length} tools registered (root: ${root})`)
    },
})
