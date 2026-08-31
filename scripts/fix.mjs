#!/usr/bin/env node

import { CLI } from '../lib/module.mjs';
import { exit } from '../lib/core.mjs';

const meta = {
    name: 'fix',
    description: 'fix module',
    usage: 'node index.js fix',
    options: []
};

async function main(opts, positional) {
    // fix: implementation scaffold
    console.log('fix module - must accept a project reference or a module reference');
    console.log(
        'read the memos attached to selected modules for fix to the user including dependency-ancestors'
    );
    console.log(
        'start an interactive session of opencode with cwd as project and selected modules and their memos as prompt'
    );
    console.log(
        'instruct the model to clarify any changes that are not well defined in the memos with the user feedback'
    );
    console.log(
        'instruct the model then to create a todo list of memos that need to be checked with user for removal if they appear stale'
    );
    console.log('after confirming stale memo removal');
    console.log('instruct model to create plan and todo items summarising all of the memos read');
    console.log('instruct model to begin implementing once the user confirms with "continue"');
    return exit(0);
}

export { main };

const module = new CLI('fix.mjs', main, meta);
export default module;
module.supportsDirectRunning(import.meta.url);
