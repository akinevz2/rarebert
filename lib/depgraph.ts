// ---------------------------------------------------------------------------
// lib/depgraph.ts — DAG-based source-graph dependency primitives.
//
// The reusable core underneath any consumer that needs the module import
// structure (memo's DAG print, future refactor/analysis tools). Pure and
// presentation-free: given a module list and per-extension Language
// parsers, it builds adjacency maps, reference-chain depths, and cycle
// components. Nothing here reads or writes memo sidecars.
//
// Language-agnostic by design: import parsing is delegated to the
// extension's Language support (lib/supports/lang*.js via
// lib/runtime/Language.ts) — scaffolding a new language extends every
// consumer of these primitives at once. A module whose extension has no
// loaded Language contributes NO import edges (never regex-guessed ones).
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import type { Language } from './runtime/Language.ts';

/** Minimal module shape (the discovery Module contract subset). */
export interface GraphNode {
    /** Project-relative path. */
    path: string;
    /** Absolute path on disk. */
    abs: string;
}

/** Adjacency views of the project import graph, keyed by module path. */
export interface ImportGraph {
    /** path → project paths it imports (deduped, source order). */
    importsOf: Map<string, string[]>;
    /** path → project paths that import it. */
    importersOf: Map<string, string[]>;
    /** Extensions whose modules were skipped (no Language support loaded). */
    unsupported: string[];
}

/**
 * Parse one file's project-module import targets through its Language.
 *
 * Uses the language's structured `extractBindings` (line-anchored, so
 * import examples in doc comments do NOT produce phantom edges). Bare
 * specifiers (package imports) are filtered — they are not project
 * modules. Returns deduped ABSOLUTE paths, in source order.
 */
export function parseModuleImports(absPath: string, lang: Language | null): string[] {
    if (!lang) return [];
    let content;
    try {
        content = fs.readFileSync(absPath, 'utf-8');
    } catch {
        return [];
    }
    let bindings;
    try {
        bindings = lang.extractBindings(content);
    } catch {
        return [];
    }
    const importerDir = path.dirname(absPath);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const imp of bindings?.imports ?? []) {
        const source = imp?.source;
        if (!source || typeof source !== 'string') continue;
        if (!source.includes('/') && !source.startsWith('.')) continue;
        let resolved;
        try {
            resolved = path.resolve(importerDir, source);
        } catch {
            continue;
        }
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        out.push(resolved);
    }
    return out;
}

/**
 * Build the project import graph. Modules whose extension has no loaded
 * Language are skipped and their extension reported in `unsupported` —
 * the caller decides whether that is fatal or just warned about.
 */
export function buildImportGraph(
    modules: readonly GraphNode[],
    langs: ReadonlyMap<string, Language | null>
): ImportGraph {
    const importsOf = new Map<string, string[]>(modules.map((m) => [m.path, []]));
    const importersOf = new Map<string, string[]>(modules.map((m) => [m.path, []]));
    const unsupported = new Set<string>();
    const absIndex = new Map(modules.map((m) => [m.abs, m.path]));

    for (const m of modules) {
        const ext = path.extname(m.abs).toLowerCase();
        const lang = langs.get(ext) ?? null;
        if (!lang) {
            unsupported.add(ext);
            continue;
        }
        // TODO(whole-object): pass the GraphNode (m) instead of m.abs — see §lib-classes
        for (const absSource of parseModuleImports(m.abs, lang)) {
            const target = absIndex.get(absSource);
            if (!target || target === m.path) continue;
            if (!importsOf.get(m.path)!.includes(target)) importsOf.get(m.path)!.push(target);
            if (!importersOf.get(target)!.includes(m.path)) importersOf.get(target)!.push(m.path);
        }
    }
    return { importsOf, importersOf, unsupported: [...unsupported] };
}

/**
 * Reference-chain depth for each node: how many layers of modules
 * transitively IMPORT it (longest importer chain above the node).
 * Top-level modules (nothing imports them) are 0; a lib leaf imported
 * through a long chain of consumers scores highest.
 *
 * Cycles are guarded deterministically: a back-edge contributes 0.
 */
export function computeChainDepths(
    paths: readonly string[],
    importersOf: ReadonlyMap<string, readonly string[]>
): Map<string, number> {
    const depths = new Map<string, number>();
    const visit = (p: string, seen: Set<string>): number => {
        const cached = depths.get(p);
        if (cached !== undefined) return cached;
        if (seen.has(p)) return 0;
        seen.add(p);
        let d = 0;
        for (const importer of importersOf.get(p) ?? []) {
            d = Math.max(d, 1 + visit(importer, seen));
        }
        seen.delete(p);
        depths.set(p, d);
        return d;
    };
    for (const p of paths) visit(p, new Set());
    return depths;
}

/**
 * The DAG-row ordering comparator (the memo print's specification):
 *
 *   1. Reference-chain depth, DEEPEST FIRST — a module imported through a
 *      longer chain of other modules prints higher.
 *   2. Row age, OLDEST FIRST (lastModified ascending).
 *
 * Array.sort is stable, so pre-sorted input's order is the final
 * tiebreaker. Consequently the last row printed is always the youngest,
 * least-referenced entry.
 */
export function compareDagGroups(
    a: { depth?: number; lastModified?: number },
    b: { depth?: number; lastModified?: number }
): number {
    const depthDiff = (b.depth ?? 0) - (a.depth ?? 0);
    if (depthDiff !== 0) return depthDiff;
    return (a.lastModified || 0) - (b.lastModified || 0);
}

/**
 * Strongly-connected components (Tarjan) of the import graph — each SCC
 * with more than one member (or a self-loop, which buildImportGraph
 * filters out) is a genuine cycle. Returns member lists in discovery
 * order; the caller renders/warns per its own policy.
 */
export function stronglyConnectedComponents(
    nodes: readonly string[],
    importsOf: ReadonlyMap<string, readonly string[]>
): string[][] {
    let indexCounter = 0;
    const indexOf = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const components: string[][] = [];

    const strongConnect = (v: string): void => {
        indexOf.set(v, indexCounter);
        lowlink.set(v, indexCounter);
        indexCounter++;
        stack.push(v);
        onStack.add(v);

        for (const w of importsOf.get(v) ?? []) {
            if (!indexOf.has(w)) {
                strongConnect(w);
                lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
            } else if (onStack.has(w)) {
                lowlink.set(v, Math.min(lowlink.get(v)!, indexOf.get(w)!));
            }
        }

        if (lowlink.get(v) === indexOf.get(v)) {
            const component: string[] = [];
            let w: string;
            do {
                w = stack.pop()!;
                onStack.delete(w);
                component.push(w);
            } while (w !== v);
            components.push(component);
        }
    };

    for (const v of nodes) {
        if (!indexOf.has(v)) strongConnect(v);
    }
    return components.filter((c) => c.length > 1);
}
