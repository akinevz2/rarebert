#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { backend, DEFAULT_BASE_URL, DEFAULT_PROVIDER } from '../lib/backend.mjs';
import { home, rarebert } from '../lib/projects.mjs';
import { store, exit } from '../lib/core.mjs';
import { cli, AbortError, Interface, CLI, TUI } from '../lib/module.mjs';

const meta = {
    name: 'onboard',
    description:
        'Interactively configure opencode.json (endpoint + model) and register the current project with rarebert (mark module-containing folders)',
    usage: 'node index.js onboard [--force] [--base-url <url>] [--model <id>] [--provider <name>] [--editor-type <graphical|terminal>]',
    options: [
        {
            flag: '--force',
            description: 'reconfigure even if a config/project registration exists'
        },
        {
            flag: '--base-url <url>',
            description:
                'Ollama endpoint URL (OpenAI-compatible /v1). Non-interactive when paired with --model.'
        },
        {
            flag: '--model <id>',
            description: 'Default model id. Non-interactive when paired with --base-url.'
        },
        { flag: '--provider <name>', description: 'Provider key (default: ollama).' },
        { flag: '--editor-type <graphical|terminal>', description: 'Skip the editor-type prompt.' }
    ]
};

export { meta };

// ---------------------------------------------------------------------------
// Interactive onboarding orchestration.
//
// LIB PURITY: every Interface / Enquirer construction lives here in
// scripts/ — lib/backend.mjs exposes only pure data operations (readConfig,
// fetchModels, buildConfig, writeConfig, scanCandidateFolders,
// registerFolders, ...). See the key Interface-inversion memo on
// lib/backend.mjs.
// ---------------------------------------------------------------------------

async function promptBaseURL(initial = DEFAULT_BASE_URL) {
    const iface = Interface.createInterface('onboard');
    return await iface.input('Ollama endpoint URL (OpenAI-compatible /v1):', {
        initial,
        validate: (v) => (/^https?:\/\//.test(v.trim()) ? true : 'Enter a full http(s):// URL')
    });
}

async function promptModelIds(discovered) {
    const iface = Interface.createInterface('onboard');
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

async function promptDefaultModel(modelIds) {
    if (modelIds.length === 1) return modelIds[0];
    const iface = Interface.createInterface('onboard');
    const choices = modelIds.map((id) => ({ name: id, message: id }));
    return await iface.select('Which model should be the default?', choices, { initial: 0 });
}

/**
 * Optionally prompt for custom display names for each model. If the
 * user declines, all models use their id as the display name.
 */
async function promptModelDisplayNames(modelIds) {
    const models = modelIds.map((id) => ({ id, name: id }));
    if (modelIds.length === 0) return models;

    const iface = Interface.createInterface('onboard');
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

/**
 * Ask whether the user's $EDITOR is a terminal-based editor (nano, vim,
 * etc.) or a graphical one (code, subl, ...). Persisted via
 * backend.setEditorType so `make open` knows whether to launch the
 * opencode TUI in parallel (graphical) or await the editor's exit + a
 * confirm before launching (terminal — the editor needs the TTY to itself).
 */
async function promptEditorType(initial = null) {
    const existing = initial ?? backend.getEditorType();
    const choices = [
        { name: 'graphical', message: 'Graphical (code, subl, cursor, ...)' },
        { name: 'terminal', message: 'Terminal (nano, vim, vi, micro, ...)' }
    ];
    const initialIdx = existing === 'terminal' ? 1 : 0;
    const iface = Interface.createInterface('onboard');
    const choice = await iface.select('Is your $EDITOR a graphical or terminal editor?', choices, {
        initial: initialIdx
    });
    return choice;
}

/**
 * Full interactive configuration flow: base URL prompt, model
 * discovery/selection, display names, editor type, config write.
 */
async function runOnboard({ force = false } = {}) {
    if (!force && backend.isConfigured()) return true;

    if (!cli.isInteractive()) {
        console.error(
            'onboard: opencode.json is not configured and stdin is not a TTY; ' +
                'run `make onboard` in an interactive shell to configure.'
        );
        return false;
    }
    const iface = Interface.createInterface('onboard');

    if (force && fs.existsSync(backend.configPath)) {
        console.log('\n=== rarebert reconfigure ===');
        console.log('Reconfiguring existing opencode.json.\n');
    } else {
        console.log('\n=== rarebert onboarding ===');
        console.log("No usable opencode.json found. Let's configure a model.\n");
    }

    // Text input for the base URL. Empty accepts the default (or the
    // previously configured URL if reconfiguring); typing over provides
    // a new endpoint.
    const existingURL = backend.getBaseURL();
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
    const discovered = backend.fetchModels(baseURL);
    if (discovered.length > 0) {
        console.log(
            `  found ${discovered.length} model(s): ${discovered.slice(0, 5).join(', ')}${discovered.length > 5 ? ' ...' : ''}`
        );
    } else {
        // Endpoint unreachable — persist the base URL but no models.
        // Next time a model is needed, retry fetching from this URL.
        console.log('  no models returned (endpoint unreachable).');
        backend.writePartialConfig(baseURL);
        console.log(`\n✓ Persisted base URL (${baseURL}) without models.`);
        console.log('  Start Ollama and re-run `make onboard` to complete configuration.');
        return false;
    }

    const modelIds = await promptModelIds(discovered);
    const defaultModelId = await promptDefaultModel(modelIds);
    const models = await promptModelDisplayNames(modelIds);

    const editorType = await promptEditorType();
    backend.setEditorType(editorType);

    const cfg = backend.buildConfig({
        provider: DEFAULT_PROVIDER,
        baseURL,
        models,
        defaultModelId
    });
    backend.writeConfig(cfg);

    console.log(`\n✓ Wrote ${path.relative(home.root, backend.configPath)}`);
    console.log(`  models:   ${models.map((m) => m.id).join(', ')}`);
    console.log(`  default:  ${cfg.model}`);
    console.log(`  endpoint: ${baseURL}`);
    console.log(`  editor:   ${editorType}`);
    console.log('\nRe-run `make onboard` any time to reconfigure.');
    return true;
}

/**
 * Complete a partial config (base URL already persisted, endpoint
 * now online) by prompting for model selection and writing the full
 * config.
 */
async function completeConfig(baseURL, discovered) {
    console.log('\n=== rarebert completing configuration ===\n');

    const modelIds = await promptModelIds(discovered);
    const defaultModelId = await promptDefaultModel(modelIds);
    const models = await promptModelDisplayNames(modelIds);
    const editorType = await promptEditorType();
    backend.setEditorType(editorType);

    const cfg = backend.buildConfig({
        provider: DEFAULT_PROVIDER,
        baseURL,
        models,
        defaultModelId
    });
    backend.writeConfig(cfg);

    console.log(`\n✓ Wrote ${path.relative(home.root, backend.configPath)}`);
    console.log(`  models:   ${models.map((m) => m.id).join(', ')}`);
    console.log(`  default:  ${cfg.model}`);
    console.log(`  endpoint: ${baseURL}`);
    console.log(`  editor:   ${editorType}`);
    return true;
}

/**
 * Run per-project onboarding for the current working directory.
 * Scans for module-containing folders, prompts the user to mark
 * which ones rarebert should track, and registers them via
 * backend.registerFolders. Skips silently when the project is already
 * onboarded (unless force).
 */
async function projectOnboard({ force = false } = {}) {
    const cwd = rarebert.root;

    if (store.isOnboarded(cwd) && !force) return true;

    // Don't onboard rarebert's own install via this flow.
    if (cwd === home.root) return true;

    if (!cli.isInteractive()) {
        console.error(
            `onboard: project "${cwd}" is not registered with rarebert.\n` +
                'Run `rarebert onboard` in an interactive shell to mark module folders.'
        );
        return false;
    }

    console.log('\n=== rarebert project onboarding ===\n');
    console.log(`Scanning ${cwd} for module-containing folders...`);

    const candidates = backend.scanCandidateFolders(cwd);
    if (candidates.length === 0) {
        console.log('No module-containing folders found; nothing to register.');
        backend.registerFolders(cwd, []);
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
            message: 'Mark the folders rarebert should track (space to toggle, enter to confirm):',
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
        backend.registerFolders(cwd, []);
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

    backend.registerFolders(cwd, folders);

    // No reload() needed — rarebert.discover() is lazily evaluated
    // and will pick up the registered folders on the next read.

    console.log(`\n✓ Registered ${folders.length} folder(s) for ${cwd}`);
    folders.forEach((f) => console.log(`  - ${f.rel}/  (${f.exts.join(', ')})`));
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
async function runOnboardNonInteractive({
    baseURL,
    model,
    provider = DEFAULT_PROVIDER,
    editorType = null,
    force = false
} = {}) {
    if (!force && backend.isConfigured()) return true;

    console.log(`\n=== rarebert onboarding (non-interactive) ===`);
    console.log(`  endpoint: ${baseURL}`);
    console.log(`  model:    ${model}`);
    console.log(`  provider: ${provider}`);
    if (editorType) console.log(`  editor:   ${editorType}`);

    console.log(`\nProbing ${baseURL}/models ...`);
    const discovered = backend.fetchModels(baseURL);

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
        backend.writePartialConfig(baseURL);
        console.log(`\n✓ Persisted base URL (${baseURL}) without models.`);
        console.log('  Start Ollama and re-run onboard to complete configuration.');
        return false;
    }

    if (editorType) backend.setEditorType(editorType);

    const cfg = backend.buildConfig({
        provider,
        baseURL,
        models,
        defaultModelId
    });
    backend.writeConfig(cfg);

    console.log(`\n✓ Wrote ${path.relative(home.root, backend.configPath)}`);
    console.log(`  models:   ${models.map((m) => m.id).join(', ')}`);
    console.log(`  default:  ${cfg.model}`);
    console.log(`  endpoint: ${baseURL}`);
    if (editorType) console.log(`  editor:   ${editorType}`);

    const projectOk = await projectOnboard({ force });
    if (!projectOk) {
        console.error('onboard: project registration failed.');
        return false;
    }

    console.log('\nRe-run `make onboard` any time to reconfigure.');
    return true;
}

export default new CLI(
    'onboard.mjs',
    async (opts, positional) => {
        const force = !!opts.force || positional.includes('--force') || positional.includes('-f');

        // Non-interactive mode: both --base-url and --model required.
        if (opts.baseUrl && opts.model) {
            const provider = opts.provider || 'ollama';
            const editorType = opts.editorType || null;
            const ok = await runOnboardNonInteractive({
                baseURL: opts.baseUrl,
                model: opts.model,
                provider,
                editorType,
                force
            });
            return exit(ok ? 0 : 1);
        }

        // Interactive fallback — escalate to TUI.
        return exit(
            new TUI(
                'onboard.mjs',
                async (o = opts, p = positional) => {
                    const tuiForce = !!o.force || p.includes('--force') || p.includes('-f');

                    const configOk = await runOnboard({ force: tuiForce });
                    if (!configOk && !backend.isConfigured()) {
                        return exit(1);
                    }

                    const projectOk = await projectOnboard({ force: tuiForce });
                    if (!projectOk) {
                        return exit(1);
                    }
                    return exit(0);
                },
                meta
            )
        );
    },
    meta
).supportsDirectRunning(import.meta.url);
