#!/usr/bin/env node

import { PROJECT_ROOT, StringBuilder, normalizeModuleName } from '../lib/core.mjs';
import * as resources from '../lib/resources.mjs';
import * as template from '../lib/template.mjs';

async function main() {
    // list modules in scripts/, will be used to implement help command
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export default {
    name: 'list',
    description: 'list module'
};
