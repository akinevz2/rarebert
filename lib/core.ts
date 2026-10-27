// ---------------------------------------------------------------------------
// lib/core.ts — test compatibility shim (DEPRECATED).
//
// Test files import from '../lib/core.ts' (historical runtime-core path).
// Re-export the canonical lib/runtime/core.ts with EXPLICIT named re-exports
// (not `export *`) so the static bindings parser sees concrete export names
// — `export *` reads as an unnamed reexport and breaks import resolution.
// ---------------------------------------------------------------------------

export {
    ExitSignal,
    HelpRequestedSignal,
    AbortError,
    run,
    exit,
    EXIT_OK,
    EXIT_FAIL,
    EXIT_ABORT,
    Store,
    store,
    DB_PATH,
    DATA_DIR
} from './runtime/core.ts';
