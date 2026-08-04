import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import Enquirer from 'enquirer';
import { PROJECT_ROOT } from './core.mjs';
import { isInteractive, abort, confirm, input, select } from './cli.mjs';

const OPENCODE_CONFIG = path.join(PROJECT_ROOT, 'opencode.json');
const DEFAULT_BASE_URL = 'http://localhost:11434/v1';
const DEFAULT_PROVIDER = 'ollama';
const DEFAULT_PROVIDER_NPM = '@ai-sdk/openai-compatible';
const DEFAULT_PROVIDER_NAME = 'Ollama (local)';

export function configPath() {
    return OPENCODE_CONFIG;
}

export function readConfig() {
    if (!fs.existsSync(OPENCODE_CONFIG)) return null;
    try {
        return JSON.parse(fs.readFileSync(OPENCODE_CONFIG, 'utf-8'));
    } catch {
        return null;
    }
}

export function isConfigured() {
    const cfg = readConfig();
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

function fetchModels(baseURL, timeoutMs = 3000) {
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

function buildConfig({ provider, baseURL, modelId, modelName }) {
    const providerName = provider || DEFAULT_PROVIDER;
    const providerNpm = DEFAULT_PROVIDER_NPM;
    const providerDisplayName = DEFAULT_PROVIDER_NAME;
    return {
        $schema: 'https://opencode.ai/config.json',
        instructions: ['AGENTS.md'],
        model: `${providerName}/${modelId}`,
        provider: {
            [providerName]: {
                npm: providerNpm,
                name: providerDisplayName,
                options: { baseURL },
                models: {
                    [modelId]: { name: modelName || modelId }
                }
            }
        }
    };
}

function writeConfig(cfg) {
    fs.writeFileSync(OPENCODE_CONFIG, JSON.stringify(cfg, null, 4) + '\n');
}

async function promptBaseURL(initial = DEFAULT_BASE_URL) {
    return await input('Ollama endpoint URL (OpenAI-compatible /v1):', {
        initial,
        validate: (v) => (/^https?:\/\//.test(v.trim()) ? true : 'Enter a full http(s):// URL')
    });
}

async function promptModelId(discovered) {
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

async function runOnboard({ force = false } = {}) {
    if (!force && isConfigured()) return true;

    if (!isInteractive()) {
        console.error(
            'onboard: opencode.json is not configured and stdin is not a TTY; ' +
                'run `make backend` in an interactive shell to configure.'
        );
        return false;
    }

    if (force && fs.existsSync(OPENCODE_CONFIG)) {
        console.error('\n=== rarebert reconfigure ===');
        console.error('Reconfiguring existing opencode.json.\n');
    } else {
        console.error('\n=== rarebert onboarding ===');
        console.error("No usable opencode.json found. Let's configure a model.\n");
    }

    const useDefault = await confirm(`Use a local Ollama instance at ${DEFAULT_BASE_URL}?`, true);
    const baseURL = useDefault ? DEFAULT_BASE_URL : await promptBaseURL(DEFAULT_BASE_URL);

    console.error(`\nProbing ${baseURL}/models ...`);
    const discovered = fetchModels(baseURL);
    if (discovered.length > 0) {
        console.error(
            `  found ${discovered.length} model(s): ${discovered.slice(0, 5).join(', ')}${discovered.length > 5 ? ' ...' : ''}`
        );
    } else {
        console.error(
            '  no models returned (or endpoint unreachable); you can still enter an id manually.'
        );
    }

    const modelId = await promptModelId(discovered);
    const modelName = await input('Display name for this model (optional):', {
        initial: modelId
    });

    const cfg = buildConfig({
        provider: DEFAULT_PROVIDER,
        baseURL,
        modelId,
        modelName: modelName || modelId
    });
    writeConfig(cfg);

    console.error(`\n✓ Wrote ${path.relative(PROJECT_ROOT, OPENCODE_CONFIG)}`);
    console.error(`  model:    ${cfg.model}`);
    console.error(`  endpoint: ${baseURL}`);
    console.error('\nRe-run `make backend` any time to reconfigure.');
    return true;
}

export async function ensureConfig({ force = false } = {}) {
    if (force) return runOnboard({ force: true });
    if (isConfigured()) return true;
    return runOnboard({ force: false });
}

export async function onboard(args = []) {
    const force = args.includes('--force') || args.includes('-f') || args.length === 0;
    const ok = await runOnboard({ force });
    if (!ok && !isInteractive()) process.exit(1);
}

export default { configPath, readConfig, isConfigured, ensureConfig, onboard };
