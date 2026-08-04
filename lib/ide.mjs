import { spawn, spawnSync } from 'child_process';
import { rarebert } from './projects.mjs';
import { opencode } from './opencode.mjs';

class Ide {
    constructor() {
        this.root = rarebert.root;
    }

    run(model, file, options = {}) {
        const bin = opencode.resolve();
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
export { Ide, ide };
export default ide;
