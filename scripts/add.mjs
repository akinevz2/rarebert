#!/usr/bin/env node

import { backend } from '../lib/backend.mjs';
import { exit } from '../lib/core.mjs';
import { CLI, cli, AbortError } from '../lib/module.mjs';
import { store } from '../lib/core.mjs';
import { current, rarebert } from '../lib/projects.mjs';

const meta = {
    name: 'add',
    description:
        'Register the current project with rarebert: scan for module-containing folders and mark which ones rarebert should track',
    usage: 'node index.js add [--force]',
    options: [{ flag: '--force', description: 're-register even if this project is already onboarded' }]
};

export { meta };

export default new CLI('add.mjs', async (opts, positional) => {
    const force = !!opts.force || positional.includes('--force') || positional.includes('-f');
    const cwd = current.root;

    if (cwd === rarebert.root) {
        console.log('add: nothing to register — this is the rarebert install directory.');
        return exit(0);
    }

    if (store.isOnboarded(cwd) && !force) {
        console.log('add: project already registered; re-run with --force to re-register.');
        return exit(0);
    }

    if (!cli.isInteractive()) {
        console.error(
            `add: project "${cwd}" is not registered with rarebert.\n` +
                'Run `make add` in an interactive shell to mark module folders.'
        );
        return exit(1);
    }

    console.log('\n=== rarebert project registration ===\n');
    console.log(`Scanning ${cwd} for module-containing folders...`);

    const candidates = backend.scanCandidateFolders(cwd);
    if (candidates.length === 0) {
        console.log('No module-containing folders found; registering project with no tracked folders.');
        store.registerProject(cwd);
        store.markOnboarded(cwd);
        return exit(0);
    }

    console.log(`Found ${candidates.length} candidate folder(s):\n`);
    candidates.forEach((c, i) => {
        console.log(
            `  ${i + 1}. ${c.name}/  (${c.fileCount} module file${c.fileCount === 1 ? '' : 's'}, ${c.exts.join(', ')})`
        );
    });
    console.log();

    const choices = candidates.map((c) => ({
        name: c.rel,
        message: `${c.name}/  (${c.fileCount} files, ${c.exts.join(', ')})`
    }));

    let selected;
    try {
        const { default: Enquirer } = await import('enquirer');
        const prompt = new Enquirer.MultiSelect({
            name: 'folders',
            message: 'Mark the folders rarebert should track (space to toggle, enter to confirm):',
            choices,
            initial: choices.map((c) => c.name),
            result(names) {
                return Array.isArray(names) ? names : [names];
            }
        });
        selected = await prompt.run();
        selected = Array.isArray(selected) ? selected : [selected];
    } catch {
        throw new AbortError();
    }

    if (selected.length === 0) {
        console.log('No folders selected; registering project with no tracked folders.');
        store.registerProject(cwd);
        store.markOnboarded(cwd);
        return exit(0);
    }

    const folders = selected.map((rel) => {
        const candidate = candidates.find((c) => c.rel === rel);
        return {
            rel,
            key: rel,
            exts: candidate ? candidate.exts : ['.mjs', '.js'],
            label: `${rel}/  (registered)`
        };
    });

    const project = store.registerProject(cwd);
    store.setFolders(project.id, folders);
    store.markOnboarded(cwd);

    console.log(`\n✓ Registered ${folders.length} folder(s) for ${cwd}`);
    folders.forEach((f) => console.log(`  - ${f.rel}/  (${f.exts.join(', ')})`));
    return exit(0);
}, meta).supportsDirectRunning(import.meta.url);