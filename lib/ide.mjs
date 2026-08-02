import { spawn, spawnSync } from 'child_process';
import { PROJECT_ROOT } from './core.mjs';

export function runIDE(model, file, options = {}) {
    const args = options.implement
        ? ['run', `Implement the module in ${file}`, '-m', model, '--auto']
        : [PROJECT_ROOT, '-m', model];
    console.error(`$ opencode ${args.join(' ')}`);

    if (options.implement) {
        const result = spawnSync('opencode', args, {
            stdio: 'inherit',
            cwd: PROJECT_ROOT
        });
        if (result.error) {
            console.error(`Failed to launch opencode: ${result.error.message}`);
            process.exit(1);
        }
        return { status: result.status, child: null };
    }

    const child = spawn('opencode', args, {
        stdio: 'inherit',
        cwd: PROJECT_ROOT
    });
    if (child.error) {
        console.error(`Failed to launch opencode: ${child.error.message}`);
        process.exit(1);
    }
    return { status: null, child };
}

export default { runIDE };