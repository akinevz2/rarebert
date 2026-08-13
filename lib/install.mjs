import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { home } from './projects.mjs';

const DEFAULT_PREFIX = path.join(os.homedir(), '.local', 'share', 'rarebert');
const DEFAULT_BIN_DIR = path.join(os.homedir(), '.local', 'bin');
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';

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
    try {
        if (fs.existsSync(linkPath) || fs.lstatSync(linkPath).isSymbolicLink()) {
            fs.unlinkSync(linkPath);
        }
    } catch {
        /* not a symlink or doesn't exist */
    }
    fs.symlinkSync(binSrc, linkPath);
    return linkPath;
}

export { DEFAULT_PREFIX, DEFAULT_BIN_DIR, NPM_BIN, resolvePrefix, resolveBinDir, linkBinary };
export default { resolvePrefix, resolveBinDir, linkBinary };