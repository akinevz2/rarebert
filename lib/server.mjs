import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { PROJECT_ROOT } from './core.mjs';
import { resolveOpencode } from './opencode.mjs';

const SERVER_DIR = path.join(PROJECT_ROOT, '.opencode');
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
        const bin = resolveOpencode();
        const args = [cwd, '-m', model, '--port', String(port)];
        if (prompt) args.push('--prompt', prompt);
        console.log(`$ opencode ${args.join(' ')}  (password=${port})`);

        this.writeInfo(port, this.url(port), process.pid);

        const env = { ...process.env, OPENCODE_SERVER_PASSWORD: String(port) };
        const result = spawnSync(bin, args, { stdio: 'inherit', cwd, env });
        this.clearInfo();
        return result.status ?? 0;
    }

    attachMini({ url, port } = {}) {
        const bin = resolveOpencode();
        const args = ['attach', url, '--mini', '-u', 'opencode', '-p', String(port)];
        console.log(`$ opencode ${args.join(' ')}`);
        const result = spawnSync(bin, args, { stdio: 'inherit' });
        return result.status ?? 0;
    }

    runOnServer({ url, port, prompt, model = null, auto = false } = {}) {
        const bin = resolveOpencode();
        const args = ['run', prompt, '--attach', url, '-u', 'opencode', '-p', String(port)];
        if (auto) args.push('--auto');
        if (model) args.push('-m', model);
        console.log(`$ opencode ${args.join(' ')}`);
        const result = spawnSync(bin, args, {
            cwd: PROJECT_ROOT,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'inherit']
        });
        return {
            status: result.status ?? 0,
            stdout: (result.stdout ?? '').trim()
        };
    }

    cwdForModule(rel) {
        if (!rel) return PROJECT_ROOT;
        const abs = path.join(PROJECT_ROOT, rel);
        const dir = path.dirname(abs);
        if (path.relative(PROJECT_ROOT, dir).startsWith('src')) return dir;
        return PROJECT_ROOT;
    }
}

const server = new Server();

const readServerInfo = () => server.readInfo();
const writeServerInfo = (port, url, pid) => server.writeInfo(port, url, pid);
const clearServerInfo = () => server.clearInfo();
const probeServer = (url, port) => server.probe(url, port);
const getRunningServer = () => server.getRunning();
const serverUrl = (port) => server.url(port);
const startFullTUI = (opts) => server.startFullTUI(opts);
const attachMini = (opts) => server.attachMini(opts);
const runOnServer = (opts) => server.runOnServer(opts);
const cwdForModule = (rel) => server.cwdForModule(rel);

export {
    Server,
    server,
    SERVER_FILE,
    DEFAULT_PORT,
    DEFAULT_HOST,
    readServerInfo,
    writeServerInfo,
    clearServerInfo,
    probeServer,
    getRunningServer,
    serverUrl,
    startFullTUI,
    attachMini,
    runOnServer,
    cwdForModule
};

export default {
    Server,
    server,
    SERVER_FILE,
    DEFAULT_PORT,
    DEFAULT_HOST,
    readServerInfo,
    writeServerInfo,
    clearServerInfo,
    probeServer,
    getRunningServer,
    serverUrl,
    startFullTUI,
    attachMini,
    runOnServer,
    cwdForModule
};
