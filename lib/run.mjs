import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { rarebert } from './projects.mjs';
import { listAllModules } from './module.mjs';
import { exit } from './core.mjs';

const SRC_DIR = path.join(rarebert.root, 'src');
const DEFAULT_MODULE = path.join(SRC_DIR, 'main.py');

function rel(p) {
    return path.relative(rarebert.root, p);
}

function runProcess(cmd, args) {
    console.log(`$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, {
        stdio: 'inherit',
        cwd: rarebert.root
    });
    child.on('error', (err) => {
        console.error(`Failed to launch ${cmd}: ${err.message}`);
        return exit(`Failed to launch ${cmd}: ${err.message}`);
    });
    child.on('exit', (code) => process.exit(code ?? 0));
}

function findJsModule(name) {
    const normalized = rarebert.normalizeModuleName(name);
    return listAllModules().find(
        (s) =>
            (s.ext === '.mjs' || s.ext === '.js') &&
            rarebert.normalizeModuleName(s.name) === normalized
    );
}

function findPyModule(name) {
    const candidates = [
        path.join(SRC_DIR, name.endsWith('.py') ? name : `${name}.py`),
        path.isAbsolute(name) ? name : null
    ].filter(Boolean);
    return candidates.find((p) => fs.existsSync(p));
}

export { SRC_DIR, DEFAULT_MODULE, rel, runProcess, findJsModule, findPyModule };
export default { runProcess, findJsModule, findPyModule };