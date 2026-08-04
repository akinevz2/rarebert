import fs from 'fs';
import path from 'path';

const DIRECTORIES = ['scripts', 'lib', 'src'];

class Project {
    constructor(root) {
        this.root = root;
        this.scriptsDir = path.join(root, 'scripts');
        this.libDir = path.join(root, 'lib');
        this.srcDir = path.join(root, 'src');
    }

    discover(dir = this.scriptsDir, exts = ['.mjs', '.js']) {
        if (!fs.existsSync(dir)) return [];
        return fs
            .readdirSync(dir)
            .filter((f) => exts.some((ext) => f.endsWith(ext)))
            .map((f) => {
                const rel = path.relative(this.root, path.join(dir, f));
                return { name: path.basename(rel, path.extname(rel)), path: rel };
            });
    }

    absPath(rel) {
        return path.isAbsolute(rel) ? rel : path.join(this.root, rel);
    }

    relPath(abs) {
        return path.relative(this.root, abs);
    }
}

export { Project, DIRECTORIES };
export default Project;
