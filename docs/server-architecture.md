# Server Architecture

> **Status**: Implemented — `src/server/` (TypeScript, `--experimental-strip-types`)

## Overview

The Rarebert server is an **OpenAI-compatible HTTP proxy** with a
**programmable routing middleware pipeline**. It listens on a configurable
port (default `11444`) and forwards OpenAI-compatible API requests to a
backend baseURL (default `http://localhost:11434/v1`).

The core idea: during moments of model inactivity (idle), previous
conversation messages are introspected by the model to classify and
tokenise direct bash-command requests. Future messages matching known
tokenised commands are intercepted by the server, executed locally, and
returned as wrapped assistant messages — never reaching the backend.

## File Structure

```
src/server/
├── types.ts                      # Core type definitions (ServerConfig, OpenAI types, etc.)
├── database.ts                   # SQLite persistence layer (node:sqlite)
├── kv.ts                         # In-memory KV cache (Map-based, LRU + TTL)
├── OpenAIServer.ts               # Main HTTP server class (node:http)
└── middleware/
    ├── types.ts                  # Middleware interface, context, result types
    ├── pipeline.ts               # MiddlewarePipeline class (register/process/transform)
    └── bash-shortcircuit.ts      # Bash-command short-circuit middleware
```

## Runtime

The server is written in TypeScript and runs via [`tsx`](https://github.com/privatenumber/tsx)
— a TypeScript runtime that handles `.ts` imports transparently. No build
step is required.

```bash
npx tsx index.js server --port 11444 --base-url http://localhost:11434/v1
```

Or via the npm script:

```bash
npm run server -- --port 11444 --base-url http://localhost:11434/v1
```

## Key Components

### OpenAIServer (`src/server/OpenAIServer.ts`)

The main server class. Uses `node:http` — no external HTTP framework.

**Constructor**: `new OpenAIServer(PartialServerConfig)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | `number` | `11444` | TCP port to listen on |
| `baseURL` | `string` | `http://localhost:11434/v1` | Backend URL to forward to |
| `dbPath` | `string?` | `$XDG_DATA_HOME/rarebert/server.db` | SQLite database path |
| `idleTimeoutMs` | `number` | `30000` | Idle timeout before introspection |

**Methods**:
- `start()` → `ServerHandle` — Returns `{ stopped: Promise<number>, close(): Promise<void> }`
- `registerMiddleware(mw)` — Register additional middleware at runtime
- `unregisterMiddleware(name)` — Remove middleware by name
- `listMiddleware()` — List all registered middleware
- `getConfig()` — Return current configuration

### Database (`src/server/database.ts`)

SQLite persistence using `node:sqlite` `DatabaseSync`. Independent from
`lib/core.mjs`'s `Store` class — no `lib/` code is used.

**Tables**:
- `classified_messages` — Binary classification results from introspection
- `bash_command_patterns` — Tokenised bash commands for short-circuit matching
- `server_config` — Key/value server configuration

**Methods**: `saveClassification`, `getRecentClassifications`, `savePattern`,
`getAllPatterns`, `matchPatterns`, `deletePattern`, `getConfig`, `setConfig`

### KV Cache (`src/server/kv.ts`)

Pure `Map`-based in-memory cache with LRU eviction and TTL support.

- `KVCache<V>` — Generic class, `get`, `set`, `delete`, `clear`, `has`, `entries`
- `kvCache` — Singleton `KVCache<string>` for general use
- `objectCache` — Singleton `KVCache<unknown>` for arbitrary values

### Middleware Pipeline (`src/server/middleware/pipeline.ts`)

Runs registered middleware in two phases:

1. **Request phase** — `process()` called in registration order. First
   `ShortCircuitResult` wins; subsequent middleware is skipped.
2. **Response phase** — `transform()` called in reverse registration order,
   only if the request was forwarded (not short-circuited).

## API Endpoints

| Method | Path | Behaviour |
|--------|------|-----------|
| `GET` | `/v1/health` | Returns `{ "status": "ok" }` — no middleware, no forwarding |
| `GET` | `/v1/models` | Returns models from backend (cached 5 min in KV) |
| `POST` | `/v1/chat/completions` | Runs middleware pipeline, then forwards or short-circuits |
| `POST` | `/v1/completions` | Forwarded directly to backend |
| `*` | `*` | Forwarded directly to backend |

## CLI Interface

```bash
npx tsx index.js server [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--port <num>` | `11444` | Port to listen on |
| `--base-url <url>` | `http://localhost:11434/v1` | Backend URL to forward to |

## Design Principles

1. **OOP + Procedural** — TypeScript classes at the top of each module file,
   grouped by functionality in folders.
2. **No `lib/` dependencies** — The `src/` implementation is self-contained.
   Only `scripts/server.mjs` uses `lib/module.mjs` for CLI runner infrastructure.
3. **No external npm deps** — Uses `node:http`, `node:sqlite`, global `fetch`.
4. **Extensible** — Middleware can be registered at runtime or config time.
5. **TypeScript-first** — All server code in TypeScript, strict mode.

## Relationship to `lib/server.mjs`

`lib/server.mjs` manages the **opencode process lifecycle** (spawn, port
probing, server info files). It is **not** the HTTP server and is marked
as outdated for HTTP server purposes. The OpenAI-compatible HTTP server
lives entirely in `src/server/`.

See also: [Middleware Framework](middleware.md)
