import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { PROJECT_ROOT } from './core.mjs';
import { isInteractive, confirm, input, select } from './cli.mjs';

const OPENCODE_CONFIG = path.join(PROJECT_ROOT, 'opencode.json');
const DEFAULT_BASE_URL = 'http://localhost:11434/v1';
const DEFAULT_PROVIDER = 'ollama';
const DEFAULT_PROVIDER_NPM = '@ai-sdk/openai-compatible';
const DEFAULT_PROVIDER_NAME = 'Ollama (local)';

class Backend {
    constructor() {
        this.configPath = OPENCODE_CONFIG;
    }

    readConfig() {
        if (!fs.existsSync(this.configPath)) return null;
        try {
            return JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
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

    buildConfig({ provider, baseURL, modelId, modelName }) {
        const providerName = provider || DEFAULT_PROVIDER;
        return {
            $schema: 'https://opencode.ai/config.json',
            instructions: ['AGENTS.md'],
            model: `${providerName}/${modelId}`,
            provider: {
                [providerName]: {
                    npm: DEFAULT_PROVIDER_NPM,
                    name: DEFAULT_PROVIDER_NAME,
                    options: { baseURL },
                    models: {
                        [modelId]: { name: modelName || modelId }
                    }
                }
            }
        };
    }

    writeConfig(cfg) {
        fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 4) + '\n');
    }

    async promptBaseURL(initial = DEFAULT_BASE_URL) {
        return await input('Ollama endpoint URL (OpenAI-compatible /v1):', {
            initial,
            validate: (v) => (/^https?:\/\//.test(v.trim()) ? true : 'Enter a full http(s):// URL')
        });
    }

    async promptModelId(discovered) {
        if (discovered.length > 0) {
            const choices = discovered.map((id) => ({ name: id, message: id }));
            choices.push({ name: '__custom__', message: 'Enter a model id manually' });
            const picked = await select('Pick a model:', choices, { initial: 0 });
            if (picked === '__custom__') {
                return await input('Model id (e.g. glm-5.2:cloud, llama3:latest):', {
                    validate: (v) => (v.trim() ? true : 'Model id is required')
                });
            }
            return picked;
        }
        return await input('Model id (e.g. glm-5.2:cloud, llama3:latest):', {
            validate: (v) => (v.trim() ? true : 'Model id is required')
        });
    }

    async runOnboard({ force = false } = {}) {
        if (!force && this.isConfigured()) return true;

        if (!isInteractive()) {
            console.error(
                'onboard: opencode.json is not configured and stdin is not a TTY; ' +
                    'run `make backend` in an interactive shell to configure.'
            );
            return false;
        }

        if (force && fs.existsSync(this.configPath)) {
            console.log('\n=== rarebert reconfigure ===');
            console.log('Reconfiguring existing opencode.json.\n');
        } else {
            console.log('\n=== rarebert onboarding ===');
            console.log("No usable opencode.json found. Let's configure a model.\n");
        }

        const useDefault = await confirm(
            `Use a local Ollama instance at ${DEFAULT_BASE_URL}?`,
            true
        );
        const baseURL = useDefault ? DEFAULT_BASE_URL : await this.promptBaseURL(DEFAULT_BASE_URL);

        console.log(`\nProbing ${baseURL}/models ...`);
        const discovered = this.fetchModels(baseURL);
        if (discovered.length > 0) {
            console.log(
                `  found ${discovered.length} model(s): ${discovered.slice(0, 5).join(', ')}${discovered.length > 5 ? ' ...' : ''}`
            );
        } else {
            console.log(
                '  no models returned (or endpoint unreachable); you can still enter an id manually.'
            );
        }

        const modelId = await this.promptModelId(discovered);
        const modelName = await input('Display name for this model (optional):', {
            initial: modelId
        });

        const cfg = this.buildConfig({
            provider: DEFAULT_PROVIDER,
            baseURL,
            modelId,
            modelName: modelName || modelId
        });
        this.writeConfig(cfg);

        console.log(`\n✓ Wrote ${path.relative(PROJECT_ROOT, this.configPath)}`);
        console.log(`  model:    ${cfg.model}`);
        console.log(`  endpoint: ${baseURL}`);
        console.log('\nRe-run `make backend` any time to reconfigure.');
        return true;
    }

    async ensureConfig({ force = false } = {}) {
        if (force) return this.runOnboard({ force: true });
        if (this.isConfigured()) return true;
        return this.runOnboard({ force: false });
    }

    async onboard(args = []) {
        const force = args.includes('--force') || args.includes('-f') || args.length === 0;
        const ok = await this.runOnboard({ force });
        if (!ok && !isInteractive()) process.exit(1);
    }
}

const backend = new Backend();

const configPath = () => backend.configPath;
const readConfig = () => backend.readConfig();
const isConfigured = () => backend.isConfigured();
const ensureConfig = (opts) => backend.ensureConfig(opts);
const onboard = (args) => backend.onboard(args);

export { Backend, backend, configPath, readConfig, isConfigured, ensureConfig, onboard };
export default { Backend, backend, configPath, readConfig, isConfigured, ensureConfig, onboard };
