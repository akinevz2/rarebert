import fs from 'fs';
import path from 'path';
import Enquirer from 'enquirer';
import { home } from './projects.mjs';
import { AbortError } from './module.mjs';
import { store } from './core.mjs';

const CONFIG_TRY_PATHS = ['opencode.jsonc', 'opencode.json'];
const DEFAULT_MODEL = 'ollama/glm-5.2:cloud';

/**
 * Strip JSONC-only syntax (line and block comments, trailing commas before
 * `}` or `]`) so node's strict JSON.parse accepts opencode.jsonc files.
 * Best-effort: doesn't handle comments inside string literals.
 */
function stripJsonc(raw) {
    let out = '';
    let i = 0;
    const n = raw.length;
    while (i < n) {
        const ch = raw[i];
        const next = raw[i + 1];
        // Line comment
        if (ch === '/' && next === '/') {
            const end = raw.indexOf('\n', i);
            i = end === -1 ? n : end;
            continue;
        }
        // Block comment
        if (ch === '/' && next === '*') {
            const end = raw.indexOf('*/', i + 2);
            i = end === -1 ? n : end + 2;
            continue;
        }
        // String literal — copy verbatim (skip comment detection inside)
        if (ch === '"' || ch === "'" || ch === '`') {
            const quote = ch;
            out += ch;
            i++;
            while (i < n) {
                const c = raw[i];
                out += c;
                if (c === '\\' && i + 1 < n) {
                    out += raw[i + 1];
                    i += 2;
                    continue;
                }
                i++;
                if (c === quote) break;
            }
            continue;
        }
        out += ch;
        i++;
    }
    // Remove trailing commas before } or ]
    return out.replace(/,\s*([}\]])/g, '$1');
}

class Models {
    constructor() {
        this.configDir = home.root;
        this.defaultModel = DEFAULT_MODEL;
    }

    /**
     * Resolve the opencode config file path (opencode.jsonc preferred,
     * opencode.json fallback). Returns null when none exists.
     */
    configPath() {
        for (const rel of CONFIG_TRY_PATHS) {
            const abs = path.join(this.configDir, rel);
            if (fs.existsSync(abs)) return abs;
        }
        return null;
    }

    readConfig() {
        const abs = this.configPath();
        if (!abs) return {};
        try {
            const raw = fs.readFileSync(abs, 'utf-8');
            // opencode.jsonc permits JSONC syntax (comments + trailing
            // commas). node's JSON.parse rejects both — strip trailing
            // commas before object/array closes and strip // and /* */
            // comments so the config parses cleanly.
            return JSON.parse(stripJsonc(raw));
        } catch {
            return {};
        }
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

    /**
     * Return the last-chosen model id from the SQLite store, falling back
     * to the config's `model` field, then to DEFAULT_MODEL. The store is
     * the source of truth because opencode does not reliably honor the
     * `model` field in its config.
     */
    lastChosenModel() {
        try {
            const stored = store.getLastModel(home.root);
            if (stored) return stored;
        } catch {
            /* store unavailable */
        }
        const cfg = this.readConfig();
        return cfg.model || this.defaultModel;
    }

    async prompt(models, fallback = this.defaultModel) {
        if (models.length === 0) {
            console.log(`No models found in opencode config; using fallback: ${fallback}`);
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
            // Prefer the last-chosen model from the store as the default
            // selection in the interactive prompt.
            const lastChosen = this.lastChosenModel();
            if (lastChosen && config.model !== lastChosen) {
                config.model = lastChosen;
            }
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
     * Persist `modelId` as the last-chosen model in the SQLite store under
     * home.root. This is the source of truth for the next invocation's
     * default model selection — opencode does not reliably honor the
     * `model` field in its config, so we keep the preference in rarebert.db.
     * Silently skips if the store is unavailable or the model is unchanged.
     */
    persistDefault(modelId) {
        if (!modelId) return;
        try {
            const current = store.getLastModel(home.root);
            if (current === modelId) return;
            store.registerProject(home.root);
            store.setLastModel(home.root, modelId);
        } catch {
            /* store unavailable — silently skip */
        }
    }
}

const models = new Models();
export { Models, models, DEFAULT_MODEL, stripJsonc };
export default models;
