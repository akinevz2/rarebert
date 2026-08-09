#!/usr/bin/env node

import path from 'path';
import { rarebert } from '../lib/projects.mjs';
import { exit } from '../lib/core.mjs';
import { server } from '../lib/server.mjs';
import { models } from '../lib/models.mjs';
import { editor } from '../lib/editor.mjs';
import { cli } from '../lib/cli.mjs';

const meta = {
    name: 'open',
    description:
        'Launch the opencode full TUI at the project root; if a server is already running, attach the full TUI to it and spawn $EDITOR on .last-module',
    usage: 'node index.js open [model]',
    options: []
};

async function main(args = []) {
    const nonFlag = args.filter((a) => !a.startsWith('-') && a);
    const modelArg = nonFlag[0];
    const model = modelArg ? await models.resolve(modelArg) : null;

    const running = server.getRunning();
    if (running) {
        console.log(`open: attaching full TUI to running server ${running.url}`);

        const lastInfo = editor.readLastModuleInfo();
        if (lastInfo && lastInfo.rel) {
            const abs = path.isAbsolute(lastInfo.rel)
                ? lastInfo.rel
                : path.join(rarebert.root, lastInfo.rel);
            console.log(`open: spawning $EDITOR on ${lastInfo.rel} (detach) ...`);
            try {
                editor.editFile(abs);
            } catch (err) {
                console.error(`open: failed to spawn $EDITOR on ${lastInfo.rel}: ${err.message}`);
            }
        }

        const { child } = server.spawnFull({ url: running.url, port: running.port });
        if (!child) return exit(1);
        const code = await new Promise((resolve) => {
            child.on('exit', (c) => resolve(c ?? 0));
        });
        return exit(code);
    }

    console.log('open: no running server; launching full TUI at project root (no headless server)');
    const port = server.DEFAULT_PORT;
    const status = await server.startFullTUI({
        cwd: rarebert.root,
        model: model || (await models.resolve()),
        port,
        prompt: null
    });
    return exit(status);
}

export { main };

export default {
    name: 'open',
    description: meta.description,
    main: cli.run(meta, main)
};
