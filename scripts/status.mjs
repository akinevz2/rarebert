#!/usr/bin/env node

import { PROJECT_ROOT } from '../lib/core.mjs';
import * as backend from '../lib/backend.mjs';
import * as cli from '../lib/cli.mjs';
import * as editor from '../lib/editor.mjs';
import * as git from '../lib/git.mjs';
import * as ide from '../lib/ide.mjs';
import * as languages from '../lib/languages.mjs';
import * as libs from '../lib/libs.mjs';
import * as list from '../lib/list.mjs';
import * as memo from '../lib/memo.mjs';
import * as models from '../lib/models.mjs';
import * as modules from '../lib/modules.mjs';
import * as opencode from '../lib/opencode.mjs';
import * as server from '../lib/server.mjs';
import * as template from '../lib/template.mjs';

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
