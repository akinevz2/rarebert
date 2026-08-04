import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { PROJECT_ROOT } from './core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const BINARY_REL = 'node_modules/opencode-ai/bin/opencode.exe';
export const BINARY_PATH = path.join(PROJECT_ROOT, BINARY_REL);

let cached = null;
let installing = false;

function bundledWorks() {
    if (!fs.existsSync(BINARY_PATH)) return false;
    const result = spawnSync(BINARY_PATH, ['--version'], { stdio: 'ignore' });
    return result.status === 0;
}

function systemWorks() {
    const result = spawnSync('opencode', ['--version'], { stdio: 'ignore' });
    return result.status === 0;
}

function installBundled() {
    if (installing) return false;
    installing = true;
    try {
        console.error('opencode: bundled binary missing; running npm install opencode-ai ...');
        const result = spawnSync('npm', ['install', '--no-save', '--loglevel=error', 'opencode-ai'], {
            cwd: PROJECT_ROOT,
            stdio: 'inherit',
        });
        if (result.status !== 0) {
            console.error('opencode: npm install failed');
            return false;
        }
        return bundledWorks();
    } finally {
        installing = false;
    }
}

export function resolveOpencode() {
    if (cached) return cached;
    if (bundledWorks()) return (cached = BINARY_PATH);
    if (installBundled() && bundledWorks()) return (cached = BINARY_PATH);
    if (systemWorks()) return (cached = 'opencode');
    console.error('opencode: no working binary found after install attempt');
    process.exit(1);
}

export default { resolveOpencode, BINARY_PATH };