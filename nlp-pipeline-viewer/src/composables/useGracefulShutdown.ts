/**
 * useGracefulShutdown — Vue composable that runs once at app mount.
 *
 * Subscribes to Vite's HMR custom events and reacts to:
 *
 *     { type: "custom", event: "rarebert:shutdown", data: { graceMs } }
 *
 * When received, the composable:
 *   1. flushes any transient state to localStorage,
 *   2. sends an ack back via `import.meta.hot.send("rarebert:shutdown-ack")`
 *      so Vite can finish its graceful exit promptly,
 *   3. attempts `window.close()` (only succeeds when the window was
 *      opened by script — the Scala Swing host will use window.open()
 *      in Phase 3, so this will work in that case).
 *
 * In production builds (no HMR), this composable is a no-op.
 */

import { onBeforeUnmount, onMounted } from "vue";

interface ShutdownPayload {
    graceMs?: number;
}

const SHUTDOWN_STORAGE_KEY = "rarebert:shutdown:ack";

type HotLike = {
    on: (event: string, handler: (data: unknown) => void) => void;
    send: (event: string, data?: unknown) => void;
};

function getHot(): HotLike | null {
    try {
        const meta = import.meta as unknown as { hot?: HotLike };
        return meta.hot ?? null;
    } catch {
        return null;
    }
}

export function useGracefulShutdown(): void {
    let hot: HotLike | null = null;
    let dispose: (() => void) | null = null;

    const handleShutdown = (payload: unknown) => {
        const data = (payload && typeof payload === "object"
            ? (payload as ShutdownPayload)
            : {}) as ShutdownPayload;

        // Record that we received the signal so the app can suppress
        // subsequent fetches / API calls that would fail anyway.
        try {
            window.localStorage.setItem(
                SHUTDOWN_STORAGE_KEY,
                JSON.stringify({ at: Date.now(), graceMs: data.graceMs ?? null }),
            );
        } catch {
            // localStorage may be disabled — ignore.
        }

        // Acknowledge so Vite can finish its graceful exit promptly.
        try {
            hot?.send("rarebert:shutdown-ack", { at: Date.now() });
        } catch {
            // ignore
        }

        // Try to close the window.  Only succeeds for windows opened via
        // window.open() (i.e. the Scala Swing host case).  If the user
        // opened the browser manually, the tab stays open with stale UI
        // until they close it.
        try {
            window.close();
        } catch {
            // ignore
        }
    };

    onMounted(() => {
        hot = getHot();
        if (!hot) return;
        hot.on("rarebert:shutdown", handleShutdown);
        dispose = () => {
            // Vite's hot API doesn't expose an off() — we hold the reference
            // so the handler can be swapped if needed in future.
        };
    });

    onBeforeUnmount(() => {
        if (dispose) dispose();
    });
}