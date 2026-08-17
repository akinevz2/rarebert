#!/usr/bin/env node

import { CLI, TUI, cli } from '../lib/module.mjs';
import { exit } from '../lib/core.mjs';
import { models } from '../lib/models.mjs';
import { libs } from '../lib/libs.mjs';
import {
    ensureCloned,
    assertHostCleanOrCommit,
    promptBranch,
    assertReportClean,
    runMake,
    assertCleanBeforeSwitch,
    listSections,
    promptSection,
    editSection,
    confirmCommit,
    manageSections,
    makeTodoNote,
    editPreamble,
    isReportClean,
    SRC_DIR
} from '../lib/article.mjs';

const meta = {
    name: 'article',
    description: 'Manage the academic report: clone, build, edit a section, commit',
    usage: 'node index.js article [--preview] [section] [model]',
    options: [{ flag: '-p, --preview', description: 'Preview mode' }]
};

export { meta };

export default new CLI('article.mjs', async (opts, positional) => {
    const preview = opts.preview;
    const sectionArg = positional[0];
    const modelArg = positional[1];

    ensureCloned();
    await assertHostCleanOrCommit();
    await promptBranch();
    assertReportClean();
    if (!runMake('report')) {
        console.error('continuing despite build failure (toolchain may be missing).');
    }
    if (preview) runMake('open');

    if (sectionArg) {
        assertCleanBeforeSwitch();
        const sections = listSections();
        if (sections.length === 0) {
            console.error(`No markdown sections found under ${libs.relPath(SRC_DIR)}/.`);
            return exit(1);
        }
        const section = await promptSection(sections, sectionArg);
        const model = await models.resolve(modelArg);
        const status = await editSection(model, section.path, section.rel);
        await confirmCommit(`update ${section.rel}`);
        return exit(status, () => {
            if (status !== 0) console.error(`edit session exited with status ${status}.`);
        });
    }

    if (process.stdin.isTTY !== true) {
        console.error('Non-interactive; pass a section path as an argument.');
        return exit(1);
    }

    return exit(new TUI('article.mjs', async (opts, positional) => {
        const preview = opts.preview;
        const sectionArg = positional[0];
        const modelArg = positional[1];

        while (true) {
            const choice = await cli.select('Article mode', [
                { name: 'manage', message: 'Manage sections' },
                { name: 'edit', message: 'Edit a section' },
                { name: 'preamble', message: 'Edit the preamble' },
                { name: 'todo', message: 'Make a TODO note' },
                { name: 'exit', message: 'Exit' }
            ]);

            if (choice === 'exit') {
                return exit(0);
            }
            if (choice === 'manage') {
                const before = isReportClean();
                await manageSections();
                const after = isReportClean();
                if (before && !after) await confirmCommit('manage sections');
                continue;
            }
            if (choice === 'todo') {
                await makeTodoNote();
                continue;
            }
            if (choice === 'preamble') {
                assertCleanBeforeSwitch();
                const model = await models.resolve(modelArg);
                await editPreamble(model);
                continue;
            }
            if (choice === 'edit') {
                assertCleanBeforeSwitch();
                const sections = listSections();
                if (sections.length === 0) {
                    console.error(`No markdown sections found under ${libs.relPath(SRC_DIR)}/.`);
                    continue;
                }
                const section = await promptSection(sections, null);
                const model = await models.resolve(modelArg);
                const status = await editSection(model, section.path, section.rel);
                if (status !== 0) console.error(`edit session exited with status ${status}.`);
                await confirmCommit(`update ${section.rel}`);
            }
        }
    }, meta));
}, meta).supportsDirectRunning(import.meta.url);