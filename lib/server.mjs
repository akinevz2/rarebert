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

    stop(pid = null) {
        const info = pid ? { pid } : this.getRunning();
        if (info && info.pid) {
            try {
                process.kill(info.pid, 'SIGTERM');
            } catch (err) {
                console.error(`Failed to kill server process ${info.pid}: ${err.message}`);
            }
        }
        this.clearInfo();
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

    /**
     * Start a headless `opencode serve` in the background (detached) and
     * wait for it to accept connections on `port`. The child outlives the
     * parent process so the session persists for later `make open`/`make
     * edit` attach. Server info is written to the info file so subsequent
     * `getRunning()` calls find it.
     *
     * @param {{ port?: number, model?: string|null, timeout?: number }} [options]
     * @returns {Promise<{ url: string, port: number, pid: number } | null>}
     *   Resolves with the server info on success, or null if the server
     *   did not become reachable within `timeout` ms.
     */
    startHeadless({ port = this.port, model = null, timeout = 10000 } = {}) {
        const bin = opencode.resolve();
        const args = ['serve', '--port', String(port)];
        console.log(`$ opencode ${args.join(' ')}  (headless, password=${port})`);

        const env = { ...process.env, OPENCODE_SERVER_PASSWORD: String(port) };

        let child;
        try {
            child = spawn(bin, args, {
                stdio: 'ignore',
                detached: true,
                env,
                cwd: current.root
            });
        } catch (err) {
            console.error(`Failed to launch opencode serve: ${err.message}`);
            return Promise.resolve(null);
        }
        if (child.error) {
            console.error(`Failed to launch opencode serve: ${child.error.message}`);
            return Promise.resolve(null);
        }

        // Detach so the server outlives this process.
        child.unref();
        this.writeInfo(port, this.url(port), child.pid);

        const url = this.url(port);
        const deadline = Date.now() + timeout;
        return new Promise((resolve) => {
            const tryProbe = () => {
                if (this.probe(url, port)) return resolve({ url, port, pid: child.pid });
                if (Date.now() >= deadline) {
                    console.error(
                        `server: headless server did not become reachable on ${url} within ${timeout}ms`
                    );
                    resolve(null);
                } else {
                    setTimeout(tryProbe, 250);
                }
            };
            tryProbe();
        });
    }

    attachFull({ url, port } = {}) {
        const bin = opencode.resolve();
        const args = ['attach', url, '-u', 'opencode', '-p', String(port)];
        console.log(`$ opencode ${args.join(' ')}`);
        const result = spawnSync(bin, args, { stdio: 'inherit' });
        return result.status ?? 0;
    }

    spawnAttach({ url, port, mini = false } = {}) {
        const bin = opencode.resolve();
        const args = ['attach', url];
        if (mini) args.push('--mini');
        args.push('-u', 'opencode', '-p', String(port));
        console.log(`$ opencode ${args.join(' ')}`);
        const child = spawn(bin, args, { stdio: 'inherit' });
        if (child.error) {
            console.error(`Failed to launch opencode attach: ${child.error.message}`);
            return { status: 1, child: null };
        }
        return { status: null, child };
    }

    spawnMini({ url, port } = {}) {
        return this.spawnAttach({ url, port, mini: true });
    }

    spawnFull({ url, port } = {}) {
        return this.spawnAttach({ url, port, mini: false });
    }

    submitInstruction({ url, port, prompt, file, model = null, auto = true } = {}) {
        const bin = opencode.resolve();
        const args = ['run'];
        if (prompt) args.push(prompt);
        if (file) {
            if (Array.isArray(file)) for (const f of file) args.push('-f', f);
            else args.push('-f', file);
        }
        args.push('--attach', url, '--dir', current.root, '-u', 'opencode', '-p', String(port));
        if (auto) args.push('--auto');
        if (model) args.push('-m', model);
        console.log(
            `$ opencode ${args.slice(0, Math.min(args.length, 3)).join(' ')} ... --attach ${url}`
        );
        const child = spawn(bin, args, { cwd: current.root, stdio: 'ignore' });
        if (child.error) {
            console.error(`Failed to launch opencode run: ${child.error.message}`);
            return { status: 1, child: null };
        }
        return { status: null, child };
    }

    attachFullAsync({ url, port } = {}) {
        const bin = opencode.resolve();
        const args = ['attach', url, '-u', 'opencode', '-p', String(port)];
        console.log(`$ opencode ${args.join(' ')}`);
        const child = spawn(bin, args, { stdio: 'inherit' });
        if (child.error) {
            console.error(`Failed to launch opencode: ${child.error.message}`);
            return { status: 1, child: null };
        }
        return { status: null, child };
    }

    /**
     * Start a full interactive TUI attached to a running opencode server.
     *
     * The returned child process runs in the foreground (stdio inherited).
     * The caller is expected to await its exit separately.
     *
     * @param {{ url: string, port: number }} opts
     * @returns {{ status: number|null, child: import('child_process').ChildProcess|null }}
     */
    startAttachableTUI({ url, port } = {}) {
        const bin = opencode.resolve();
        const args = ['attach', url, '-u', 'opencode', '-p', String(port)];
        console.log(`$ opencode ${args.join(' ')}`);
        const child = spawn(bin, args, { stdio: 'inherit' });
        if (child.error) {
            console.error(`Failed to launch opencode TUI: ${child.error.message}`);
            return { status: 1, child: null };
        }
        return { status: null, child };
    }

    /**
     * Submit a prompt to the same session displayed by a foreground TUI.
     *
     * Uses `--continue` to target the last session on the attached server,
     * running in `--auto` mode with captured stdout so it does not interfere
     * with the interactive TUI rendering.  The prompt (and optional file) are
     * delivered to the agent and the result is returned when the run finishes.
     *
     * @param {{ url: string, port: number, prompt: string, file?: string|string[], model?: string }} opts
     * @returns {{ status: number, stdout: string }}
     */
    submitPromptToForegroundTUI({ url, port, prompt, file, model } = {}) {
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
            '--continue',
            '--auto',
            '-u',
            'opencode',
            '-p',
            String(port)
        );
        if (model) args.push('-m', model);
        console.log(
            `$ opencode ${args.slice(0, Math.min(args.length, 3)).join(' ')} ... --attach ${url}`
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

    attachMini({ url, port } = {}) {
        const bin = opencode.resolve();
        const args = ['attach', url, '--mini', '-u', 'opencode', '-p', String(port)];
        console.log(`$ opencode ${args.join(' ')}`);
        const result = spawnSync(bin, args, { stdio: 'inherit' });
        return result.status ?? 0;
    }

    runInteractive({ url, port, file, prompt, model, continueSession = true } = {}) {
        const bin = opencode.resolve();
        const args = [
            'run',
            ...(prompt ? [prompt] : []),
            ...(file ? (Array.isArray(file) ? file.flatMap((f) => ['-f', f]) : ['-f', file]) : []),
            '--attach',
            url,
            '--dir',
            current.root,
            '-i',
            '-u',
            'opencode',
            '-p',
            String(port),
            ...(continueSession ? ['--continue'] : []),
            ...(model ? ['-m', model] : [])
        ];
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
