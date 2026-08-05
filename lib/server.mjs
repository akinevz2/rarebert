import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { rarebert, current } from './projects.mjs';
import { opencode } from './opencode.mjs';

const SERVER_DIR = path.join(rarebert.root, '.opencode');
const SERVER_FILE = path.join(SERVER_DIR, 'server');
const DEFAULT_PORT = 4096;
const DEFAULT_HOST = '127.0.0.1';

class Server {
    constructor() {
        this.dir = SERVER_DIR;
        this.file = SERVER_FILE;
        this.port = DEFAULT_PORT;
        this.host = DEFAULT_HOST;
    }

    readInfo() {
        if (!fs.existsSync(this.file)) return null;
        try {
            const raw = fs.readFileSync(this.file, 'utf-8').trim();
            if (!raw) return null;
            const info = JSON.parse(raw);
            if (!info || !info.url || !info.port) return null;
            return info;
        } catch {
            return null;
        }
    }

    writeInfo(port, url, pid = null) {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify({ port, url, pid }, null, 2));
    }

    clearInfo() {
        if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
    }

    probe(url, port) {
        const probeScript = `
const net = require('net');
const m = ${JSON.stringify(url)}.match(/^https?:\\/\\/([^:/]+):(\\d+)/);
const host = m ? m[1] : ${JSON.stringify(DEFAULT_HOST)};
const p = m ? parseInt(m[2]) : ${port};
const socket = new net.Socket();
socket.setTimeout(2000);
socket.on('connect', () => { socket.destroy(); process.exit(0); });
socket.on('error', () => process.exit(1));
socket.on('timeout', () => { socket.destroy(); process.exit(1); });
socket.connect(p, host);
`;
        try {
            const result = spawnSync(process.execPath, ['-e', probeScript], {
                timeout: 3000,
                stdio: 'ignore'
            });
            return result.status === 0;
        } catch {
            return false;
        }
    }

    getRunning() {
        const info = this.readInfo();
        if (!info) return null;
        if (!this.probe(info.url, info.port)) return null;
        return info;
    }

    url(port) {
        return `http://${this.host}:${port}`;
    }

    startFullTUI({ cwd, model, port = this.port, prompt = null } = {}) {
        const bin = opencode.resolve();
        const args = [cwd, '-m', model, '--port', String(port)];
        if (prompt) args.push('--prompt', prompt);
        console.log(`$ opencode ${args.join(' ')}  (password=${port})`);

        const env = { ...process.env, OPENCODE_SERVER_PASSWORD: String(port) };

        return new Promise((resolve) => {
            const child = spawn(bin, args, { stdio: 'inherit', cwd, env });
            if (child.error) {
                console.error(`Failed to launch opencode: ${child.error.message}`);
                this.clearInfo();
                return resolve(1);
            }

            this.writeInfo(port, this.url(port), child.pid);

            child.on('exit', (code) => {
                this.clearInfo();
                resolve(code ?? 0);
            });
            child.on('error', (err) => {
                console.error(`opencode server error: ${err.message}`);
                this.clearInfo();
                resolve(1);
            });
        });
    }

    attachMini({ url, port } = {}) {
        const bin = opencode.resolve();
        const args = ['attach', url, '--mini', '-u', 'opencode', '-p', String(port)];
        console.log(`$ opencode ${args.join(' ')}`);
        const result = spawnSync(bin, args, { stdio: 'inherit' });
        return result.status ?? 0;
    }

    runInteractive({ url, port, file, prompt, model, continueSession = true } = {}) {
        const bin = opencode.resolve();
        const args = ['run'];
        if (prompt) args.push(prompt);
        if (file) {
            if (Array.isArray(file)) for (const f of file) args.push('-f', f);
            else args.push('-f', file);
        }
        args.push(
            '--attach',
            url,
            '--dir',
            current.root,
            '-i',
            '-u',
            'opencode',
            '-p',
            String(port)
        );
        if (continueSession) args.push('--continue');
        if (model) args.push('-m', model);
        console.log(
            `$ opencode ${args.slice(0, Math.min(args.length, 3)).join(' ')} ... --attach ${url}`
        );
        const child = spawn(bin, args, { cwd: current.root, stdio: 'inherit' });
        if (child.error) {
            console.error(`Failed to launch opencode: ${child.error.message}`);
            return { status: 1, child: null };
        }
        return { status: null, child };
    }

    isLocalUrl(url) {
        const host = String(url)
            .replace(/^https?:\/\//i, '')
            .split(':')[0];
        return host === DEFAULT_HOST || host === 'localhost' || host === '127.0.0.1';
    }

    attachToServer({ url, port, prompt, model, auto = false } = {}) {
        const bin = opencode.resolve();
        const message = prompt ?? '';
        const args = ['run'];
        if (message) args.push(message);
        args.push('--attach', url, '--dir', current.root, '-u', 'opencode', '-p', String(port));
        if (auto) args.push('--auto');
        if (model) args.push('-m', model);
        console.log(
            `$ opencode ${args.slice(0, Math.min(args.length, 2)).join(' ')} ... --attach ${url}`
        );
        const result = spawnSync(bin, args, {
            cwd: current.root,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'inherit']
        });
        return {
            status: result.status ?? 0,
            stdout: (result.stdout ?? '').trim()
        };
    }

    runHeadless({ prompt, model, auto = true } = {}) {
        const bin = opencode.resolve();
        const message = prompt ?? '';
        const args = ['run'];
        if (message) args.push(message);
        args.push('--auto');
        if (model) args.push('-m', model);
        console.log(
            `$ opencode ${args.slice(0, Math.min(args.length, 2)).join(' ')} ... (headless, no server)`
        );
        const result = spawnSync(bin, args, {
            cwd: current.root,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'inherit']
        });
        return {
            status: result.status ?? 0,
            stdout: (result.stdout ?? '').trim()
        };
    }

    async runOnServer({
        project = current,
        url,
        port = DEFAULT_PORT,
        prompt,
        model = null,
        auto = false
    } = {}) {
        const running = this.getRunning();

        if (running) {
            return this.attachToServer({
                url: running.url,
                port: running.port,
                prompt,
                model,
                auto
            });
        }

        if (url && !this.isLocalUrl(url)) {
            return this.attachToServer({ url, port, prompt, model, auto });
        }

        if (auto) {
            console.log(`server: no running local server; running headless (opencode run --auto)`);
            return this.runHeadless({ prompt, model, auto });
        }

        console.log(`server: no running local server; starting full TUI on port ${port}`);
        return {
            status: await this.startFullTUI({ cwd: current.root, model, port }),
            stdout: ''
        };
    }

    cwdForModule(rel) {
        if (!rel) return rarebert.root;
        const abs = path.join(rarebert.root, rel);
        const dir = path.dirname(abs);
        if (path.relative(rarebert.root, dir).startsWith('src')) return dir;
        return rarebert.root;
    }
}

const server = new Server();
export { Server, server, DEFAULT_PORT, DEFAULT_HOST };
export default server;
