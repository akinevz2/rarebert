#!/usr/bin/env node

import path from 'path';
import { project, exit } from '../lib/core.mjs';
import { server } from '../lib/server.mjs';
import { models } from '../lib/models.mjs';

async function main(args = []) {
    const nonFlag = args.filter((a) => !a.startsWith('-') && a);
    const modelArg = nonFlag[0];
    const model = modelArg ? await models.resolve(modelArg) : null;

    const running = server.getRunningServer();
    if (running) {
        console.log(`open: connecting to running server ${running.url} (mini TUI)`);
        const status = server.attachMini(running);
        return exit(status);
    }

    console.log('open: no running server; starting mini TUI at project root');
    const port = server.DEFAULT_PORT;
    const status = server.startFullTUI({
        cwd: project.root,
        model: model || (await models.resolve()),
        port,
        prompt: null
    });
    return exit(status);
}

export { main };

export default {
    name: 'open',
    description:
        'Connect to a running opencode server (mini TUI), or start one at the project root',
    main
};
