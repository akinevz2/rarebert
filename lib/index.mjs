// ---------------------------------------------------------------------------
// lib/index.mjs — the barrel for lib/.
//
// Target architecture (memo'd on every lib/ module): each lib/ module
// exports exactly one class (or one class plus a few methods that consume
// it), and this file re-exports them all so scripts/ consumers import from
// a single point:
//
//     import { Git, TUI, Interface } from '../lib/index.mjs';
//
// Note: Node ESM has no directory imports, so the explicit ./index.mjs
// specifier is the barrel — `import '../lib'` will not resolve.
//
// Re-export order matters: module.mjs first so the Module/CLI/TUI class
// chain is fully evaluated before Interface constructions elsewhere.
// ---------------------------------------------------------------------------

export { Module, CLI, TUI, Interface, Arguments, AbortError } from './module.mjs';
export {
    ExitSignal,
    HelpRequestedSignal,
    Store,
    exit,
    EXIT_OK,
    EXIT_FAIL,
    EXIT_ABORT
} from './core.mjs';
export { run } from './runtime.mjs';
export { Git } from './git.mjs';
export { Backend } from './backend.mjs';
export { Project } from './projects.mjs';
export { Languages, Language, JsonTemplateLanguage } from './languages.mjs';
export { Memo, Memory } from './memo.mjs';
export { Models } from './models.mjs';
export { Editor } from './editor.mjs';
export { Ide } from './ide.mjs';
export { Opencode } from './opencode.mjs';
export { Server } from './server.mjs';
export { Template } from './template.mjs';
export { Libs } from './libs.mjs';
export { Trace } from './introspect.mjs';
