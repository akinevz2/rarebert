import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { home, rarebert } from './projects.mjs';
import { cli, AbortError, Interface } from './module.mjs';
import { store, exit } from './core.mjs';
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

    async promptBaseURL(initial = DEFAULT_BASE_URL) {
        const iface = Interface.createInterface('backend');
        return await iface.input('Ollama endpoint URL (OpenAI-compatible /v1):', {
            initial,
            validate: (v) => (/^https?:\/\//.test(v.trim()) ? true : 'Enter a full http(s):// URL')
        });
    }

    async promptModelIds(discovered) {
        const iface = Interface.createInterface('backend');
        if (discovered.length > 0) {
            const { default: Enquirer } = await import('enquirer');
            const choices = discovered.map((id) => ({ name: id, message: id }));
            choices.push({ name: '__custom__', message: 'Enter a model id manually' });

            const prompt = new Enquirer.MultiSelect({
                name: 'models',
                message: 'Select models to add (space to toggle, enter to confirm):',
                choices,
                initial: [0],
                limit: 12
            });
            try {
                const selected = await prompt.run();
                const ids = Array.isArray(selected) ? selected : [selected];
                const result = [];
                for (const id of ids) {
                    if (id === '__custom__') {
                        const custom = await iface.input(
                            'Model id (e.g. glm-5.2:cloud, llama3:latest):',
                            { validate: (v) => (v.trim() ? true : 'Model id is required') }
                        );
                        result.push(custom);
                    } else {
                        result.push(id);
                    }
                }
                return result.length > 0 ? result : discovered.slice(0, 1);
            } catch {
                throw new AbortError();
            }
        }
        const id = await iface.input('Model id (e.g. glm-5.2:cloud, llama3:latest):', {
            validate: (v) => (v.trim() ? true : 'Model id is required')
        });
        return [id];
    }

    async promptDefaultModel(modelIds) {
        if (modelIds.length === 1) return modelIds[0];
        const iface = Interface.createInterface('backend');
        const choices = modelIds.map((id) => ({ name: id, message: id }));
        return await iface.select('Which model should be the default?', choices, { initial: 0 });
    }

    /**
     * Optionally prompt for custom display names for each model. If the
     * user declines, all models use their id as the display name.
     */
    async promptModelDisplayNames(modelIds) {
        const models = modelIds.map((id) => ({ id, name: id }));
        if (modelIds.length === 0) return models;

        const iface = Interface.createInterface('backend');
        const giveNames = await iface.confirm('Give custom names to any of the models?', false);
        if (!giveNames) return models;

        for (const m of models) {
            const name = await iface.input(`Display name for ${m.id} (optional):`, {
                initial: m.id
            });
            m.name = name.trim() || m.id;
        }
        return models;
    }

    async runOnboard({ force = false } = {}) {
        if (!force && this.isConfigured()) return true;

        if (!cli.isInteractive()) {
            console.error(
                'onboard: opencode.json is not configured and stdin is not a TTY; ' +
                    'run `make onboard` in an interactive shell to configure.'
            );
            return false;
        }
        const iface = Interface.createInterface('backend');

        if (force && fs.existsSync(this.configPath)) {
            console.log('\n=== rarebert reconfigure ===');
            console.log('Reconfiguring existing opencode.json.\n');
        } else {
            console.log('\n=== rarebert onboarding ===');
            console.log("No usable opencode.json found. Let's configure a model.\n");
        }

        // Text input for the base URL. Empty accepts the default (or the
        // previously configured URL if reconfiguring); typing over provides
        // a new endpoint.
        const existingURL = this.getBaseURL();
        const initialURL = existingURL || DEFAULT_BASE_URL;
        const baseURLInput = await iface.input(`Ollama endpoint URL (empty = ${initialURL}):`, {
            initial: '',
            validate: (v) =>
                !v.trim() || /^https?:\/\//.test(v.trim())
                    ? true
                    : 'Enter a full http(s):// URL (or leave empty for default)'
        });
        const baseURL = baseURLInput.trim() || initialURL;

        console.log(`\nProbing ${baseURL}/models ...`);
        const discovered = this.fetchModels(baseURL);
        if (discovered.length > 0) {
            console.log(
                `  found ${discovered.length} model(s): ${discovered.slice(0, 5).join(', ')}${discovered.length > 5 ? ' ...' : ''}`
            );
        } else {
            // Endpoint unreachable — persist the base URL but no models.
            // Next time a model is needed, retry fetching from this URL.
            console.log('  no models returned (endpoint unreachable).');
            this.writePartialConfig(baseURL);
            console.log(`\n✓ Persisted base URL (${baseURL}) without models.`);
            console.log('  Start Ollama and re-run `make onboard` to complete configuration.');
            return false;
        }

        const modelIds = await this.promptModelIds(discovered);
        const defaultModelId = await this.promptDefaultModel(modelIds);
        const models = await this.promptModelDisplayNames(modelIds);

        const editorType = await this.promptEditorType();
        this.setEditorType(editorType);

        const cfg = this.buildConfig({
            provider: DEFAULT_PROVIDER,
            baseURL,
            models,
            defaultModelId
        });
        this.writeConfig(cfg);

        console.log(`\n✓ Wrote ${path.relative(home.root, this.configPath)}`);
        console.log(`  models:   ${models.map((m) => m.id).join(', ')}`);
        console.log(`  default:  ${cfg.model}`);
        console.log(`  endpoint: ${baseURL}`);
        console.log(`  editor:   ${editorType}`);
        console.log('\nRe-run `make onboard` any time to reconfigure.');
        return true;
    }

    /**
     * Non-interactive counterpart to runOnboard(). Writes opencode.jsonc
     * directly via buildConfig+writeConfig without any Enquirer prompts.
     * Probes baseURL for models; if the specified model is in the
     * discovered list it's used as defaultModelId, otherwise the config is
     * still written (the user explicitly asked for it). If baseURL is
     * unreachable (no models discovered), a partial config is written and
     * false is returned. Calls projectOnboard({ force }) to register the
     * current project.
     */
    async runOnboardNonInteractive({
        baseURL,
        model,
        provider = DEFAULT_PROVIDER,
        editorType = null,
        force = false
    } = {}) {
        if (!force && this.isConfigured()) return true;

        console.log(`\n=== rarebert onboarding (non-interactive) ===`);
        console.log(`  endpoint: ${baseURL}`);
        console.log(`  model:    ${model}`);
        console.log(`  provider: ${provider}`);
        if (editorType) console.log(`  editor:   ${editorType}`);

        console.log(`\nProbing ${baseURL}/models ...`);
        const discovered = this.fetchModels(baseURL);

        let models;
        let defaultModelId = model;

        if (discovered.length > 0) {
            console.log(
                `  found ${discovered.length} model(s): ${discovered.slice(0, 5).join(', ')}${discovered.length > 5 ? ' ...' : ''}`
            );
            if (discovered.includes(model)) {
                models = discovered.map((id) => ({ id, name: id }));
            } else {
                console.log(
                    `  specified model "${model}" not in discovered list; writing config anyway.`
                );
                models = [{ id: model, name: model }];
            }
        } else {
            // Endpoint unreachable — persist the base URL without models.
            console.log('  no models returned (endpoint unreachable).');
            this.writePartialConfig(baseURL);
            console.log(`\n✓ Persisted base URL (${baseURL}) without models.`);
            console.log('  Start Ollama and re-run onboard to complete configuration.');
            return false;
        }

        if (editorType) this.setEditorType(editorType);

        const cfg = this.buildConfig({
            provider,
            baseURL,
            models,
            defaultModelId
        });
        this.writeConfig(cfg);

        console.log(`\n✓ Wrote ${path.relative(home.root, this.configPath)}`);
        console.log(`  models:   ${models.map((m) => m.id).join(', ')}`);
        console.log(`  default:  ${cfg.model}`);
        console.log(`  endpoint: ${baseURL}`);
        if (editorType) console.log(`  editor:   ${editorType}`);

        const projectOk = await this.projectOnboard({ force });
        if (!projectOk) {
            console.error('onboard: project registration failed.');
            return false;
        }

        console.log('\nRe-run `make onboard` any time to reconfigure.');
        return true;
    }

    /**
     * Ask whether the user's $EDITOR is a terminal-based editor (nano, vim,
     * etc.) or a graphical one (code, subl, ...). Persisted in the SQLite
     * store (projects.editor_type under home.root) so `make open` knows
     * whether to launch the opencode TUI in parallel (graphical) or await
     * the editor's exit + a confirm before launching (terminal — the editor
     * needs the TTY to itself).
     */
    async promptEditorType(initial = null) {
        const existing = initial ?? this.getEditorType();
        const choices = [
            { name: 'graphical', message: 'Graphical (code, subl, cursor, ...)' },
            { name: 'terminal', message: 'Terminal (nano, vim, vi, micro, ...)' }
        ];
        const initialIdx = existing === 'terminal' ? 1 : 0;
        const iface = Interface.createInterface('backend');
        const choice = await iface.select(
            'Is your $EDITOR a graphical or terminal editor?',
            choices,
            { initial: initialIdx }
        );
        return choice;
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
     * Complete a partial config (base URL already persisted, endpoint
     * now online) by prompting for model selection and writing the full
     * config. Called by ensureConfig when models become available.
     */
    async completeConfig(baseURL, discovered) {
        console.log('\n=== rarebert completing configuration ===\n');

        const modelIds = await this.promptModelIds(discovered);
        const defaultModelId = await this.promptDefaultModel(modelIds);
        const models = await this.promptModelDisplayNames(modelIds);
        const editorType = await this.promptEditorType();
        this.setEditorType(editorType);

        const cfg = this.buildConfig({
            provider: DEFAULT_PROVIDER,
            baseURL,
            models,
            defaultModelId
        });
        this.writeConfig(cfg);

        console.log(`\n✓ Wrote ${path.relative(home.root, this.configPath)}`);
        console.log(`  models:   ${models.map((m) => m.id).join(', ')}`);
        console.log(`  default:  ${cfg.model}`);
        console.log(`  endpoint: ${baseURL}`);
        console.log(`  editor:   ${editorType}`);
        return true;
    }

    /**
     * Emit a diagnostic to stderr unless suppressed by the `quiet` option
     * (see ensureAll). Existing callers are unaffected: quiet defaults to
     * false, so warn() behaves exactly like console.error for them.
     */
    warn(message) {
        if (!this._quiet) console.error(message);
    }

    async ensureConfig({ force = false } = {}) {
        if (force) return this.runOnboard({ force: true });
        if (this.isConfigured()) return true;

        // Non-interactive guard: onboarding is inherently a TUI flow, so
        // in a non-interactive environment bail out immediately with a
        // clear message instead of blocking on prompts (or crashing inside
        // Enquirer). The caller decides whether to continue without a
        // configured backend.
        if (!cli.isInteractive()) {
            this.warn(
                'onboard: opencode.json is not configured and stdin is not a TTY; ' +
                    'run `make onboard` in an interactive shell to configure.'
            );
            return false;
        }

        // Partial config: base URL persisted but no models (endpoint was
        // unreachable last time). Retry fetching models from the
        // persisted base URL — if it's now online, complete the config;
        // if still unreachable, error out.
        if (this.hasPendingModels()) {
            const baseURL = this.getBaseURL();
            if (!baseURL) return this.runOnboard({ force: false });

            console.log(`onboard: retrying ${baseURL}/models ...`);
            const discovered = this.fetchModels(baseURL);
            if (discovered.length === 0) {
                console.error(
                    `onboard: Ollama at ${baseURL} is still unreachable.\n` +
                        'Start Ollama and re-run `make onboard` to complete configuration.'
                );
                return false;
            }

            // Endpoint is now online — complete the config interactively.
            console.log(`  found ${discovered.length} model(s).`);
            if (!cli.isInteractive()) {
                this.warn(
                    'onboard: models found but stdin is not a TTY; run `make onboard` interactively.'
                );
                return false;
            }
            return this.completeConfig(baseURL, discovered);
        }

        return this.runOnboard({ force: false });
    }

    async onboard(args = []) {
        const force = args.includes('--force') || args.includes('-f') || args.length === 0;
        const ok = await this.runOnboard({ force });
        if (!ok && !cli.isInteractive()) return exit('backend configuration failed');
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
     * Run per-project onboarding for the current working directory.
     * Scans for module-containing folders, prompts the user to mark
     * which ones rarebert should track, and registers them in the
     * SQLite store. Skips silently when the project is already
     * onboarded (unless force).
     */
    async projectOnboard({ force = false } = {}) {
        const cwd = rarebert.root;

        if (store.isOnboarded(cwd) && !force) return true;

        // Don't onboard rarebert's own install via this flow.
        if (cwd === home.root) return true;

        if (!cli.isInteractive()) {
            this.warn(
                `onboard: project "${cwd}" is not registered with rarebert.\n` +
                    'Run `rarebert onboard` in an interactive shell to mark module folders.'
            );
            return false;
        }

        console.log('\n=== rarebert project onboarding ===\n');
        console.log(`Scanning ${cwd} for module-containing folders...`);

        const candidates = this.scanCandidateFolders(cwd);
        if (candidates.length === 0) {
            console.log('No module-containing folders found; nothing to register.');
            store.registerProject(cwd);
            store.markOnboarded(cwd);
            return true;
        }

        console.log(`Found ${candidates.length} candidate folder(s):\n`);
        candidates.forEach((c, i) => {
            console.log(
                `  ${i + 1}. ${c.name}/  (${c.fileCount} module file${c.fileCount === 1 ? '' : 's'}, ${c.exts.join(', ')})`
            );
        });
        console.log();

        const choices = candidates.map((c) => ({
            name: c.rel,
            message: `${c.name}/  (${c.fileCount} files, ${c.exts.join(', ')})`
        }));

        let selected;
        try {
            const { default: Enquirer } = await import('enquirer');
            const prompt = new Enquirer.MultiSelect({
                name: 'folders',
                message:
                    'Mark the folders rarebert should track (space to toggle, enter to confirm):',
                choices,
                initial: choices.map((c) => c.name),
                result(names) {
                    return Array.isArray(names) ? names : [names];
                }
            });
            selected = await prompt.run();
            selected = Array.isArray(selected) ? selected : [selected];
        } catch {
            throw new AbortError();
        }

        if (selected.length === 0) {
            console.log('No folders selected; registering project with no module folders.');
            store.registerProject(cwd);
            store.markOnboarded(cwd);
            return true;
        }

        // Build folder descriptors from the selection.
        const folders = selected.map((rel) => {
            const candidate = candidates.find((c) => c.rel === rel);
            return {
                rel,
                key: rel,
                exts: candidate ? candidate.exts : ['.mjs', '.js'],
                label: `${rel}/  (registered)`
            };
        });

        const project = store.registerProject(cwd);
        store.setFolders(project.id, folders);
        store.markOnboarded(cwd);

        // No reload() needed — rarebert.discover() is lazily evaluated
        // and will pick up the registered folders on the next read.

        console.log(`\n✓ Registered ${folders.length} folder(s) for ${cwd}`);
        folders.forEach((f) => console.log(`  - ${f.rel}/  (${f.exts.join(', ')})`));
        return true;
    }

    /**
     * Ensure both the opencode config and the per-project registration
     * are complete. Called by the dispatcher before running any module.
     *
     * Options:
     *   - skip:  when true, return true immediately without touching the
     *     config or the store. Lets a caller pass its own skip decision
     *     (e.g. the Dispatcher's onboarding guard) instead of duplicating
     *     command-name knowledge on both sides.
     *   - quiet: when true, suppress the stderr diagnostics emitted by the
     *     non-interactive guard paths in ensureConfig and projectOnboard
     *     (routed through warn()).
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
            return await this.projectOnboard();
        } finally {
            this._quiet = false;
        }
    }
}

const backend = new Backend();
export { Backend, backend };
export default backend;
