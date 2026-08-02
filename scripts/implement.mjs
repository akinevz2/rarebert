#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import Enquirer from 'enquirer';
import { PROJECT_ROOT, normalizeModuleName } from '../lib/core.mjs';

const LAST_MODULE_FILE = path.join(PROJECT_ROOT, '.last-module');
const OPENCODE_CONFIG = path.join(PROJECT_ROOT, 'opencode.json');
const DEFAULT_MODEL = 'ollama/glm-5.2:cloud';

function readLastModule() {
    if (!fs.existsSync(LAST_MODULE_FILE)) return null;
    const rel = fs.readFileSync(LAST_MODULE_FILE, 'utf-8').trim();
    return rel || null;
}

function readOpendeConfig() {
    if (!fs.existsSync(OPENCODE_CONFIG)) return {};
    return JSON.parse(fs.readFileSync(OPENCODE_CONFIG, 'utf-8'));
}

function listModels(config) {
    const models = [];
    const defaultModel = config.model;
    const providers = config.provider || {};
    for (const [providerName, provider] of Object.entries(providers)) {
        const providerModels = provider.models || {};
        for (const modelId of Object.keys(providerModels)) {
            const fullId = `${providerName}/${modelId}`;
            const meta = providerModels[modelId] || {};
            models.push({
                id: fullId,
                name: meta.name || modelId,
                isDefault: fullId === defaultModel
            });
        }
    }
    if (models.length === 0 && defaultModel) {
        models.push({ id: defaultModel, name: defaultModel, isDefault: true });
    }
    return models;
}

async function promptModel(models, fallback) {
    if (models.length === 0) {
        console.error(`No models found in opencode.json; using fallback: ${fallback}`);
        return fallback;
    }
    if (process.stdin.isTTY !== true) {
        const def = models.find(m => m.isDefault) || models[0];
        console.error(`Non-interactive; using ${def.id}`);
        return def.id;
    }

    const choices = models.map(m => ({
        name: m.id,
        message: `${m.name}${m.isDefault ? ' (default)' : ''}`
    }));
    const defaultIndex = Math.max(0, models.findIndex(m => m.isDefault));

    const prompt = new Enquirer.Select({
        name: 'model',
        message: 'Select a model to implement with',
        choices,
        initial: defaultIndex
    });

    try {
        return await prompt.run();
    } catch {
        console.error('\nAborted.');
        process.exit(130);
    }
}

function runOpende(model, file) {
    const message = `Implement the module in ${file}`;
    const args = ['run', message, '-m', model, '--file', file];
    console.error(`$ opencode ${args.join(' ')}`);
    const result = spawnSync('opencode', args, { stdio: 'inherit', cwd: PROJECT_ROOT });
    if (result.error) {
        console.error(`Failed to launch opencode: ${result.error.message}`);
        process.exit(1);
    }
    return result.status;
}

async function main(args = []) {
    if (args.includes('--help') || args.includes('-h')) {
        console.error('implement: Implement the last-created module using an opencode model');
        console.error('  Usage: node index.js implement [model]');
        console.error('  Reads the target path from .last-module and prompts for a model');
        console.error('  listed in opencode.json (or accepts one as an argument).');
        return;
    }

    const file = readLastModule();
    if (!file) {
        console.error('No module to implement. Run `make add` first to scaffold a module.');
        process.exit(1);
    }

    const absFile = path.isAbsolute(file) ? file : path.join(PROJECT_ROOT, file);
    if (!fs.existsSync(absFile)) {
        console.error(`Module file not found: ${file}`);
        process.exit(1);
    }

    let model = args.find(a => !a.startsWith('-') && a);
    if (!model) {
        const config = readOpendeConfig();
        const models = listModels(config);
        model = await promptModel(models, config.model || DEFAULT_MODEL);
    }

    const status = runOpende(model, file);
    process.exit(status ?? 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}

export {
    readLastModule,
    readOpendeConfig,
    listModels,
    promptModel,
    runOpende,
    main
};

export default {
    name: 'implement',
    description: 'Implement the last-created module via opencode',
    main
};