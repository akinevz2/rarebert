#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import Enquirer from 'enquirer';
import { PROJECT_ROOT, LIB_DIR } from '../lib/core.mjs';
import { listAllModules, promptModule } from '../lib/modules.mjs';

const MEMO_LIB = path.join(LIB_DIR, 'memo.mjs');
const MEMO_LIB_NAME = 'memo';

async function promptMemoContent() {
    if (process.stdin.isTTY !== true) {
        console.error('Non-interactive; cannot prompt for memo content.');
        process.exit(1);
    }

    const prompt = new Enquirer.Input({
        message: 'Enter the memo content:',
        validate: (input) => input.trim() ? true : 'Memo content is required'
    });

    try {
        return (await prompt.run()).trim();
    } catch {
        console.error('\nAborted.');
        process.exit(130);
    }
}

function escapeForSingleQuoteString(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function memoImportPath(modulePath) {
    const rel = path.relative(path.dirname(modulePath), MEMO_LIB);
    return rel.startsWith('.') ? rel : `./${rel}`;
}

function ensureMemoLibImport(lines, modulePath) {
    const importPath = memoImportPath(modulePath);
    const importStatement = `import * as ${MEMO_LIB_NAME} from '${importPath}';`;
    const already = lines.some(l => {
        const trimmed = l.trim();
        return trimmed.startsWith('import') &&
            trimmed.includes(MEMO_LIB_NAME) &&
            trimmed.includes(importPath);
    });
    if (already) return { lines, added: false };

    let lastImportIndex = -1;
    let inImport = false;
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith('import ') || trimmed.startsWith('import{')) {
            inImport = true;
        }
        if (inImport) {
            if (/from\s+['"`]/.test(trimmed) || trimmed.endsWith(';')) {
                lastImportIndex = i;
                inImport = false;
            }
            continue;
        }
        if (lastImportIndex !== -1 && trimmed !== '' && !trimmed.startsWith('//')) {
            break;
        }
    }

    let insertIndex;
    if (lastImportIndex !== -1) {
        insertIndex = lastImportIndex + 1;
    } else {
        insertIndex = 0;
        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (trimmed.startsWith('#!')) continue;
            if (trimmed === '') continue;
            insertIndex = i;
            break;
        }
    }

    const newLines = [...lines];
    newLines.splice(insertIndex, 0, importStatement);
    return { lines: newLines, added: true };
}

function findMainInsertIndex(lines) {
    let mainLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/\b(?:async\s+)?function\s+main\b/.test(lines[i].trim())) {
            mainLineIndex = i;
            break;
        }
    }
    if (mainLineIndex === -1) return -1;
    for (let i = mainLineIndex; i < lines.length; i++) {
        if (lines[i].includes('{')) return i + 1;
    }
    return -1;
}

function injectMemoLine(filePath, moduleName, memoContent) {
    const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);

    const recallPattern = `${MEMO_LIB_NAME}.remember('${escapeForSingleQuoteString(moduleName)}', '${escapeForSingleQuoteString(memoContent)}')`;
    if (lines.some(l => l.includes(recallPattern))) {
        return { changed: false, reason: 'memo line already present' };
    }

    const importResult = ensureMemoLibImport(lines, filePath);
    const insertIndex = findMainInsertIndex(importResult.lines);
    if (insertIndex === -1) {
        return { changed: false, reason: 'could not locate main() body (library modules are not directly memoizable; their memos are prepended by importing scripts)' };
    }

    const refLine = importResult.lines[insertIndex] ?? '';
    const indent = (refLine.match(/^(\s*)/) || [])[1] || '    ';
    const newLines = [...importResult.lines];

    const hasRecall = newLines.some(l => l.includes(`${MEMO_LIB_NAME}.recallImports(`));
    if (!hasRecall) {
        newLines.splice(insertIndex, 0, `${indent}${MEMO_LIB_NAME}.recallImports(import.meta.url);`);
    }

    const recallLine = `${indent}${MEMO_LIB_NAME}.remember('${escapeForSingleQuoteString(moduleName)}', '${escapeForSingleQuoteString(memoContent)}');`;
    const rememberAt = hasRecall ? insertIndex : insertIndex + 1;
    newLines.splice(rememberAt, 0, recallLine);
    fs.writeFileSync(filePath, newLines.join('\n'));
    return { changed: true };
}

async function main(args = []) {
    if (args.includes('--help') || args.includes('-h')) {
        console.error('memo: Inject a single memo line into a module\'s main() function');
        console.error('  Usage: node index.js memo [module] [memoContent]');
        console.error('  Selects a module from scripts/ and lib/, prompts for memo content,');
        console.error('  then injects a `memo.remember(name, content)` call into its main().');
        console.error('  Library modules (no main()) are rejected; their memos are instead');
        console.error('  prepended by scripts that import them via memo.recallImports().');
        console.error('  When the instrumented module is later called, the memo is printed');
        console.error('  to stdout as "moduleName: memoContent".');
        console.error('  If the FORGET env variable is set, the memo array is cleared after printing.');
        return;
    }

    const nonFlag = args.filter(a => !a.startsWith('-') && a);
    const moduleArg = nonFlag[0];
    const memoContentArg = nonFlag.slice(1).join(' ');

    const modules = listAllModules();
    if (modules.length === 0) {
        console.error('No modules found.');
        process.exit(1);
    }

    const target = await promptModule(modules, moduleArg, 'Select a module to memoize');
    if (!fs.existsSync(target.path)) {
        console.error(`Module file not found: ${target.path}`);
        process.exit(1);
    }

    const memoContent = memoContentArg.trim() || await promptMemoContent();

    const result = injectMemoLine(target.path, target.name, memoContent);
    if (!result.changed) {
        console.error(`Skipped: ${result.reason}`);
        process.exit(1);
    }

    console.error(`✓ Memo injected into ${path.relative(PROJECT_ROOT, target.path)}`);
    console.error(`  When run, prints: ${target.name}: ${memoContent}`);
    if (process.env.FORGET) {
        console.error('  FORGET is set: memo array will be cleared after printing.');
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2));
}

export { injectMemoLine, main };

export default {
    name: 'memo',
    description: 'Inject a memo line into a module\'s main() function',
    main
};