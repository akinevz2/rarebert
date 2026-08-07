#!/usr/bin/env node

import { cli } from '../lib/cli.mjs';

const meta = {
    name: 'status',
    description:
        'Walk through git status, diff, branch/remote info, and launch edit — interactive staged review',
    usage: 'node index.js status',
    options: []
};

async function main() {
    // status: implementation scaffold
    const todo = `
status module - not yet implemented

TODO: essentially just interactively go through following stages:
- print the git status
- default choice exit or continue
- print the git diff (with colour)
- default choice exit or continue
- print branch and remote information
- default choice exit or continue
- launch "edit" submodule
`;
    console.log(todo);
}

export { main };

export default {
    name: 'status',
    description:
        'Walk through git status, diff, branch/remote info, and launch edit — interactive staged review',
    usage: 'node index.js status',
    options: [],
    main: cli.run(meta, main)
};
