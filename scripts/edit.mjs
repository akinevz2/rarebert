#!/usr/bin/env node

import fs from 'fs';
import { spawnSync } from 'child_process';
import { listAllModules, promptModule, resolveModule } from '../lib/modules.mjs';
import { models } from '../lib/models.mjs';
import { editor } from '../lib/editor.mjs';
import { server } from '../lib/server.mjs';
import { ide } from '../lib/ide.mjs';
import { exit } from '../lib/core.mjs';
import { git } from '../lib/git.mjs';
import { cli } from '../lib/cli.mjs';

const meta = {
    name: 'edit',
    description:
        'Edit a module in $EDITOR, attach it to the running opencode server (mini TUI); on editor close the connection terminates but the session persists on the server',
    usage: 'node index.js edit [module] [model]',
    options: []
};

async function main(args = []) {
    const modules = listAllModules();
    if (modules.length === 0) {
        console.error('No modules found.');
        return exit(1);
    }

    const nonFlag = args.filter((a) => !a.startsWith('-') && a);
    const moduleArg = nonFlag[0];
    const modelArg = nonFlag[1];

    let target;
    if (moduleArg) {
        const resolved = resolveModule(moduleArg, modules);
        if (!resolved) {
            console.error(`Module not found: ${moduleArg}`);
            return exit(1);
        }
        target = resolved.module;
    } else {
        target = await promptModule(modules, moduleArg, 'Select a module to edit');
    }
    const rel = target.path;

    if (!fs.existsSync(target.abs)) {
        console.error(`Module file not found: ${rel}`);
        return exit(1);
    }

    editor.writeLastModule(rel);

    let running = server.getRunning();
    let startedHeadless = false;
    if (!running) {
        console.log('edit: no running opencode server; starting one in the background ...');
        const info = await server.startHeadless({ port: server.port });
        if (!info) {
            console.error('edit: could not start a headless opencode server.');
            console.error(
                '       run `make open` (or `node index.js open`) to start one manually.'
            );
            return exit(1);
        }
        running = info;
        startedHeadless = true;
    }

    let model = modelArg;
    if (!model) {
        const config = models.readConfig();
        model = await models.prompt(models.list(config), config.model);
    }

    console.log(`edit: attaching to server ${running.url} port=${running.port}`);
    console.log(`Opening $EDITOR ${rel} (close editor to terminate the opencode connection)`);

    const { child: opencodeChild } = server.runInteractive({
        url: running.url,
        port: running.port,
        file: rel,
        prompt: `User edited ${rel}; review the file and ask for follow-up instructions.`,
        model,
        continueSession: true
    });

    const editorChild = editor.editFile(target.abs);

    let finalStatus = 0;

    const editorExit = new Promise((resolve) => {
        editorChild.on('exit', (code) => resolve(code ?? 0));
    });
    const opencodeExit = new Promise((resolve) => {
        if (opencodeChild) {
            opencodeChild.on('exit', (code) => resolve(code ?? 0));
        } else {
            resolve(1);
        }
    });

    const first = await Promise.race([
        editorExit.then((code) => ({ kind: 'editor', code })),
        opencodeExit.then((code) => ({ kind: 'opencode', code }))
    ]);

    if (first.kind === 'editor') {
        if (first.code !== 0) finalStatus = first.code;
        await ide.exit(opencodeChild);
        const opencodeCode = await opencodeExit;
        if (opencodeCode !== 0) finalStatus = opencodeCode;
    } else {
        finalStatus = first.code;
        console.log(
            'opencode connection closed; waiting for $EDITOR to exit (close it to continue).'
        );
        const editorCode = await editorExit;
        if (editorCode !== 0) finalStatus = editorCode;
    }

    console.log(
        '\n--- connection closed; session saved on the running server (resume with `make open`) ---'
    );
    if (startedHeadless) {
        console.log(
            'edit: started a background opencode server for this session; run `make open` to reattach, or stop it with `pkill -f "opencode serve"`.'
        );
    }

    if (finalStatus !== 0) {
        return exit(finalStatus);
    }

    if (git.statusPorcelain([rel]).length === 0) {
        console.log(`no changes to ${rel}.`);
        return exit(0);
    }

    const action = await cli.select(`opencode transformed ${rel}; how do you want to proceed?`, [
        { name: 'diff', message: 'Show the diff and commit' },
        { name: 'commit', message: 'Commit changes' },
        { name: 'discard', message: 'Discard opencode changes (git restore)' },
        { name: 'shell', message: 'Return to the shell' }
    ]);

    if (action === 'diff') {
        previewDiffFor(rel);
        return exit(0);
    }
    if (action === 'commit') {
        const commit = await git.git('commit');
        return exit(commit.status ?? 0);
    }
    if (action === 'discard') {
        const ok = await cli.confirm(`Discard changes to ${rel}? This is destructive.`, false);
        if (!ok) return exit(0);
        git.git('restore', ['--', rel], { stdio: 'inherit' });
        console.log(`restored ${rel} to HEAD.`);
        return exit(0);
    }
    return exit(0);
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

export { main };

export default {
    name: 'edit',
    description: meta.description,
    main: cli.run(meta, main)
};
