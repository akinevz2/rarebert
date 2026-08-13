import { spawnSync } from 'child_process';
import path from 'path';
import { rarebert, home } from './projects.mjs';
import { cli } from './module.mjs';
import { git } from './git.mjs';

const STAGE_CONTINUE = 'continue';
const STAGE_EXIT = 'exit';

export { STAGE_CONTINUE, STAGE_EXIT };

async function promptContinue() {
    const choice = await cli.select('Continue?', [
        { name: STAGE_CONTINUE, message: 'Continue to next stage' },
        { name: STAGE_EXIT, message: 'Exit to shell' }
    ]);
    return choice;
}

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
    console.log('\n=== project folders ===\n');
    const folders = rarebert.discover();
    console.log(`${'key'.padEnd(12)} ${'path'.padEnd(16)} modules`);
    for (const f of folders) {
        const mods = rarebert.discoverModules(f.dir, f.exts);
        const modCount = mods.length > 0 ? `(${mods.length} module${mods.length === 1 ? '' : 's'})` : '(empty)';
        console.log(`${f.key.padEnd(12)} ${f.rel.padEnd(16)} ${modCount}`);
        for (const m of mods) {
            console.log(`  ${m.path}`);
        }
    }
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

    const editScript = path.join(home.root, 'scripts', 'edit.mjs');
    const result = spawnSync(process.execPath, [editScript], {
        stdio: 'inherit',
        cwd: rarebert.root
    });
    return result.status ?? 0;
}

function printDebugListing() {
    const folders = rarebert.discover();
    console.log(`${'key'.padEnd(12)} ${'path'.padEnd(16)} modules`);
    for (const f of folders) {
        const mods = rarebert.discoverModules(f.dir, f.exts);
        const modCount = mods.length > 0 ? `(${mods.length} module${mods.length === 1 ? '' : 's'})` : '(empty)';
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

export {
    promptContinue,
    stageGitStatus,
    stageGitDiff,
    stageBranchRemote,
    stageProjectDiscovery,
    stageLaunchEdit,
    printDebugListing
};