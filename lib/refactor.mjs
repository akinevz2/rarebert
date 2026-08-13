function formatReport(damageReport, format) {
    if (format === 'json') {
        return JSON.stringify(damageReport, null, 2);
    }

    if (format === 'markdown') {
        const lines = [
            `# Refactor Damage Report`,
            ``,
            `Entry: ${damageReport.entry}`,
            `Baseline: ${damageReport.baselineRef}`,
            `Snapshot: ${new Date(damageReport.snapshotTimestamp).toISOString()}`,
            `Damaged files: ${damageReport.damagedFiles.length}`,
            ``,
            `| File | Line | Binding | Issue | Relocated To |`,
            `|------|------|---------|-------|--------------|`
        ];
        for (const d of damageReport.damage) {
            const relocated = d.relocatedTo ? d.relocatedTo.file : '—';
            lines.push(`| ${d.file} | ${d.line} | ${d.binding} | ${d.issue} | ${relocated} |`);
        }
        return lines.join('\n');
    }

    if (format === 'prompt') {
        const lines = [
            `The following imports are broken after a refactor.`,
            `Fix each one by updating the import statement to point to the correct source.`,
            `Do not change any logic — only repair the import declarations.`,
            ``
        ];
        for (const d of damageReport.damage) {
            lines.push(`File: ${d.file}:${d.line}`);
            lines.push(`  Problem: ${d.issue}`);
            if (d.relocatedTo) {
                lines.push(`  Binding moved to: ${d.relocatedTo.file}`);
            }
            lines.push(``);
        }
        return lines.join('\n');
    }
}

function printUsage(meta, subcommands) {
    console.log(`Usage: ${meta.usage}\n`);
    console.log('Subcommands:');
    for (const [name, desc] of Object.entries(subcommands)) {
        console.log(`  ${name.padEnd(10)} ${desc}`);
    }
    console.log(`\nOptions:`);
    for (const opt of meta.options) {
        console.log(`  ${opt.flag.padEnd(22)} ${opt.description}`);
    }
}

export { formatReport, printUsage };
export default { formatReport, printUsage };