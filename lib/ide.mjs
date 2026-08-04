import { spawn, spawnSync } from 'child_process';
import { PROJECT_ROOT } from './core.mjs';
import { resolveOpencode } from './opencode.mjs';

class Ide {
    constructor() {
        this.root = PROJECT_ROOT;
    }

    run(model, file, options = {}) {
        const bin = resolveOpencode();
        const instruction = options.instruction ?? `Implement the module in ${file}`;
        const args = options.implement
            ? ['run', instruction, '-m', model, '--mini']
            : [this.root, '-m', model];
        console.log(`$ opencode ${args.join(' ')}`);

        if (options.implement) {
            const result = spawnSync(bin, args, {
                stdio: 'inherit',
                cwd: this.root
            });
            if (result.error) {
                console.error(`Failed to launch opencode: ${result.error.message}`);
                process.exit(1);
            }
            return { status: result.status, child: null };
        }

        const child = spawn(bin, args, {
            stdio: 'inherit',
            cwd: this.root
        });
        if (child.error) {
            console.error(`Failed to launch opencode: ${child.error.message}`);
            process.exit(1);
        }
        return { status: null, child };
    }

    exit(child, timeoutMs = 5000) {
        if (!child || child.killed || child.exitCode !== null || child.signalCode !== null) {
            return Promise.resolve(child?.exitCode ?? 0);
        }

        let settleExit;
        const exited = new Promise((resolve) => {
            settleExit = resolve;
        });

        const settle = () => settleExit(child.exitCode ?? 0);
        child.once('exit', settle);
        child.once('close', settle);

        if (child.exitCode !== null || child.signalCode !== null) {
            settle();
            return exited;
        }

        try {
            if (child.stdin && !child.stdin.destroyed) {
                child.stdin.write('\x18q');
                child.stdin.end();
            }
        } catch {
            /* ignore */
        }

        try {
            child.kill('SIGHUP');
        } catch {
            /* ignore */
        }

        const soft = setTimeout(() => {
            try {
                child.kill('SIGTERM');
            } catch {
                /* ignore */
            }
        }, timeoutMs);
        const hard = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            } catch {
                /* ignore */
            }
            settle();
        }, timeoutMs * 2);
        exited.then(() => {
            clearTimeout(soft);
            clearTimeout(hard);
        });

        return exited;
    }
}

const ide = new Ide();

const runIDE = (model, file, options) => ide.run(model, file, options);
const exitIDE = (child, timeoutMs) => ide.exit(child, timeoutMs);

export { Ide, ide, runIDE, exitIDE };
export default { Ide, ide, runIDE, exitIDE };
