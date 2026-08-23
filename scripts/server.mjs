#!/usr/bin/env node

import { exit } from '../lib/core.mjs';
import { CLI, tui, TUI } from '../lib/module.mjs';
import { OpenAIServer } from '../src/server/OpenAIServer.ts';

const meta = {
    name: 'server',
    description: 'Start an OpenAI-compatible server that forwards requests to a backend',
    usage: 'node index.js server [--port <num>] [--base-url <url>]',
    options: [
        { flag: '--port <num>', description: 'Port to listen on', default: 11444 },
        { flag: '--base-url <url>', description: 'Backend URL to forward requests to', default: 'http://localhost:11434/v1' }
    ]
};

export { meta };

export default new CLI('server.mjs', async (opts) => {
    const port = opts.port;
    const baseURL = opts.baseUrl;

    const server = new OpenAIServer({ port, baseURL });

    try {
        const handle = server.start();

        // Graceful shutdown on SIGINT / SIGTERM
        let shuttingDown = false;
        const shutdown = async () => {
            if (shuttingDown) return;
            shuttingDown = true;
            console.log('\n[server] shutting down...');
            await handle.close();
        };
        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);

        // Wait for the server to stop, then exit with its code
        const code = await handle.stopped;

        return exit(code, new TUI('server.mjs', async (o = opts) => {
            if (!tui.isInteractive) return;
            console.log('Server is running in the background');
        }));
    } catch (error) {
        console.error('Failed to start server:', error);
        return exit(1);
    }
}, meta).supportsDirectRunning(import.meta.url);