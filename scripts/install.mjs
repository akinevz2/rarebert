#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { rarebert } from '../lib/projects.mjs';
import { Module } from '../lib/modules.mjs';
import { cli } from '../lib/cli.mjs';

const DEFAULT_PREFIX = path.join(os.homedir(), '.local', 'share', 'rarebert');
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const meta = {
    name: 'install',
    description: `Install rarebert to a user-controlled npm prefix (default: ${DEFAULT_PREFIX})`,
    usage: 'node index.js install [--prefix <dir>] [--force]',
    options: [
        { flag: '--prefix <dir>', description: 'npm prefix to install into' },
        { flag: '--force', description: 'overwrite an existing prefix directory' }
    ]
};

function resolvePrefix(opts) {
    if (opts.prefix) return path.resolve(opts.prefix);
    return DEFAULT_PREFIX;
}

function linkBinary(prefix) {
    const binSrc = path.join(rarebert.root, 'index.js');
    const binDir = path.join(prefix, 'bin');
    const linkPath = path.join(binDir, 'rarebert');
    fs.mkdirSync(binDir, { recursive: true });
    if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
    fs.symlinkSync(binSrc, linkPath);
    return linkPath;
}

async function main(opts, positional) {
    const prefix = resolvePrefix(opts);
    const force = !!opts.force;

    if (fs.existsSync(prefix) && !force && fs.readdirSync(prefix).length > 0) {
        const overwrite = await cli.confirm(`Prefix "${prefix}" is non-empty. Continue?`, false);
        if (!overwrite) cli.ok('Not installed.');
    }

    fs.mkdirSync(prefix, { recursive: true });
    console.log(`install: prefix -> ${prefix}`);

    const result = spawnSync(NPM_BIN, ['install', '--prefix', prefix, '--ignore-scripts'], {
        cwd: rarebert.root,
        stdio: 'inherit'
    });

    if (result.status !== 0) {
        console.error(`install: npm install exited with status ${result.status ?? 0}`);
        cli.fail('install failed');
    }

    const linkPath = linkBinary(prefix);
    console.log(`install: linked rarebert -> ${linkPath}`);
    console.log(`\nAdd "${path.join(prefix, 'bin')}" to your PATH to use 'rarebert'.`);
    cli.ok(`Done. Installed to ${prefix}`);
}

export { main, resolvePrefix, DEFAULT_PREFIX };

const module = new Module('install.mjs', main, meta);

export default module;
module.supportsDirectRunning(import.meta.url);
