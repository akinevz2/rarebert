import fs from 'fs';
import path from 'path';
import Enquirer from 'enquirer';
import { project } from './core.mjs';
import { AbortError } from './cli.mjs';

const OPENCODE_CONFIG = path.join(project.root, 'opencode.json');
const DEFAULT_MODEL = 'ollama/glm-5.2:cloud';

class Models {
    constructor() {
        this.configPath = OPENCODE_CONFIG;
        this.defaultModel = DEFAULT_MODEL;
    }

    readConfig() {
        if (!fs.existsSync(this.configPath)) return {};
        return JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
    }

    list(config) {
        const models = [];
        const defaultModel = config.model;
        const providers = config.provider || {};
        for (const [providerName, provider] of Object.entries(providers)) {
            for (const modelId of Object.keys(provider.models || {})) {
                const fullId = `${providerName}/${modelId}`;
                const meta = provider.models[modelId] || {};
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

    async prompt(models, fallback = this.defaultModel) {
        if (models.length === 0) {
            console.log(`No models found in opencode.json; using fallback: ${fallback}`);
            return fallback;
        }
        if (process.stdin.isTTY !== true) {
            const def = models.find((m) => m.isDefault) || models[0];
            console.log(`Non-interactive; using ${def.id}`);
            return def.id;
        }

        const choices = models.map((m) => ({
            name: m.id,
            message: `${m.name}${m.isDefault ? ' (default)' : ''}`
        }));
        const defaultIndex = Math.max(
            0,
            models.findIndex((m) => m.isDefault)
        );

        const prompt = new Enquirer.Select({
            name: 'model',
            message: 'Select a model to implement with',
            choices,
            initial: defaultIndex
        });

        try {
            return await prompt.run();
        } catch {
            throw new AbortError();
        }
    }

    async resolve(arg, env = process.env) {
        if (arg) return arg;
        if (env.MODEL) return env.MODEL;
        const config = this.readConfig();
        return await this.prompt(this.list(config), config.model);
    }
}

const models = new Models();
export { Models, models, DEFAULT_MODEL };
export default models;
