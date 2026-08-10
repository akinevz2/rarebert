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
        console.log(`open: connecting to running server ${running.url} (full TUI)`);
        const status = server.attachFull(running);
        return exit(status);
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
