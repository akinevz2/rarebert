#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import Enquirer from 'enquirer';
import { PROJECT_ROOT, LIB_DIR, SCRIPTS_DIR, discoverScripts, getScriptMetadata, normalizeModuleName, runIDE } from '../lib/core.mjs';
import { relPath } from '../lib/libs.mjs';
import { readOpendeConfig, listModels, promptModel } from './implement.mjs';
import * as git from '../lib/git.mjs';

const DEFAULT_MODEL = 'ollama/glm-5.2:cloud';

function editFile(filePath) {
    const envEditor = process.env.EDITOR || 'nano';
    const [editor, ...maybeArgs] = envEditor.split(/\s+/).filter(Boolean);
    const editorFlags = process.env.EDITOR_FLAGS ? process.env.EDITOR_FLAGS.split(/\s+/).filter(Boolean) : [];
    const result = spawnSync(editor, [...maybeArgs, ...editorFlags, filePath], { stdio: 'inherit' });
    return result.status ?? 0;
}

function buildChoices(scripts, libs) {
    return [...scripts, ...libs].map(s => {
        const meta = getScriptMetadata(s.path);
        const label = `${s.name}${meta.description ? ' - ' + meta.description : ''}`;
        return { name: s.path, message: label };
    });
}

async function promptModule(scripts, libs, moduleArg) {
    const choices = buildChoices(scripts, libs);

    if (moduleArg) {
        const match = [...scripts, ...libs].find(s => normalizeModuleName(s.name) === normalizeModuleName(moduleArg));
        if (!match) {
            console.error(`Module not found: ${moduleArg}`);
            process.exit(1);
        }
        return match.path;
    }

    if (process.stdin.isTTY !== true) {
        console.error('Non-interactive; pass a module name as an argument.');
        process.exit(1);
    }

    const prompt = new Enquirer.AutoComplete({
        name: 'module',
        message: 'Select a module to open',
        limit: 12,
        choices,
        suggest(input) {
            const q = (input || '').toLowerCase().trim();
            if (!q) return choices;
            return choices.filter(c => c.message.toLowerCase().includes(q));
        }
    });

    try {
        return await prompt.run();
    } catch {
        console.error('\nAborted.');
        process.exit(130);
    }
}

async function main(args = []) {
    if (args.includes('--help') || args.includes('-h')) {
        console.error('open: Select a module, edit it in $EDITOR, run opencode on it, then stage changes');
        console.error('  Usage: node index.js open [--lib|--scripts] [module] [model]');
        console.error('  --lib       choose from modules in lib/');
        console.error('  --scripts   choose from modules in scripts/ (default)');
        console.error('  Lists modules with arrow-key navigation and search.');
        console.error('  Reads available models from opencode.json (or accepts one as an argument).');
        console.error('  Before exiting, runs `git add -A` to stage changes.');
        return;
    }

    const scanDirs = [LIB_DIR, SCRIPTS_DIR];
    const scripts = discoverScripts(scanDirs[0]);
    const libs = discoverScripts(scanDirs[1]);
    if (scripts.length === 0 && libs.length === 0) {
        console.error(`No modules found.`);
        process.exit(1);
    }

    const nonFlag = args.filter(a => !a.startsWith('-') && a);
    const moduleArg = nonFlag[0];
    const modelArg = nonFlag[1];

    const selected = await promptModule(scripts, libs, moduleArg);
    const rel = relPath(selected);

    if (!fs.existsSync(selected)) {
        console.error(`Module file not found: ${rel}`);
        process.exit(1);
    }

    let model = modelArg;
    if (!model) {
        const config = readOpendeConfig();
        const models = listModels(config);
        model = await promptModel(models, config.model || DEFAULT_MODEL);
    }

    const status = runIDE(model, rel);

    console.error(`Opening $EDITOR ${rel}`);
    const editStatus = editFile(selected);
    if (editStatus !== 0) {
        console.error(`Editor exited with status ${editStatus}`);
        process.exit(editStatus);
    }

    try {
        const r = git.add(['-A'], { stdio: 'inherit' });
        if (r.stdout) process.stdout.write(r.stdout);
        if (r.stderr) process.stderr.write(r.stderr);
    } catch (err) {
        console.error(`git: ${err.message}`);
    }

    process.exit(status ?? 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}

export {
    editFile,
    buildChoices,
    promptModule,
    main
};

export default {
    name: 'open',
    description: 'Select an existing module, edit it in $EDITOR, then run opencode on it',
    main
};