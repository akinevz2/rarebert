import { TUI, cli } from './module.mjs';

// ---------------------------------------------------------------------------
// Shared TUI instance — interactive prompt helpers for lib code that needs
// Enquirer prompts but is not itself a TUI/CLI module instance.
//
// lib/module.mjs contains class definitions only; the prompt helpers
// (confirm/input/select/runInteractively) are member methods inherited from
// the Module/CLI/TUI class chain and are carried by this Module-instancing
// class object. Import `tui` from here, not from module.mjs.
//
// Every prompt is gated by runInteractively: in a non-interactive
// environment the Enquirer prompt is never constructed — the wrapper bails
// with a nonInteractive ExitSignal (default) or the fallback value.
// ---------------------------------------------------------------------------

const tui = new TUI('tui.mjs');

// Share the abort registry with the cli singleton so cleanup callbacks
// registered via cli.onAbort (memo flush, git-index restore) also run when
// a tui prompt bails non-interactively — matching the behavior of the
// former delegate-to-cli object literal. Signal handlers themselves stay
// owned by the cli singleton (installed once in index.js).
tui.abortCallbacks = cli.abortCallbacks;

export { tui };
export default tui;
