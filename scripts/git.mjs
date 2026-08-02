#!/usr/bin/env node

import { PROJECT_ROOT, normalizeModuleName } from '../lib/core.mjs';

const { spawnSync } = await import('child_process');
const GIT = "git";
const allowedGitCommands = new Set([
    "add",
    "commit",
    "stash",
    "status",
    "diff",
    "log",
    "branch",
    "push",
    "pull",
    "fetch",
    "merge",
    "checkout",
    "tag",
    "switch",
    "remote",
    "help",
    "rebase",
    "restore",
    "reset",
    "show",
    "mv",
    "rm"
]);

function buildArgs(subcommand, args = [], options = {}) {
    if (!allowedGitCommands.has(subcommand)) {
        throw new Error(`Disallowed git command: ${subcommand}`);
    }
    const flagArgs = [];
    if (options.all && subcommand === 'add') flagArgs.push('-A');
    if (options.message && subcommand === 'commit') flagArgs.push('-m', options.message);
    if (options.keepIndex && subcommand === 'stash') flagArgs.push('keep-index');
    return [subcommand, ...flagArgs, ...args];
}

export function git(command, args = [], options = {}) {
    const subcommand = command === 'git' ? args[0] : command;
    const rest = command === 'git' ? args.slice(1) : args;

    if (!subcommand || !allowedGitCommands.has(subcommand)) {
        throw new Error(`Disallowed git command: ${subcommand ?? '(none)'}`);
    }

    const fullArgs = buildArgs(subcommand, rest, options);
    const result = spawnSync(GIT, fullArgs, {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        stdio: options.stdio ?? 'pipe'
    });

    if (result.error) throw result.error;
    return {
        command: `${GIT} ${fullArgs.join(' ')}`,
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        ok: result.status === 0
    };
}

export const add = (args = [], options = {}) => git('add', args, options);
export const commit = (args = [], options = {}) => git('commit', args, options);
export const stash = (args = [], options = {}) => git('stash', args, options);
export const status = (args = [], options = {}) => git('status', args, options);
export const diff = (args = [], options = {}) => git('diff', args, options);
export const log = (args = [], options = {}) => git('log', args, options);
export const branch = (args = [], options = {}) => git('branch', args, options);

export function isAllowed(command) {
    return allowedGitCommands.has(command);
}

export function allowedCommands() {
    return [...allowedGitCommands];
}

async function main(args = []) {
    if (args.includes('--help') || args.includes('-h')) {
        console.error('git: Thin wrapper around allowed git subcommands');
        console.error('  Usage: node index.js git <command> [args...]');
        console.error('  Allowed commands: ' + allowedCommands().join(', '));
        return;
    }

    const [command, ...rest] = args.filter(a => a !== '--help' && a !== '-h');
    if (!command) {
        console.error('No git command given. Allowed: ' + allowedCommands().join(', '));
        process.exit(1);
    }

    try {
        const result = git(command, rest, { stdio: 'inherit' });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(result.status ?? 0);
    } catch (err) {
        console.error(`git: ${err.message}`);
        process.exit(1);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}

export default {
    name: 'git',
    description: 'Thin wrapper around an allowlist of git subcommands',
    main,
    git,
    add,
    commit,
    stash,
    status,
    diff,
    log,
    branch,
    isAllowed,
    allowedCommands
};