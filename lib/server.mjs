import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { PROJECT_ROOT } from './core.mjs';
import { resolveOpencode } from './opencode.mjs';

const SERVER_DIR = path.join(PROJECT_ROOT, '.opencode');
export const SERVER_FILE = path.join(SERVER_DIR, 'server');
export const DEFAULT_PORT = 4096;
export const DEFAULT_HOST = '127.0.0.1';

export function readServerInfo() {
    if (!fs.existsSync(SERVER_FILE)) return null;
    try {
        const raw = fs.readFileSync(SERVER_FILE, 'utf-8').trim();
        if (!raw) return null;
        const info = JSON.parse(raw);
        if (!info || !info.url || !info.port) return null;
        return info;
    } catch {
        return null;
    }
}

export function writeServerInfo(port, url, pid = null) {
    fs.mkdirSync(SERVER_DIR, { recursive: true });
    fs.writeFileSync(SERVER_FILE, JSON.stringify({ port, url, pid }, null, 2));
}

export function clearServerInfo() {
    if (fs.existsSync(SERVER_FILE)) fs.unlinkSync(SERVER_FILE);
}

export function probeServer(url, port) {
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

export function getRunningServer() {
    const info = readServerInfo();
    if (!info) return null;
    if (!probeServer(info.url, info.port)) return null;
    return info;
}

export function serverUrl(port) {
    return `http://${DEFAULT_HOST}:${port}`;
}

export function startFullTUI({ cwd, model, port = DEFAULT_PORT, prompt = null } = {}) {
    const bin = resolveOpencode();
    const args = [cwd, '-m', model, '--port', String(port)];
    if (prompt) args.push('--prompt', prompt);
    console.log(`$ opencode ${args.join(' ')}  (password=${port})`);

    writeServerInfo(port, serverUrl(port), process.pid);

    const env = { ...process.env, OPENCODE_SERVER_PASSWORD: String(port) };
    const result = spawnSync(bin, args, { stdio: 'inherit', cwd, env });
    clearServerInfo();
    return result.status ?? 0;
}

export function attachMini({ url, port } = {}) {
    const bin = resolveOpencode();
    const args = ['attach', url, '--mini', '-u', 'opencode', '-p', String(port)];
    console.log(`$ opencode ${args.join(' ')}`);
    const result = spawnSync(bin, args, { stdio: 'inherit' });
    return result.status ?? 0;
}

export function runOnServer({ url, port, prompt, model = null, auto = false } = {}) {
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

export function cwdForModule(rel) {
    if (!rel) return PROJECT_ROOT;
    const abs = path.join(PROJECT_ROOT, rel);
    const dir = path.dirname(abs);
    if (path.relative(PROJECT_ROOT, dir).startsWith('src')) return dir;
    return PROJECT_ROOT;
}

export default {
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
