# Maintain Memoizability Skill

## Purpose
Documents how files can receive memos for tracking their API and operations. A "memoizable" module:
1. Exists in the project's module registry (tracked by lib/modules.mjs)  
2. Has a `.module-name.` side-car file format accepted by memo.walkAll()
3. Can store arbitrary string content via memo.remember(path, content)

## Memo Methods Available

- **memo.remember(moduleRef, content)** - Add memo to module file
- **memo.loadMemos(moduleRef)** - Load memos from file
- **memo.loadMemosWithTimestamps()** - Get memos sorted by lastModified
- **memo.clearBuffer()** - Reset in-memory buffer
- **memo.forgetAll()** - Clear all local memo files

## Typical Memo Structure for scripts/memo.mjs

```
OPERATIONS: bind() -> dispatch to handlers; init() -> set up state machines
or
FUNCTIONS: main(args[]) dispatches --flag operations to private functions
```