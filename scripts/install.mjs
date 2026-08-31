#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { home } from '../lib/projects.mjs';
import { CLI, TUI } from '../lib/module.mjs';
import { tui } from '../lib/tui.mjs';
import { backend } from '../lib/backend.mjs';
import { exit } from '../lib/core.mjs';

const DEFAULT_PREFIX = path.join(os.homedir(), '.local', 'share', 'rarebert');
const DEFAULT_BIN_DIR = path.join(os.homedir(), '.local', 'bin');
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const meta = {
    name: 'install',
    description: `Install rarebert: npm prefix defaults to ${DEFAULT_PREFIX}, binary symlinked into ~/.local/bin`,
    usage: 'node index.js install [--prefix <dir>] [--bin-dir <dir>] [--force]',
    options: [
        { flag: '--prefix <dir>', description: 'npm prefix to install into' },
        {
            flag: '--bin-dir <dir>',
            description: 'directory for the rarebert symlink (default: ~/.local/bin)'
        },
        { flag: '--force', description: 'overwrite an existing prefix directory' }
    ]
};

function resolvePrefix(opts) {
    if (opts.prefix) return path.resolve(opts.prefix);
    return DEFAULT_PREFIX;
}

function resolveBinDir(opts) {
    if (opts.binDir) return path.resolve(opts.binDir);
    return DEFAULT_BIN_DIR;
}

function linkBinary(binDir) {
    const binSrc = path.join(home.root, 'index.js');
    fs.mkdirSync(binDir, { recursive: true });
    const linkPath = path.join(binDir, 'rarebert');
    if (fs.existsSync(linkPath) || fs.isSymbolicLinkSync?.(linkPath)) fs.unlinkSync(linkPath);
    fs.symlinkSync(binSrc, linkPath);
    return linkPath;
}

async function performInstall(prefix, binDir) {
    fs.mkdirSync(prefix, { recursive: true });
    console.log(`install: prefix -> ${prefix}`);

    const result = spawnSync(NPM_BIN, ['install', '--prefix', prefix, '--ignore-scripts'], {
        cwd: home.root,
        stdio: 'inherit'
    });

    if (result.status !== 0) {
        console.error(`install: npm install exited with status ${result.status ?? 0}`);
        return 1;
    }

    const linkPath = linkBinary(binDir);
    console.log(`install: linked rarebert -> ${linkPath}`);
    if (process.env.PATH?.split(path.delimiter).includes(binDir)) {
        console.log(`'rarebert' is on your PATH.`);
    } else {
        console.log(`\nAdd "${binDir}" to your PATH to use 'rarebert'.`);
    }

    console.log('\n=== onboarding ===');
    const onboardOk = await backend.ensureConfig();
    if (!onboardOk) {
        console.log('Run `make onboard` to complete configuration later.');
    }

    return 0;
}

async function main(opts, positional) {
    const prefix = resolvePrefix(opts);
    const binDir = resolveBinDir(opts);
    const force = !!opts.force;

    const isNonEmpty = fs.existsSync(prefix) && fs.readdirSync(prefix).length > 0;

    if (force || !isNonEmpty) {
        const code = await performInstall(prefix, binDir);
        return exit(code);
    }

    return exit(
        new TUI(
            'install.mjs',
            async () => {
                if (isNonEmpty) {
                    const overwrite = await tui.confirm(
                        `Prefix "${prefix}" is non-empty. Continue?`,
                        false
                    );
                    if (!overwrite) return exit(0, () => console.log('Not installed.'));
                }

                const code = await performInstall(prefix, binDir);
                return exit(code);
            },
            meta
        )
    );
}

export { meta, performInstall };

export default new CLI('install.mjs', main, meta).supportsDirectRunning(import.meta.url);
