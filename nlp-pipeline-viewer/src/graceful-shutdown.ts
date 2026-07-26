/**
 * Vite plugin: graceful-shutdown
 *
 * Adds a single HTTP endpoint, POST /__shutdown, that orchestrates a
 * cascade shutdown of the entire rarebert stack.  From inside Vite's
 * own process we:
 *
 *   1. broadcast a custom HMR event so any connected browser tab can
 *      persist state and close itself;
 *   2. wait up to ``graceMs`` for tabs to acknowledge;
 *   3. POST ``/shutdown`` to the SSE bridge;
 *   4. POST ``/shutdown`` to the launcher;
 *   5. close the HTTP server and let Node exit naturally.
 *
 * The whole cascade has a hard cap (``hardExitMs``) so Vite never hangs
 * indefinitely — if a downstream is unreachable we proceed anyway.
 *
 * Configuration via environment variables (the launcher sets these when
 * spawning ``npm run dev``):
 *
 *   RAREBERT_BRIDGE_HOST   bridge host (default 127.0.0.1)
 *   RAREBERT_BRIDGE_PORT   bridge port (default 8338)
 *   RAREBERT_LAUNCHER_HOST launcher host (default 127.0.0.1)
 *   RAREBERT_LAUNCHER_PORT launcher port (default 0 — skip)
 */

import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";

interface ShutdownPluginOptions {
    path?: string;
    graceMs?: number;
    hardExitMs?: number;
}

const DEFAULTS: Required<ShutdownPluginOptions> = {
    path: "/__shutdown",
    graceMs: 1500,
    hardExitMs: 4000,
};

function postShutdown(host: string, port: number, path: string, timeoutMs: number): Promise<boolean> {
    if (port <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
        const req = http.request(
            {
                host,
                port,
                method: "POST",
                path,
                timeout: timeoutMs,
                headers: { "Content-Length": "0" },
            },
            (res) => {
                res.resume();
                res.on("end", () => resolve(res.statusCode !== undefined && res.statusCode < 400));
                res.on("error", () => resolve(false));
            },
        );
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
        req.end();
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function gracefulShutdownPlugin(
    options: ShutdownPluginOptions = {},
): Plugin {
    const opts = { ...DEFAULTS, ...options };

    const bridgeHost = process.env.RAREBERT_BRIDGE_HOST || "127.0.0.1";
    const bridgePort = parseInt(process.env.RAREBERT_BRIDGE_PORT || "8338", 10);
    const launcherHost = process.env.RAREBERT_LAUNCHER_HOST || "127.0.0.1";
    const launcherPort = parseInt(process.env.RAREBERT_LAUNCHER_PORT || "0", 10);

    return {
        name: "rarebert-graceful-shutdown",
        apply: "serve",

        configureServer(server: ViteDevServer) {
            let shuttingDown = false;

            const shutdown = async (): Promise<void> => {
                if (shuttingDown) return;
                shuttingDown = true;

                const hardCap = sleep(opts.hardExitMs).then(() => "cap");

                const cascade = (async () => {
                    // Phase 1 — broadcast shutdown to every connected tab.
                    try {
                        server.ws.send("rarebert:shutdown", { graceMs: opts.graceMs });
                    } catch (exc) {
                        console.warn("[graceful-shutdown] ws.send failed:", exc);
                    }

                    // Phase 2 — give tabs a moment to ack and close.
                    await sleep(opts.graceMs);

                    // Phase 3 — cascade to bridge and launcher in parallel.
                    // They are independent so we race them.
                    const tasks: Promise<unknown>[] = [];
                    tasks.push(
                        postShutdown(bridgeHost, bridgePort, "/shutdown", 1000)
                            .then((ok) => console.log(`[graceful-shutdown] bridge ${ok ? "ack" : "no-reply"}`)),
                    );
                    if (launcherPort > 0) {
                        tasks.push(
                            postShutdown(launcherHost, launcherPort, "/shutdown", 1000)
                                .then((ok) => console.log(`[graceful-shutdown] launcher ${ok ? "ack" : "no-reply"}`)),
                        );
                    }
                    await Promise.race([Promise.all(tasks), hardCap]);
                })();

                await Promise.race([cascade, hardCap]);

                // Phase 4 — close the HTTP server.  Use a Promise so we can
                // race against the hard cap; if close hangs we just exit.
                console.log("[graceful-shutdown] closing HTTP server");
                const httpServer = server.httpServer;
                if (httpServer) {
                    await Promise.race([
                        new Promise<void>((resolve) => {
                            httpServer.close(() => resolve());
                            const maybeCloseAll = (httpServer as unknown as {
                                closeAllConnections?: () => void;
                            }).closeAllConnections;
                            if (typeof maybeCloseAll === "function") maybeCloseAll.call(httpServer);
                        }),
                        sleep(500),
                    ]);
                }

                console.log("[graceful-shutdown] exiting");
                process.exit(0);
            };

            // ── HTTP middleware ──
            server.middlewares.use(opts.path, (req: IncomingMessage, res: ServerResponse) => {
                if (req.method !== "POST") {
                    res.statusCode = 405;
                    res.setHeader("Allow", "POST");
                    res.end("Method Not Allowed");
                    return;
                }
                // Drain any request body before responding.
                req.resume();
                req.on("end", () => {
                    res.statusCode = 200;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ status: "shutting_down" }));

                    // Run the cascade asynchronously so the response flushes.
                    setImmediate(() => {
                        shutdown().catch((exc) => {
                            console.error("[graceful-shutdown] error:", exc);
                            process.exit(1);
                        });
                    });
                });
            });
        },
    };
}