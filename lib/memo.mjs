// Shared memo registry for modules instrumented by the `memo` script.
// A single `memo.remember(name, content)` call injected into a module's
// main() function records the memo, prints it to stdout as "name: content",
// and (when the FORGET env variable is set) clears the registry afterward.

export const memos = [];

export function remember(name, content) {
    memos.push({ name, content });
    console.log(`${name}: ${content}`);
    if (process.env.FORGET) {
        memos.length = 0;
    }
}

export function forget() {
    memos.length = 0;
}

export default { memos, remember, forget };