// ---------------------------------------------------------------------------
// lib/index.ts — the barrel for lib/.
//
// Target architecture (memo'd on every lib/ module): each lib/ module
// exports exactly one class (or one class plus a few methods that consume
// it), and this file re-exports them all so scripts/ consumers import from
// a single point:
//
//     import { Git, TUI, Interface } from '../lib/index.ts';
//
// Note: Node ESM has no directory imports, so the explicit ./index.ts
// specifier is the barrel — `import '../lib'` will not resolve.
//
// Re-export order matters: runtime first so the Module/CLI/TUI class
// chain is fully evaluated before Interface constructions elsewhere.
// ---------------------------------------------------------------------------

// Runtime — one class per PascalCase file (Module → CLI → TUI/Interface).
export { Module } from './runtime/Module.ts';
export { CLI, Arguments } from './runtime/CLI.ts';
export type {
    MainCallback,
    ModuleMeta,
    OptionSpec,
    ArgSpec,
    // typed-arguments seam (zod engine)
    Args,
    Positional,
    OptsOf,
    ParsedInvocation
} from './runtime/CLI.ts';
export { TUI, Interface } from './runtime/TUI.ts';
export {
    // terminal helpers & abort machinery (free functions from Module.ts)
    isInteractive,
    truncate,
    onAbort,
    installSignalHandlers,
    abort,
    nonInteractive,
    ok,
    fail,
    runInteractively
} from './runtime/Module.ts';

// Runtime core — signals & exit machinery (the canonical home).
export {
    ExitSignal,
    HelpRequestedSignal,
    Store,
    run,
    exit,
    EXIT_OK,
    EXIT_FAIL,
    EXIT_ABORT
} from './runtime/core.ts';

export { Git } from './git.ts';
export { memo } from './memo.ts';
// Memo classes are exported directly from lib/memo.ts (see that module).

export { Project, ProjectFolder, home, rarebert } from './runtime/Project.ts';
export { Language, JsonTemplateLanguage, Languages, languages } from './runtime/Language.ts';

// Source-graph dependency primitives (reusable DAG math for memo + future tools).
export {
    parseModuleImports,
    buildImportGraph,
    computeChainDepths,
    compareDagGroups,
    stronglyConnectedComponents
} from './depgraph.ts';
export type { GraphNode, ImportGraph } from './depgraph.ts';
