#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { rarebert } from '../lib/projects.mjs';
import { exit } from '../lib/core.mjs';
import { memo } from '../lib/memo.mjs';
import { server, DEFAULT_PORT } from '../lib/server.mjs';
import { models } from '../lib/models.mjs';
import { cli, AbortError } from '../lib/cli.mjs';

function detectLanguage(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.py' || ext === '.py3') return 'python';
    if (ext === '.sh' || ext === '.bash') return 'bash';
    return 'javascript';
}

async function parseAndAnalyzeFile(filePath, lang) {
    const content = fs.readFileSync(filePath, 'utf-8');

    const imports = [];

    if (lang === 'python') {
        const importRegex = /(?:^import\s+([a-zA-Z_\.]+))|^from\s+([a-zA-Z_\.]+)\s+import/gm;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
            const imp = match[1] || match[2];
            if (imp && !imports.includes(imp)) imports.push(imp);
        }
    } else if (lang === 'javascript') {
        const importRegex = /import\s+(?:{[^}]*}|\w+)\s+from\s+['"]([^'"]+)['"]/g;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
            if (!imports.includes(match[1])) imports.push(match[1]);
        }
    }

    const exportLines = content.split('\n').filter(l => l.match(/export\s+/));
    
    return { imports };
}

function extractCodeSections(content, lang) {
    const sections = [];
    const lines = content.split('\n');
    
    let sectionStart = 0;
    let braceCount = 0;
    let inFunction = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (!inFunction && /^(?:async\s+)?function\s+\w+|^\s*async\s+func|^def\s+\w+/.test(line)) {
            inFunction = true;
            sectionStart = i;
            braceCount = 0;
        }

        if (inFunction) {
            braceCount += (line.match(/{/g) || []).length;
            braceCount -= (line.match(/}/g) || []).length;

            if (braceCount === 0 && line.includes('}')) {
                sections.push({
                    startLine: sectionStart + 1,
                    endLine: i + 1,
                    content: lines.slice(sectionStart, i + 1).join('\n')
                });
                inFunction = false;
            }
        }

        if (sections.length >= 5) break;
    }

    return sections;
}

async function load(moduleRef, options = {}) {
    const verbose = options.verbose || false;

    let modulePath;

    if (!moduleRef) {
        throw new Error('Module reference is required');
    }

    if (fs.existsSync(path.resolve(moduleRef))) {
        modulePath = path.resolve(moduleRef);
    } else if (rarebert.relPath(moduleRef)) {
        const found = [...rarebert.discover(), ...rarebert.discover()].find(m => 
            m.path === moduleRef || m.name === moduleRef
        );
        if (found) {
            modulePath = rarebert.absPath(found.path);
        }
    }

    if (!modulePath || !fs.existsSync(modulePath)) {
        throw new Error(`Module not found: ${moduleRef}`);
    }

    const relPath = rarebert.relPath(modulePath);
    const lang = detectLanguage(modulePath);
    const content = fs.readFileSync(modulePath, 'utf-8');

    console.log(`Semantic analysis of: ${relPath} (${lang})`);

    memo.remember(
        modulePath,
        `purpose: Semantic analysis for ${path.basename(modulePath)} - analyzed via opencode`
    );

    const { imports } = await parseAndAnalyzeFile(modulePath, lang);

    let importMemoStr = 'imports:';
    for (const imp of imports.slice(0, 20)) {
        if (!imp.startsWith(' ')) {
            importMemoStr += ` '${imp}'`;
        } else {
            importMemoStr += `; ${imp}`;
        }
    }
    memo.remember(modulePath, importMemoStr);

    const exportedFuncs = [];

    for (const line of content.split('\n')) {
        const funcMatch = line.match(/^(?:async\s+)?(?:function|def)\s+(\w+)/m);
        if (funcMatch && !exportedFuncs.includes(funcMatch[1])) {
            exportedFuncs.push(funcMatch[1]);
        }
    }

    memo.remember(modulePath, `exports: ${exportedFuncs.join(', ')}`);

    const sections = extractCodeSections(content, lang);

    for (let i = 0; i < Math.min(sections.length, 3); i++) {
        const section = sections[i];

        const instruction = `You are an AI assistant analyzing code for semantic understanding.

Analyze this code block from ${relPath} at lines ${section.startLine}-${section.endLine}.

Code:
\`\`\`${lang}
${content.split('\n').slice(section.startLine - 1, section.endLine).join('\n')}
\`\`\`

Provide a concise summary (2-3 sentences) describing what this code block does and its purpose.`;

        console.log(`\nAnalyzing section ${i + 1}/${Math.min(sections.length, 3)}...`);

        try {
            const serverRunning = server.getRunning();

            if (serverRunning) {
                const result = server.runOnServer({
                    url: serverRunning.url,
                    port: serverRunning.port,
                    prompt: instruction,
                    auto: true
                });

                if (result.stdout && result.stdout.trim()) {
                    memo.remember(modulePath, `section-${i + 1}: ${result.stdout.trim()}`);
                    console.log(`  Summary: ${result.stdout.trim().substring(0, 80)}...`);
                }
            } else {
                const model = await models.resolve(null);

                const result = await server.startFullTUI({
                    cwd: rarebert.root,
                    model: model || 'opencode',
                    port: DEFAULT_PORT + 1,
                    prompt: instruction
                });

                if (result !== 0) {
                    memo.remember(modulePath, `section-${i + 1}: Analysis could not be completed`);
                }
            }
        } catch (err) {
            console.log(`  Warning: Could not analyze section ${i + 1}: ${err.message}`);
            memo.remember(modulePath, `section-${i + 1}: analysis skipped due to error`);
        }
    }

    const resolvedImports = [];
    for (const imp of imports) {
        if (!imp.startsWith('.')) continue;

        try {
            const fullPath = path.resolve(path.dirname(modulePath), imp.replace(/['"]/g, ''));
            const actualPath = fs.existsSync(fullPath + '.mjs') ? fullPath + '.mjs' : 
                              (fs.existsSync(fullPath) ? fullPath : null);

            if (actualPath && fs.existsSync(actualPath)) {
                resolvedImports.push(rarebert.relPath(actualPath));
            }
        } catch {}
    }

    memo.remember(modulePath, `imported_files: ${resolvedImports.join('; ')}`);

    console.log(`\n✓ Analysis complete for ${relPath}`);

    return { path: modulePath, relative: relPath, language: lang };
}

async function main(args = []) {
    if (args.length === 0) {
        console.error('Usage: node index.js analyze <module> [-v]');
        return exit(1);
    }

    const moduleArg = args.find(a => !a.startsWith('-'));
    const verbose = args.includes('-v') || args.includes('--verbose');

    try {
        await load(moduleArg, { verbose });
    } catch (err) {
        console.error('Error:', err.message);
        return exit(1);
    }

    return exit(0);
}

export { load, main };

export default {
    name: 'analyze',
    description: 'Analyze a module semantically by reading entry point and documenting code sections with opencode',
    usage: 'node index.js analyze <module>',
    options: [{ flag: '-v, --verbose', label: '', description: 'Show verbose output' }]
};