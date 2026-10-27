// ---------------------------------------------------------------------------
// lib/module.ts — test compatibility shim (DEPRECATED).
//
// Test files still import from '../lib/module.ts'. Aggregate the canonical
// PascalCase runtime files with EXPLICIT named re-exports (not `export *`)
// so the static bindings parser sees concrete export names — `export *`
// reads as an unnamed reexport and breaks import resolution.
//
// NOTE: no `tui` binding — the legacy lowercase singleton is gone (a test
// pins its absence). Import the TUI class from './runtime/TUI.ts'.
// ---------------------------------------------------------------------------

// Module base class + terminal helpers & abort machinery (free functions).
export {
    Module,
    isInteractive,
    truncate,
    onAbort,
    runAbortCallbacks,
    installSignalHandlers,
    abort,
    nonInteractive,
    ok,
    fail,
    runInteractively
} from './runtime/Module.ts';

// CLI — Commander arg parsing, Arguments, MainCallback.
export { CLI, Arguments } from './runtime/CLI.ts';

// TUI — full-screen interactive modules + Interface flow composer.
export { TUI, Interface } from './runtime/TUI.ts';

// Discovery & resolution helpers.
export {
    findDirectoryTarget,
    directoryTargetByPath,
    listAllModules,
    buildModuleChoices,
    resolveModule,
    resolveModuleSet,
    promptModule,
    promptModuleChoices
} from './runtime/discovery.ts';

// Canonical signal home: core.ts.
export {
    ExitSignal,
    HelpRequestedSignal,
    AbortError,
    run,
    exit,
    EXIT_OK,
    EXIT_FAIL,
    EXIT_ABORT
} from './runtime/core.ts';

// Project singletons + Project class.
export { Project, ProjectFolder, home, rarebert } from './runtime/Project.ts';

// Language registry.
export { Language, JsonTemplateLanguage, Languages, languages } from './runtime/Language.ts';
