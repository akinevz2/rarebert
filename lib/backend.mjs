import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { home, rarebert } from './projects.mjs';
import { store } from './core.mjs';
import { stripJsonc } from './models.mjs';

const OPENCODE_CONFIG = path.join(home.root, 'opencode.jsonc');
const DEFAULT_BASE_URL = 'http://localhost:11434/v1';
const DEFAULT_PROVIDER = 'ollama';
const DEFAULT_PROVIDER_NPM = '@ai-sdk/openai-compatible';
const DEFAULT_PROVIDER_NAME = 'Ollama (local)';

const MODULE_EXTS = [
    '.mjs',
    '.js',
    '.ts',
    '.tsx',
    '.jsx',
    '.py',
    '.rb',
    '.go',
    '.rs',
    '.java',
    '.kt',
    '.cs'
];

const IGNORED = new Set([
    'node_modules',
    'dist',
    'build',
    '.git',
    'vendor',
    'target',
    'bin',
    'obj',
    '__pycache__',
    '.venv',
    'venv'
]);

class Backend {
    constructor() {
        this.configPath = OPENCODE_CONFIG;
        // Set transiently by ensureAll({ quiet }) to suppress the stderr
        // diagnostics in the non-interactive guard paths (see warn()).
        this._quiet = false;
    }

    readConfig() {
        if (!fs.existsSync(this.configPath)) return null;
        try {
            // opencode.jsonc permits JSONC syntax (comments + trailing
            // commas). Strip those before JSON.parse so we read configs
            // that strict JSON.parse would reject.
            return JSON.parse(stripJsonc(fs.readFileSync(this.configPath, 'utf-8')));
        } catch {
            return null;
        }
    }

    isConfigured() {
        const cfg = this.readConfig();
        if (!cfg) return false;
        if (!cfg.model || typeof cfg.model !== 'string') return false;
        const providers = cfg.provider;
        if (!providers || typeof providers !== 'object') return false;
        const [providerName, provider] = Object.entries(providers)[0] || [];
        if (!providerName || !provider) return false;
        if (!provider.options?.baseURL && !provider.baseURL) return false;
        const models = provider.models;
        if (!models || Object.keys(models).length === 0) return false;
        return true;
    }

    /**
     * Check if a base URL is persisted but no models are configured —
     * meaning the endpoint was unreachable during onboarding and the
     * user should be re-prompted to complete model selection.
     */
    hasPendingModels() {
        const cfg = this.readConfig();
        if (!cfg) return false;
        const providers = cfg.provider;
        if (!providers || typeof providers !== 'object') return false;
        const [, provider] = Object.entries(providers)[0] || [];
        if (!provider) return false;
        if (!provider.options?.baseURL && !provider.baseURL) return false;
        const models = provider.models;
        return !models || Object.keys(models).length === 0;
    }

    /**
     * Extract the persisted base URL from an existing config.
     */
    getBaseURL() {
        const cfg = this.readConfig();
        if (!cfg) return null;
        const providers = cfg.provider;
        if (!providers) return null;
        const [, provider] = Object.entries(providers)[0] || [];
        if (!provider) return null;
        return provider.options?.baseURL || provider.baseURL || null;
    }

    fetchModels(baseURL, timeoutMs = 3000) {
        const url = baseURL.replace(/\/$/, '') + '/models';
        try {
            const result = spawnSync(
                process.execPath,
                [
                    '-e',
                    `fetch(${JSON.stringify(url)}).then(r=>r.json()).then(j=>process.stdout.write(JSON.stringify(j.data||j.models||[]))).catch(()=>process.exit(1))`
                ],
                { encoding: 'utf-8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] }
            );
            if (result.status !== 0 || !result.stdout) return [];
            const parsed = JSON.parse(result.stdout);
            if (!Array.isArray(parsed)) return [];
            return parsed.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
        } catch {
            return [];
        }
    }

    buildConfig({ provider, baseURL, models, defaultModelId }) {
        const providerName = provider || DEFAULT_PROVIDER;
        const modelsObj = {};
        for (const { id, name } of models) {
            modelsObj[id] = { name: name || id };
        }
        return {
            $schema: 'https://opencode.ai/config.json',
            instructions: ['AGENTS.md'],
            model: `${providerName}/${defaultModelId || models[0].id}`,
            provider: {
                [providerName]: {
                    npm: DEFAULT_PROVIDER_NPM,
                    name: DEFAULT_PROVIDER_NAME,
                    options: { baseURL },
                    models: modelsObj
                }
            }
        };
    }

    writeConfig(cfg) {
        fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 4) + '\n');
    }

    /**
     * Write a partial config with just the base URL and no models.
     * Used when the endpoint is unreachable so the base URL is
     * persisted for retry on the next run.
     */
    writePartialConfig(baseURL) {
        const cfg = {
            $schema: 'https://opencode.ai/config.json',
            instructions: ['AGENTS.md'],
            model: '',
            provider: {
                [DEFAULT_PROVIDER]: {
                    npm: DEFAULT_PROVIDER_NPM,
                    name: DEFAULT_PROVIDER_NAME,
                    options: { baseURL },
                    models: {}
                }
            }
        };
        this.writeConfig(cfg);
    }

    /**
     * Read the persisted editor-type preference ('graphical' or 'terminal')
     * from the SQLite store, keyed by rarebert's install root (home.root) —
     * the same key under which the opencode.jsonc config lives. Returns null
     * if unset or the store is unavailable.
     */
    getEditorType() {
        try {
            return store.getEditorType(home.root);
        } catch {
            return null;
        }
    }

    /**
     * Persist the editor-type preference to the SQLite store under
     * home.root so `make open` can read it without touching opencode.jsonc.
     */
    setEditorType(editorType) {
        try {
            store.registerProject(home.root);
            store.setEditorType(home.root, editorType);
        } catch {
            /* store unavailable — non-fatal */
        }
    }

    /**
     * Emit a diagnostic to stderr unless suppressed by the `quiet` option
     * (see ensureAll). Existing callers are unaffected: quiet defaults to
     * false, so warn() behaves exactly like console.error for them.
     */
    warn(message) {
        if (!this._quiet) console.error(message);
    }

    /**
     * Ensure opencode.jsonc is usable. NEVER prompts: lib/ performs data
     * transformations only, so when the config is missing or incomplete
     * this returns false with stderr guidance directing the user to the
     * interactive onboarding flow (`make onboard` / `node index.js onboard`,
     * orchestrated in scripts/onboard.mjs).
     */
    async ensureConfig() {
        if (this.isConfigured()) return true;

        // Partial config: base URL persisted but no models (endpoint was
        // unreachable last time). Retry fetching models from the persisted
        // base URL — completing the configuration itself is an interactive
        // flow, so on any non-configured outcome we return false with
        // guidance instead of prompting.
        if (this.hasPendingModels()) {
            const baseURL = this.getBaseURL();
            if (!baseURL) {
                this.warn(
                    'onboard: opencode.json is not configured; ' +
                        'run `make onboard` (or `node index.js onboard`) to configure.'
                );
                return false;
            }

            console.log(`onboard: retrying ${baseURL}/models ...`);
            const discovered = this.fetchModels(baseURL);
            if (discovered.length === 0) {
                console.error(
                    `onboard: Ollama at ${baseURL} is still unreachable.\n` +
                        'Start Ollama and re-run `make onboard` to complete configuration.'
                );
                return false;
            }

            // Endpoint is now online, but completing the config requires
            // the interactive onboarding flow — never prompt from lib/.
            console.log(`  found ${discovered.length} model(s).`);
            this.warn(
                'onboard: models found but completing configuration requires the ' +
                    'interactive flow; run `make onboard` (or `node index.js onboard`).'
            );
            return false;
        }

        this.warn(
            'onboard: opencode.json is not configured; ' +
                'run `make onboard` (or `node index.js onboard`) to configure.'
        );
        return false;
    }

    // -----------------------------------------------------------------------
    // Per-project onboarding — register external projects in the SQLite
    // store so rarebert knows which folders contain modules.
    // -----------------------------------------------------------------------

    /**
     * Scan the project root for top-level directories that contain at
     * least one file with a known module extension. Returns an array
     * of { name, rel, fileCount, exts } sorted by file count desc.
     */
    scanCandidateFolders(root) {
        if (!fs.existsSync(root)) return [];
        const top = fs
            .readdirSync(root, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .filter((e) => !e.name.startsWith('.'))
            .filter((e) => !IGNORED.has(e.name))
            .map((e) => e.name)
            .sort();

        const candidates = [];
        for (const name of top) {
            const dir = path.join(root, name);
            const files = this.scanModuleFiles(dir);
            if (files.length > 0) {
                const exts = [...new Set(files.map((f) => path.extname(f)))].sort();
                candidates.push({ name, rel: name, fileCount: files.length, exts });
            }
        }
        return candidates.sort((a, b) => b.fileCount - a.fileCount);
    }

    /**
     * Recursively scan a directory for files with known module
     * extensions, up to a depth of 2. Returns an array of file paths.
     */
    scanModuleFiles(dir, depth = 0) {
        if (depth > 2 || !fs.existsSync(dir)) return [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const files = [];
        for (const e of entries) {
            if (e.isFile()) {
                const ext = path.extname(e.name).toLowerCase();
                if (MODULE_EXTS.includes(ext)) files.push(path.join(dir, e.name));
            } else if (e.isDirectory() && !e.name.startsWith('.') && !IGNORED.has(e.name)) {
                files.push(...this.scanModuleFiles(path.join(dir, e.name), depth + 1));
            }
        }
        return files;
    }

    /**
     * Pure data op: register the project at `cwd` and persist its tracked
     * folders, marking it onboarded. No prompting — the interactive folder
     * selection lives in scripts/onboard.mjs (projectOnboard).
     */
    registerFolders(cwd, folders) {
        const project = store.registerProject(cwd);
        store.setFolders(project.id, folders);
        store.markOnboarded(cwd);
    }

    /**
     * Ensure both the opencode config and the per-project registration
     * are complete. Called by the dispatcher before running any module.
     *
     * NEVER prompts (lib purity — interactive onboarding lives exclusively
     * in scripts/onboard.mjs):
     *   - config check: delegates to ensureConfig, which returns false
     *     with stderr guidance when the config is missing/incomplete.
     *   - project check: a pure store read (store.isOnboarded) — no folder
     *     scanning, no prompting. An unregistered project returns false
     *     with guidance.
     *
     * Options:
     *   - skip:  when true, return true immediately without touching the
     *     config or the store. Lets a caller pass its own skip decision
     *     (e.g. the Dispatcher's onboarding guard) instead of duplicating
     *     command-name knowledge on both sides.
     *   - quiet: when true, suppress the stderr diagnostics emitted by the
     *     guard paths (routed through warn()).
     *
     * The Dispatcher (index.js) is the primary caller. Called with no
     * arguments the behavior is identical to the pre-options version.
     */
    async ensureAll({ skip = false, quiet = false } = {}) {
        if (skip) return true;
        this._quiet = quiet;
        try {
            const configOk = await this.ensureConfig();
            if (!configOk) return false;

            const cwd = rarebert.root;
            // Don't require onboarding for rarebert's own install.
            if (cwd === home.root) return true;
            if (store.isOnboarded(cwd)) return true;
            this.warn(
                `onboard: project "${cwd}" is not registered with rarebert.\n` +
                    'Run `node index.js onboard` in an interactive shell to mark module folders.'
            );
            return false;
        } finally {
            this._quiet = false;
        }
    }
}

const backend = new Backend();
export { Backend, backend, DEFAULT_BASE_URL, DEFAULT_PROVIDER };
export default backend;
