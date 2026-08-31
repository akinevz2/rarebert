import { exit, ExitSignal } from './core.mjs';
import { CLEAR_SCREEN } from './symbols.mjs';

// ---------------------------------------------------------------------------
// Runtime — runs a module (or a submodule chain) to process exit.
//
// This is the single entry point both execution paths funnel through:
//   - the dispatcher (index.js runModule), and
//   - direct execution (`node scripts/<name>.mjs` via
//     Module.supportsDirectRunning).
//
// Keeping submodule running here means it is a Runtime concern, not a
// growing surface of Module methods: Module only executes its main
// callback; the Runtime folds every result kind through the exit()
// machinery (ExitSignal → complete(); Error → error kind; thenable →
// promise kind; string → fail message; number → code), drives submodule
// chains via ExitSignal.complete(), and terminates the process with the
// final code.
// ---------------------------------------------------------------------------

/**
 * Run `mod` with `args` and terminate the process with the resulting
 * exit code. Never resolves in the normal path — the process exits
 * inside this function.
 *
 * @param {object} mod - a Module-like object: `{ path, execute(args), isInteractive? }`
 * @param {Array} args - argv for the module's main callback
 */
async function run(mod, args = []) {
    let result;
    try {
        result = await mod.execute(args);
    } catch (err) {
        // Error kind — route through the exit() machinery so abort
        // callbacks run and AbortError maps to its own code (130).
        result = exit(err);
    }

    if (result === undefined) {
        console.error(
            `${mod.path}: main callback returned undefined — use exit() to signal completion.`
        );
        process.exit(1);
    }

    // Continuation kinds fold into the signal machinery instead of ad-hoc
    // process.exit() branches: a main callback may return an Error, a
    // promise, a message string, or a bare code and the same complete()
    // path handles cleanup, onExit, and the final code.
    if (!(result instanceof ExitSignal)) {
        if (
            result instanceof Error ||
            (result && typeof result.then === 'function') ||
            typeof result === 'string' ||
            typeof result === 'number'
        ) {
            result = exit(result);
        } else {
            console.error(
                `${mod.path}: main callback returned ${typeof result} — expected an ExitSignal from exit().`
            );
            process.exit(1);
        }
    }

    const finalCode = await result.complete();
    const exitCode = typeof finalCode === 'number' ? finalCode : result.code;

    // Submodule chains: a TUI submodule asks for a screen clear after its
    // run so the next shell line doesn't clash with TUI output.
    if (result.isSubmodule()) {
        const submodule = result.submodule;
        if (submodule && submodule.clearScreen && mod.isInteractive?.()) {
            process.stdout.write(CLEAR_SCREEN);
        }
    }

    process.exit(exitCode);
}

export { run };
export default { run };
