#!/usr/bin/env node

import path from 'path';
import { readLastModule } from '../lib/editor.mjs';
import { resolveModel } from '../lib/models.mjs';
import { input } from '../lib/cli.mjs';
import * as server from '../lib/server.mjs';
import { PROJECT_ROOT } from '../lib/core.mjs';

async function main(args = []) {
    const file = readLastModule();
    if (!file) {
        console.error('Run `node index.js add` first');
        process.exit(1);
    }

    const nonFlag = args.filter((a) => !a.startsWith('-') && a);
    const model = await resolveModel(nonFlag[0]);

    const cwd = server.cwdForModule(file);
    const relCwd = cwd === PROJECT_ROOT ? './' : `${path.relative(PROJECT_ROOT, cwd)}/`;

    const instruction = await input(
        `Instruction for opencode (cwd: ${relCwd}, file: ${file}):`,
        { initial: `Implement the module in ${file}` }
    );
    if (!instruction.trim()) process.exit(130);

    const running = server.getRunningServer();
    if (running) {
        console.error(`implement: connecting to running server ${running.url} (mini TUI)`);
        const status = server.attachMini(running);
        if (status !== 0) process.exit(status);
        return;
    }

    const port = server.DEFAULT_PORT;
    console.error(`implement: no running server; starting full TUI on port ${port} (password=${port})`);
    console.error(`  cwd: ${relCwd}`);
    console.error(`  subsequent \`make implement\` invocations will attach with --mini`);
    const status = server.startFullTUI({ cwd, model, port, prompt: instruction });
    if (status !== 0) process.exit(status);
}

export { main };

export default {
    name: 'implement',
    description: 'Run opencode TUI to implement the module named in .last-module; subsequent runs attach via --mini',
    main
};