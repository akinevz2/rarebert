#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { home } from '../lib/projects.mjs';
import { Module } from '../lib/modules.mjs';
import { cli } from '../lib/cli.mjs';
import { backend } from '../lib/backend.mjs';

const DEFAULT_PREFIX = path.join(os.homedir(), '.local', 'share', 'rarebert');
const DEFAULT_BIN_DIR = path.join(os.homedir(), '.local', 'bin');
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const meta = {
    name: 'install',
    description: `Install rarebert: npm prefix defaults to ${DEFAULT_PREFIX}, binary symlinked into ${DEFAULT_BIN_DIR}`,
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

async function main(opts, positional) {
    const prefix = resolvePrefix(opts);
    const binDir = resolveBinDir(opts);
    const force = !!opts.force;

    if (fs.existsSync(prefix) && !force && fs.readdirSync(prefix).length > 0) {
        const overwrite = await cli.confirm(`Prefix "${prefix}" is non-empty. Continue?`, false);
        if (!overwrite) cli.ok('Not installed.');
    }

    fs.mkdirSync(prefix, { recursive: true });
    console.log(`install: prefix -> ${prefix}`);

    const result = spawnSync(NPM_BIN, ['install', '--prefix', prefix, '--ignore-scripts'], {
        cwd: home.root,
        stdio: 'inherit'
    });

    if (result.status !== 0) {
        console.error(`install: npm install exited with status ${result.status ?? 0}`);
        cli.fail('install failed');
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

    cli.ok(`Done. Installed to ${prefix}`);
}

export { main, resolvePrefix, DEFAULT_PREFIX };

const module = new Module('install.mjs', main, meta);

export default module;
module.supportsDirectRunning(import.meta.url);
