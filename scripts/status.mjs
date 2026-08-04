#!/usr/bin/env node

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

export default {
    name: 'status',
    description: 'status module'
};
