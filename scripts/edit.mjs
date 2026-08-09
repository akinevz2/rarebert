#!/usr/bin/env node

import fs from 'fs';
import { listAllModules, promptModule, resolveModule } from '../lib/modules.mjs';
import { editor } from '../lib/editor.mjs';
import { server } from '../lib/server.mjs';
import { exit } from '../lib/core.mjs';
import { git } from '../lib/git.mjs';
import { cli } from '../lib/cli.mjs';

const meta = {
    name: 'edit',
    description:
        'Edit a module in $EDITOR: start an attachable running opencode server (mini TUI); waits for the editor to close, then submits a review prompt to the server, and cleans up the server when the TUI closes',
    usage: 'node index.js edit [module]',
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
    let startedByEdit = false;
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
        startedByEdit = true;
    }

    const { child: opencodeChild } = server.spawnMini({
        url: running.url,
        port: running.port
    });

    let cleanedUp = false;
    const cleanupServer = () => {
        if (cleanedUp) return;
        if (!startedByEdit) return;
        cleanedUp = true;
        try {
            if (opencodeChild && !opencodeChild.killed) {
                try {
                    opencodeChild.kill('SIGTERM');
                } catch {
                    /* already gone */
                }
            }
            server.stop(running.pid);
            server.clearInfo();
        } catch (err) {
            console.error(`edit: cleanup error: ${err.message}`);
        }
    };
    cli.onAbort(cleanupServer);

    console.log(`edit: attached to server ${running.url} port=${running.port}`);
    console.log(
        `Opening $EDITOR ${rel} (close editor to submit review prompt; close TUI to terminate the server)`
    );

    const editorChild = editor.editFile(target.abs);

    const editorExited = new Promise((resolve) => {
        editorChild.on('exit', () => resolve());
    });
    const opencodeExited = new Promise((resolve) => {
        if (opencodeChild) {
            opencodeChild.on('exit', () => resolve());
        } else {
            resolve();
        }
    });

    console.log('edit: waiting for $EDITOR to close ...');
    await editorExited;

    console.log(`edit: $EDITOR closed; submitting review prompt for ${rel} to the server ...`);
    try {
        server.submitInstruction({
            url: running.url,
            port: running.port,
            prompt: `Reopen the file ${rel} and review the changes.`,
            file: rel
        });
    } catch (err) {
        console.error(`edit: failed to submit review prompt: ${err.message}`);
    }

    console.log('edit: waiting for opencode TUI to close ...');
    await opencodeExited;

    if (startedByEdit) {
        console.log('edit: TUI closed; cleaning up server ...');
        cleanupServer();
        console.log('--- connection closed; server terminated ---');
    } else {
        console.log('edit: TUI closed; pre-existing server left running.');
    }

    if (git.statusPorcelain([rel]).length === 0) {
        console.log(`no changes to ${rel}.`);
        return exit(0);
    }

    const diff = git.diffForPath(rel);
    console.log(diff);
    console.log('\n--- edited file ---');

    return exit(0);
}

export { main };

export default {
    name: 'edit',
    description: meta.description,
    main: cli.run(meta, main)
};
