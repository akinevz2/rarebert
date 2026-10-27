#!/usr/bin/env node

import { editor } from '../lib/editor.ts';
import { CLI, defineMeta } from '../lib/runtime/CLI.ts';
import { exit } from '../lib/core.ts';
import { refreshMakefile } from '../lib/runtime/makefile.ts';

const meta = defineMeta({
    name: 'reload',
    description: 'Rebuild Makefile as a pure index of node index.js <name> targets',
    usage: 'node index.js reload [--forget]',
    options: [{ flag: '--forget', description: 'also delete .last-module after refreshing' }]
});

export { meta };

export default new CLI(
    'reload.ts',
    async (opts, positional) => {
        if (opts.forget) {
            editor.clearLastModule();
        }

        const result = refreshMakefile();
        console.log(
            `discover scripts/ -> ${result.scriptCount} found: ${result.scripts.map((s) => s.name).join(', ') || '(none)'}`
        );

        if (result.written) {
            console.log(
                `refresh ${result.rel} (${result.scriptCount} script targets + ${result.extraCount} extras)`
            );
        } else {
            console.log(`up-to-date ${result.rel} (no changes)`);
        }
        console.log(`done: ${result.scriptCount} module(s)`);
        return exit(0);
    },
    meta
).supportsDirectRunning();
