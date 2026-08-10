#!/usr/bin/env node

import { spawnSync } from 'child_process';
import path from 'path';
import { rarebert } from '../lib/projects.mjs';
import { listAllModules } from '../lib/modules.mjs';
import { libs } from '../lib/libs.mjs';
import { git } from '../lib/git.mjs';
import { cli } from '../lib/cli.mjs';
import { exit } from '../lib/core.mjs';

const meta = {
    name: 'status',
    description:
        'Walk through git status, diff, branch/remote info, project discovery, and launch edit — interactive staged review',
    usage: 'node index.js status [--debug]',
    options: [
        {
            flag: 'debug',
            label: '',
            description: 'print prod-ready project discovery listing and exit'
        }
    ]
};

const STAGE_CONTINUE = 'continue';
const STAGE_EXIT = 'exit';

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

async function stageGitStatus() {
    console.log('\n=== git status ===\n');
    console.log(git.statusSummary());
    return await promptContinue();
}

async function stageGitDiff() {
    console.log('\n=== git diff (colour) ===\n');
    const diff = git.diffSummary();
    if (!diff) {
        console.log('(no uncommitted changes)');
    } else {
        console.log(diff);
    }
    return await promptContinue();
}

async function stageBranchRemote() {
    console.log('\n=== branch & remote ===\n');
    const { branch, upstream, aheadBehind } = git.branchInfo();
    console.log(`branch:    ${branch}`);
    console.log(`upstream:  ${upstream}`);
    console.log(`ahead/behind: ${aheadBehind}`);
    console.log(`\n${git.remoteInfo()}`);
    return await promptContinue();
}

async function stageProjectDiscovery() {
    console.log('\n=== project discovery ===\n');

    const folders = rarebert.discover();
    for (const f of folders) {
        console.log(f.key.padEnd(10), f.rel.padEnd(14), f.exts.join(','));
    }

    console.log('\n--- getters ---');
    console.log('scriptsDir ', rarebert.scriptsDir);
    console.log('libDir     ', rarebert.libDir);
    console.log('srcDir     ', rarebert.srcDir);
    console.log('supportsDir', rarebert.supportsDir);

    console.log('\n--- projectByKey ---');
    for (const key of ['lib', 'src', 'supports', 'unknown']) {
        const proj = rarebert.projectByKey(key);
        console.log(`${key}:`, proj?.rel ?? null);
    }

    console.log('\n--- discoverModules ---');
    for (const folder of folders) {
        const mods = rarebert.discoverModules(folder.dir, folder.exts);
        if (mods.length > 0) {
            console.log(
                `${folder.key}: ${mods.length} module(s) — ${mods.map((m) => m.path).join(', ')}`
            );
        }
    }

    console.log('\n--- libs.dirForDirectory ---');
    for (const key of ['lib', 'src', 'scripts', 'supports']) {
        console.log(`${key}:`, libs.dirForDirectory(key));
    }

    console.log('\n--- listAllModules ---');
    const mods = listAllModules();
    console.log(`${mods.length} modules`);
    console.log(
        'first 3:',
        mods.slice(0, 3).map((m) => m.path)
    );

    return await promptContinue();
}

async function stageLaunchEdit() {
    console.log('\n=== launch edit ===\n');
    if (!cli.isInteractive()) {
        console.log('Non-interactive; skipping edit launch.');
        return STAGE_EXIT;
    }

    const launch = await cli.select('Launch the edit submodule?', [
        { name: 'edit', message: 'Yes — select a module and edit' },
        { name: 'exit', message: 'No — exit to shell' }
    ]);

    if (launch === 'exit') return STAGE_EXIT;

    const editScript = path.join(rarebert.root, 'scripts', 'edit.mjs');
    const result = spawnSync(process.execPath, [editScript], {
        stdio: 'inherit',
        cwd: rarebert.root
    });
    return result.status ?? 0;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

async function promptContinue() {
    const choice = await cli.select('Continue?', [
        { name: STAGE_CONTINUE, message: 'Continue to next stage' },
        { name: STAGE_EXIT, message: 'Exit to shell' }
    ]);
    return choice;
}

// ---------------------------------------------------------------------------
// Debug listing (prod-ready)
// ---------------------------------------------------------------------------

function printDebugListing() {
    console.log('=== discover() ===');
    for (const f of rarebert.discover())
        console.log(f.key.padEnd(10), f.rel.padEnd(14), f.exts.join(','));

    console.log('\n=== getters ===');
    console.log('scriptsDir ', rarebert.scriptsDir);
    console.log('libDir     ', rarebert.libDir);
    console.log('srcDir     ', rarebert.srcDir);
    console.log('supportsDir', rarebert.supportsDir);

    console.log('\n=== projectByKey ===');
    console.log('lib:', rarebert.projectByKey('lib')?.rel);
    console.log('src:', rarebert.projectByKey('src')?.rel);
    console.log('supports:', rarebert.projectByKey('supports')?.rel);
    console.log('unknown:', rarebert.projectByKey('unknown'));

    console.log('\n=== discoverModules ===');
    const srcProj = rarebert.projectByKey('src');
    console.log('src modules:', rarebert.discoverModules(srcProj.dir, srcProj.exts));

    console.log('\n=== libs.dirForDirectory ===');
    console.log('lib:', libs.dirForDirectory('lib'));
    console.log('src:', libs.dirForDirectory('src'));
    console.log('scripts:', libs.dirForDirectory('scripts'));
    console.log('supports:', libs.dirForDirectory('supports'));

    console.log('\n=== listAllModules ===');
    const mods = listAllModules();
    console.log(`${mods.length} modules`);
    console.log(
        'first 3:',
        mods.slice(0, 3).map((m) => m.path)
    );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(args = []) {
    if (args.includes('--debug')) {
        printDebugListing();
        return exit(0);
    }

    const stages = [
        stageGitStatus,
        stageGitDiff,
        stageBranchRemote,
        stageProjectDiscovery,
        stageLaunchEdit
    ];

    for (const stage of stages) {
        const result = await stage();
        if (result === STAGE_EXIT) return exit(0);
        if (typeof result === 'number') return exit(result);
    }

    return exit(0);
}

export { main };

export default {
    name: 'status',
    description: meta.description,
    main: cli.run(meta, main)
};
