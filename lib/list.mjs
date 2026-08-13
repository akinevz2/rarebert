import { home } from './projects.mjs';

function listOne(project) {
    const scripts = home.discoverModules(project.dir, project.exts);
    if (scripts.length === 0) {
        console.log(`${project.rel}/ (0 modules)`);
        return;
    }
    console.log(
        `${project.rel}/ (${scripts.length} module${scripts.length === 1 ? '' : 's'}):`
    );
    for (const mod of scripts) {
        const scriptMeta = home.getScriptMetadata(home.absPath(mod.path));
        console.log(`  ${mod.path.padEnd(24)}${scriptMeta.description || ''}`);
    }
}

async function listModules(args = []) {
    const hasDirectoryFlag = args.some(
        (a) =>
            a === '--lib' ||
            a === '--src' ||
            a === '--supports' ||
            a === '--scripts' ||
            a === '--script'
    );
    if (hasDirectoryFlag) {
        const directory = await home.resolveDirectory(args, 'scripts');
        const project = home.projectByKey(directory);
        if (project) listOne(project);
        return;
    }

    const projects = home.discover();
    for (const project of projects) {
        if (project !== projects[0]) console.log();
        listOne(project);
    }
}

export { listOne, listModules };
export default { listOne, listModules };