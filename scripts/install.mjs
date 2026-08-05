#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { rarebert } from '../lib/projects.mjs';
import { cli } from '../lib/cli.mjs';

const DEFAULT_PREFIX = path.join(os.homedir(), '.local', 'rarebert');
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const meta = {
    name: 'install',
    description: `Install rarebert to a user-controlled npm prefix (default: ${DEFAULT_PREFIX})`,
    usage: 'node index.js install [--prefix <dir>] [--force]',
    options: [
        { flag: 'prefix', label: '<dir>', description: 'npm prefix to install into' },
        { flag: 'force', label: '', description: 'overwrite an existing prefix directory' }
    ]
};

function resolvePrefix(args) {
    const i = args.indexOf('--prefix');
    if (i !== -1 && args[i + 1]) return path.resolve(args[i + 1]);
    return DEFAULT_PREFIX;
}

function hasForce(args) {
    return args.includes('--force');
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

async function main(args = []) {
    const prefix = resolvePrefix(args);
    const force = hasForce(args);

    if (fs.existsSync(prefix) && !force && fs.readdirSync(prefix).length > 0) {
        const overwrite = await cli.confirm(`Prefix "${prefix}" is non-empty. Continue?`, false);
        if (!overwrite) cli.ok('Not installed.');
    }

    fs.mkdirSync(prefix, { recursive: true });
    console.log(`install: prefix -> ${prefix}`);

    const result = spawnSync(
        NPM_BIN,
        ['install', '--prefix', prefix, '--ignore-scripts'],
        { cwd: rarebert.root, stdio: 'inherit' }
    );

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

export default {
    name: 'install',
    description: meta.description,
    main: cli.run(meta, main)
};
