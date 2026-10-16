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
// Re-export order matters: module.ts first so the Module/CLI/TUI class
// chain is fully evaluated before Interface constructions elsewhere.
// ---------------------------------------------------------------------------

export { Module, CLI, TUI, Interface, Arguments, AbortError } from './runtime/module.ts';
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
export { Backend } from './backend.ts';
export { Project } from './runtime/projects.ts';
export { Languages, Language, JsonTemplateLanguage } from './runtime/languages.ts';
export { Memo, Memory } from './memo.ts';
export { Models } from './models.ts';
export { Editor } from './editor.ts';
export { Ide } from './ide.ts';
export { Opencode } from './opencode.ts';
export { Server } from './server.ts';
export { Template } from './supports/template.ts';
export { Libs } from './runtime/libs.ts';
export { Trace } from './introspect.ts';
