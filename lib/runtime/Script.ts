// ---------------------------------------------------------------------------
// lib/runtime/Script.ts — a resolved scripts/ module reference.
//
// The dispatcher's unit of dispatch: instead of passing dismembered
// `{ name, path }` property pairs across call sites (the raw-string
// anti-pattern tracked in docs/KNOWN_ISSUES.md §0), consumers receive the
// whole typed object. Constructed by Project.resolveModuleRef, which
// injects the project root so absolute-path derivations are typed
// accessors rather than re-resolved strings at every boundary.
// ---------------------------------------------------------------------------

import path from 'path';
import type { Module } from './Module.ts';

export class Script {
    /** The module's name (stem, normalized by the resolver). */
    readonly name: string;
    /** The module's project-relative path. */
    readonly path: string;
    /** The project root this ref was resolved against (abs derivation). */
    readonly root: string;

    /** Deconstructing overload: a Module instance that IS a script. */
    constructor(mod: Module, root: string);
    /** Full-args overload: explicit name/path/root. */
    constructor(name: string, relPath: string, root: string);
    constructor(modOrName: Module | string, second?: string, third?: string) {
        if (typeof modOrName === 'string') {
            this.name = modOrName;
            this.path = second as string;
            this.root = third as string;
        } else {
            // Deconstruct the module — no runtime import of Module.ts
            // (type-only above), so no Module↔Script cycle.
            this.name = modOrName.name;
            this.path = modOrName.path;
            this.root = second as string;
        }
    }

    /** Absolute path on disk. */
    get abs(): string {
        return path.isAbsolute(this.path) ? this.path : path.join(this.root, this.path);
    }

    /** file:// URL for dynamic import (the Dispatcher.load contract). */
    get importUrl(): string {
        return 'file://' + this.abs;
    }
}
