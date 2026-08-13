import fs from 'fs';
import path from 'path';
import Enquirer from 'enquirer';
import { home } from './projects.mjs';
import { AbortError } from './module.mjs';

const OPENCODE_CONFIG = path.join(home.root, 'opencode.json');
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
        let modelId;
        let fromInteractive = false;
        if (arg) {
            modelId = arg;
        } else if (env.MODEL) {
            modelId = env.MODEL;
        } else {
            const config = this.readConfig();
            modelId = await this.prompt(this.list(config), config.model);
            fromInteractive = true;
        }

        // Only persist the default when the model was chosen via the
        // interactive TUI — not when passed as a CLI arg or env var
        // (those are explicit overrides, not a preference change).
        if (fromInteractive) {
            this.persistDefault(modelId);
        }

        return modelId;
    }

    /**
     * Write `modelId` back to opencode.json as the default model. Silently
     * skips if there's no config, no provider, or the model is already the
     * default. This makes the last-selected model the default for the
     * next invocation.
     */
    persistDefault(modelId) {
        if (!modelId || !fs.existsSync(this.configPath)) return;
        let config;
        try {
            config = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
        } catch {
            return;
        }
        if (!config.provider || typeof config.provider !== 'object') return;
        if (config.model === modelId) return;

        // Verify the model exists in a provider before setting it as
        // default — don't persist a model that isn't configured.
        const [providerName, modelName] = modelId.includes('/')
            ? modelId.split('/')
            : [Object.keys(config.provider)[0], modelId];
        const provider = config.provider[providerName];
        if (!provider || !provider.models || !provider.models[modelName]) return;

        config.model = modelId;
        try {
            fs.writeFileSync(this.configPath, JSON.stringify(config, null, 4) + '\n');
        } catch {
            /* read-only or missing — silently skip */
        }
    }
}

const models = new Models();
export { Models, models, DEFAULT_MODEL };
export default models;
