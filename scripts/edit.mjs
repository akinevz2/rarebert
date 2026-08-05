#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { listAllModules, promptModule } from '../lib/modules.mjs';
import { models } from '../lib/models.mjs';
import { editor } from '../lib/editor.mjs';
import { server, DEFAULT_PORT } from '../lib/server.mjs';
import { libs } from '../lib/libs.mjs';
import { current, rarebert } from '../lib/projects.mjs';
import { exit } from '../lib/core.mjs';
import { git } from '../lib/git.mjs';
import { cli } from '../lib/cli.mjs';

async function main(args = []) {
    const modules = listAllModules();
    if (modules.length === 0) {
        console.error('No modules found.');
        return exit(1);
    }

    const nonFlag = args.filter((a) => !a.startsWith('-') && a);
    const moduleArg = nonFlag[0];
    const modelArg = nonFlag[1];

    const target = await promptModule(modules, moduleArg, 'Select a module to edit');
    const rel = libs.relPath(target.path);

    if (!fs.existsSync(target.path)) {
        console.error(`Module file not found: ${rel}`);
        return exit(1);
    }

    editor.writeLastModule(rel);



    const running = server.getRunning();
    let model = modelArg;

    if (!running) {
        if (!model) {
            const config = models.readConfig();
            model = await models.prompt(models.list(config), config.model);
        }
    } else {
        console.log(
            `edit: attaching to existing opencode server at ${running.url} port=${running.port}`
        );
    }


    console.log(`Opening $EDITOR ${rel}`);
    const editorChild = editor.editFile(target.path);

    const result = server.runOnServer({
        project: current,
        prompt: `User requested you display ${rel}`,
        ...(running ? { url: running.url, host: running.host } : { model })
    });

    if (editorChild && !editorChild.killed) {
        editorChild.kill();
    }

    if (result.status !== 0) {
        return exit(result.status);
    }

    console.log('\n--- running `node index.js commit` after opencode exit ---');
    const status = await postCommitMenu(rel, model);

    return exit(status ?? 0);
}

async function postCommitMenu(rel, model) {
    while (true) {
        if (git.statusPorcelain([rel]).length === 0) {
            return 0;
        }

        const action = await cli.select(
            `opencode transformed ${rel}; how do you want to proceed?`,
            [
                { name: 'diff', message: 'Show the diff and commit' },
                { name: 'edit', message: 'Re-edit the file in $EDITOR' },
                { name: 'implement', message: 'Run another opencode round (runOnServer)' },
                { name: 'discard', message: 'Discard opencode changes (git restore)' },
                { name: 'commit', message: 'Commit changes' },
                { name: 'shell', message: 'Return to the shell' }
            ]
        );

        if (action === 'diff') {
            previewDiffFor(rel);
            continue;
        }
        if (action === 'commit') {
            const commit = await git.git('commit');
            if (commit.status != 0)
                continue
            return 0;
        }
        if (action === 'implement') {
            const result = server.runOnServer({
                prompt: `Display user the file ${rel}, and ask for instructions to follow`,
                model,
                auto: true
            });
            if (result.status !== 0)
                console.error(`opencode runOnServer exited with status ${result.status}`);
            continue;
        }
        if (action === 'edit') {
            await runEditorOnce(targetPathFor(rel));
            return 0;
        }
        if (action === 'discard') {
            const ok = await cli.confirm(`Discard changes to ${rel}? This is destructive.`, false);
            if (!ok) continue;
            git.git('restore', ['--', rel], { stdio: 'inherit' });
            console.log(`restored ${rel} to HEAD.`);
            return 0;
        }
        return 0;
    }
}

function previewDiffFor(rel) {
    const pager = process.env.PAGER || 'less';
    const diff = git.diffForPath(rel);
    const child = spawnSync(pager, [], {
        input: diff,
        stdio: ['pipe', 'inherit', 'inherit']
    });
    if (child.error) {
        console.error(`Failed to launch pager (${pager}): ${child.error.message}`);
    }
}

function targetPathFor(rel) {
    return path.isAbsolute(rel) ? rel : path.join(rarebert.root, rel);
}

function runEditorOnce(absPath) {
    return new Promise((resolve) => {
        const child = editor.editFile(absPath);
        child.on('exit', (code) => resolve(code ?? 0));
        child.on('error', () => resolve(1));
    });
}

export { main };

export default {
    name: 'edit',
    description: 'Select an existing module, edit it in $EDITOR, then run opencode on it',
    main
};
