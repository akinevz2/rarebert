import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { PROJECT_ROOT } from './core.mjs';

const BINARY_REL = 'node_modules/opencode-ai/bin/opencode.exe';
const BINARY_PATH = path.join(PROJECT_ROOT, BINARY_REL);

class Opencode {
    constructor() {
        this.cached = null;
        this.installing = false;
    }

    bundledWorks() {
        if (!fs.existsSync(BINARY_PATH)) return false;
        const result = spawnSync(BINARY_PATH, ['--version'], { stdio: 'ignore' });
        return result.status === 0;
    }

    systemWorks() {
        const result = spawnSync('opencode', ['--version'], { stdio: 'ignore' });
        return result.status === 0;
    }

    installBundled() {
        if (this.installing) return false;
        this.installing = true;
        try {
            console.log('opencode: bundled binary missing; running npm install opencode-ai ...');
            const result = spawnSync(
                'npm',
                ['install', '--no-save', '--loglevel=error', 'opencode-ai'],
                {
                    cwd: PROJECT_ROOT,
                    stdio: 'inherit'
                }
            );
            if (result.status !== 0) {
                console.error('opencode: npm install failed');
                return false;
            }
            return this.bundledWorks();
        } finally {
            this.installing = false;
        }
    }

    resolve() {
        if (this.cached) return this.cached;
        if (this.bundledWorks()) return (this.cached = BINARY_PATH);
        if (this.installBundled() && this.bundledWorks()) return (this.cached = BINARY_PATH);
        if (this.systemWorks()) return (this.cached = 'opencode');
        console.error('opencode: no working binary found after install attempt');
        process.exit(1);
    }
}

const opencode = new Opencode();
const resolveOpencode = () => opencode.resolve();

export { Opencode, opencode, resolveOpencode, BINARY_PATH };
export default { Opencode, opencode, resolveOpencode, BINARY_PATH };
