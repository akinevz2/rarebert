#!/usr/bin/env node

import { spawnSync } from 'child_process';
import path from 'path';
import { exit } from '../lib/core.mjs';
import { Interface, TUI, cli } from '../lib/module.mjs';
import { rarebert, home } from '../lib/projects.mjs';
import { tui } from '../lib/tui.mjs';
import { git } from '../lib/git.mjs';

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

// Each stage is a TUI submodule chained by an Interface flow. A stage main
// returns exit(0) to advance the chain, exit("explanation") to terminate
// the flow with an explanation, or exit(n) to terminate with code n —
// dispatched by exit()'s argument kind.

async function promptContinue() {
    const choice = await tui.select('Continue?', [
        { name: 'continue', message: 'Continue to next stage' },
        { name: 'exit', message: 'Exit to shell' }
    ]);
    return choice === 'exit' ? exit('exit') : exit(0);
}

const stageProjectDiscovery = new TUI(
    'stage-project-discovery.mjs',
    async () => {
        console.log('\n=== project folders ===\n');
        const folders = rarebert.discover();
        console.log(`${'key'.padEnd(12)} ${'path'.padEnd(16)} modules`);
        for (const f of folders) {
            const mods = rarebert.discoverModules(f.dir, f.exts);
            const modCount =
                mods.length > 0
                    ? `(${mods.length} module${mods.length === 1 ? '' : 's'})`
                    : '(empty)';
            console.log(`${f.key.padEnd(12)} ${f.rel.padEnd(16)} ${modCount}`);
            for (const m of mods) {
                console.log(`  ${m.path}`);
            }
        }
        return promptContinue();
    },
    { name: 'stage-project-discovery', description: 'status flow stage: project folders' }
);

const stageGitStatus = new TUI(
    'stage-git-status.mjs',
    async () => {
        console.log('\n=== git status ===\n');
        console.log(git.statusSummary());
        return promptContinue();
    },
    { name: 'stage-git-status', description: 'status flow stage: git status' }
);

const stageGitDiff = new TUI(
    'stage-git-diff.mjs',
    async () => {
        console.log('\n=== git diff (colour) ===\n');
        const diff = git.diffSummary();
        if (!diff) {
            console.log('(no uncommitted changes)');
        } else {
            console.log(diff);
        }
        return promptContinue();
    },
    { name: 'stage-git-diff', description: 'status flow stage: git diff' }
);

const stageBranchRemote = new TUI(
    'stage-branch-remote.mjs',
    async () => {
        console.log('\n=== branch & remote ===\n');
        const { branch, upstream, aheadBehind } = git.branchInfo();
        console.log(`branch:    ${branch}`);
        console.log(`upstream:  ${upstream}`);
        console.log(`ahead/behind: ${aheadBehind}`);
        console.log(`\n${git.remoteInfo()}`);
        return promptContinue();
    },
    { name: 'stage-branch-remote', description: 'status flow stage: branch & remote' }
);

const stageLaunchEdit = new TUI(
    'stage-launch-edit.mjs',
    async () => {
        console.log('\n=== launch edit ===\n');
        if (!cli.isInteractive()) {
            console.log('Non-interactive; skipping edit launch.');
            return exit('exit');
        }

        const launch = await tui.select('Launch the edit submodule?', [
            { name: 'edit', message: 'Yes — select a module and edit' },
            { name: 'exit', message: 'No — exit to shell' }
        ]);

        if (launch === 'exit') return exit('exit');

        const editScript = path.join(home.root, 'scripts', 'edit.mjs');
        const result = spawnSync(process.execPath, [editScript], {
            stdio: 'inherit',
            cwd: rarebert.root
        });
        return exit(result.status ?? 0);
    },
    { name: 'stage-launch-edit', description: 'status flow stage: launch edit' }
);

function printDebugListing() {
    const folders = rarebert.discover();
    console.log(`${'key'.padEnd(12)} ${'path'.padEnd(16)} modules`);
    for (const f of folders) {
        const mods = rarebert.discoverModules(f.dir, f.exts);
        const modCount =
            mods.length > 0 ? `(${mods.length} module${mods.length === 1 ? '' : 's'})` : '(empty)';
        console.log(`${f.key.padEnd(12)} ${f.rel.padEnd(16)} ${modCount}`);
        for (const m of mods) {
            console.log(`  ${m.path}`);
        }
    }

    console.log('\n=== git status ===');
    console.log(git.statusSummary() || '(clean)');

    const { branch, upstream, aheadBehind } = git.branchInfo();
    console.log('\n=== branch & remote ===');
    console.log(`branch:       ${branch}`);
    console.log(`upstream:     ${upstream}`);
    console.log(`ahead/behind: ${aheadBehind}`);
    console.log(git.remoteInfo());
}

// Flow-as-main: the stages are themselves TUI submodules; the main returns
// exit(flow) — exit()'s kind dispatch wraps the Interface chain as an
// ExitSignal submodule and the Runtime drives it through complete().
export default new TUI(
    'status.mjs',
    async (opts) => {
        if (opts.debug) {
            printDebugListing();
            return exit(0);
        }

        return exit(
            Interface.createInterface('status')
                .stage(stageProjectDiscovery)
                .stage(stageGitStatus)
                .stage(stageGitDiff)
                .stage(stageBranchRemote)
                .stage(stageLaunchEdit)
        );
    },
    meta
).supportsDirectRunning(import.meta.url);
