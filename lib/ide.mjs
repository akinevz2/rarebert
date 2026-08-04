import { spawn, spawnSync } from 'child_process';
import { PROJECT_ROOT } from './core.mjs';
import { resolveOpencode } from './opencode.mjs';

export function runIDE(model, file, options = {}) {
    const bin = resolveOpencode();
    const instruction = options.instruction ?? `Implement the module in ${file}`;
    const args = options.implement
        ? ['run', instruction, '-m', model, '--mini']
        : [PROJECT_ROOT, '-m', model];
    console.error(`$ opencode ${args.join(' ')}`);

    if (options.implement) {
        const result = spawnSync(bin, args, {
            stdio: 'inherit',
            cwd: PROJECT_ROOT
        });
        if (result.error) {
            console.error(`Failed to launch opencode: ${result.error.message}`);
            process.exit(1);
        }
        return { status: result.status, child: null };
    }

    const child = spawn(bin, args, {
        stdio: 'inherit',
        cwd: PROJECT_ROOT
    });
    if (child.error) {
        console.error(`Failed to launch opencode: ${child.error.message}`);
        process.exit(1);
    }
    return { status: null, child };
}

export function exitIDE(child, timeoutMs = 5000) {
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

export default { runIDE, exitIDE };
