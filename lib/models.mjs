import fs from 'fs';
import path from 'path';
import { home } from './projects.mjs';
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
        this.defaultModelFallback = DEFAULT_MODEL;
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
        return this.defaultModel();
    }

    /**
     * Resolve the default model from the opencode config. Prefers the
     * top-level `model` field in opencode.json/jsonc; if absent or empty,
     * falls back to the first provider's first model (sorted by insertion
     * order). This ensures a local ollama model is always chosen as the
     * default when onboarded through rarebert, without relying on the
     * SQLite store or interactive prompts. Returns DEFAULT_MODEL if no
     * config or providers exist.
     */
    defaultModel() {
        const cfg = this.readConfig();
        if (cfg.model && typeof cfg.model === 'string') return cfg.model;
        const providers = cfg.provider || {};
        const entries = Object.entries(providers);
        if (entries.length === 0) return this.defaultModelFallback;
        const [providerName, provider] = entries[0];
        const modelIds = Object.keys(provider.models || {});
        if (modelIds.length === 0) return this.defaultModelFallback;
        return `${providerName}/${modelIds[0]}`;
    }

    /**
     * Validate that a model id exists in the opencode config. Returns
     * null if valid, or an error string if the provider or model is not
     * found. Used by ide.spawnHeadless and server.startFullTUI to fail
     * early with a clear message before launching opencode.
     */
    validateModel(modelId) {
        if (!modelId || typeof modelId !== 'string') {
            return 'No model specified.';
        }
        const slashIdx = modelId.indexOf('/');
        if (slashIdx === -1) {
            return `Invalid model id "${modelId}": expected format "provider/model".`;
        }
        const providerName = modelId.slice(0, slashIdx);
        const modelKey = modelId.slice(slashIdx + 1);
        const cfg = this.readConfig();
        const providers = cfg.provider || {};
        const provider = providers[providerName];
        if (!provider) {
            const available = Object.keys(providers).join(', ');
            return `Provider "${providerName}" not found in opencode.json. Available providers: ${available || '(none)'}`;
        }
        const modelIds = Object.keys(provider.models || {});
        if (!modelIds.includes(modelKey)) {
            return `Model "${modelKey}" not found under provider "${providerName}" in opencode.json. Available models: ${modelIds.join(', ') || '(none)'}`;
        }
        return null;
    }

    /**
     * Build the select-prompt data for a model list: the `{ name, message }`
     * choices array plus the initial (default) index. Pure data transform —
     * the caller owns any prompt construction (lib purity: no prompts
     * are created inside lib/).
     */
    modelChoices(models) {
        const choices = models.map((m) => ({
            name: m.id,
            message: `${m.name}${m.isDefault ? ' (default)' : ''}`
        }));
        const defaultIndex = Math.max(
            0,
            models.findIndex((m) => m.isDefault)
        );
        return { choices, defaultIndex };
    }

    /**
     * Resolve a model id without prompting: explicit arg > MODEL env var >
     * last-chosen store preference (which itself falls back to the config
     * default). The interactive selection that used to live here moved to
     * the script layer (see scripts/implement.mjs#selectModel) — lib/
     * never constructs a prompt.
     */
    async resolve(arg, env = process.env) {
        if (arg) return arg;
        if (env.MODEL) return env.MODEL;
        const modelId = this.lastChosenModel();
        this.persistDefault(modelId);
        return modelId;
    }

    /**
     * Resolve the default model non-interactively. This is the canonical
     * way to get a model id for headless/automated opencode invocations:
     * no prompts, no TTY checks. Returns the last-chosen model from the
     * store if set, otherwise the config-derived default.
     */
    resolveDefault() {
        const lastChosen = this.lastChosenModel();
        if (lastChosen) return lastChosen;
        return this.defaultModel();
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
