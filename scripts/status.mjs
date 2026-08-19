#!/usr/bin/env node

import { exit } from '../lib/core.mjs';
import { TUI } from '../lib/module.mjs';
import {
    stageProjectDiscovery,
    stageGitStatus,
    stageGitDiff,
    stageBranchRemote,
    stageLaunchEdit,
    printDebugListing,
    STAGE_EXIT
} from '../lib/status.mjs';

const meta = {
    name: 'status',
    description:
        'Show project folders and modules, then git status/diff/branch/remote, and optionally launch edit — interactive staged review',
    usage: 'node index.js status [--debug]',
    options: [
        { flag: '--debug', description: 'print prod-ready project discovery listing and exit' }
    ]
};

export { meta };

export default new TUI(
    'status.mjs',
    async (opts, positional) => {
        if (opts.debug) {
            printDebugListing();
            return exit(0);
        }

        const stages = [
            stageProjectDiscovery,
            stageGitStatus,
            stageGitDiff,
            stageBranchRemote,
            stageLaunchEdit
        ];

        for (const stage of stages) {
            const result = await stage();
            if (result === STAGE_EXIT) return exit(0);
            if (typeof result === 'number') return exit(result);
        }

        return exit(0);
    },
    meta
).supportsDirectRunning(import.meta.url);
