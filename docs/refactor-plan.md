# OpenAI Server Refactor Plan

## Objective
Make the OpenAI-compatible server interface modular and composable to enable rapid composition of optimizing and caching middleware for agentic work.

## Current State Analysis

### Key Issues
1. **Tight coupling**: `OpenAIServer` class handles HTTP, routing, forwarding, and middleware in one class
2. **No middleware abstraction**: Middleware is tightly coupled to the server class
3. **Limited composability**: Cannot easily create caching/optimizing middleware layers
4. **Testing difficulty**: Hard to test individual components in isolation

### Current Architecture
```
OpenAIServer (handles all concerns)
├── HTTP server (node:http)
├── Request routing
├── Middleware pipeline
├── Forwarding
└── Caching (KV cache used but not abstracted)
```

## Refactor Steps

### Step 1: Extract HTTP Server Core
**Goal**: Separate HTTP handling from business logic

**Changes**:
- Create `RequestHandler` class to handle individual requests
- Create `ResponseBuilder` for building responses
- `OpenAIServer` becomes a thin wrapper

**Files**:
- `src/server/request-handler.ts` (new)
- `src/server/response-builder.ts` (new)
- Modify `src/server/OpenAIServer.ts`

### Step 2: Create Middleware Registry
**Goal**: Enable composable middleware registration and execution

**Changes**:
- Create `MiddlewareRegistry` class
- Define `Middleware` interface with `match`, `process`, `transform` methods
- Allow runtime middleware registration

**Files**:
- `src/server/middleware-registry.ts` (new)
- Modify `src/server/middleware/pipeline.ts`

### Step 3: Abstract Caching Layer
**Goal**: Create a reusable caching abstraction

**Changes**:
- Create `CacheLayer` interface
- Implement `KVCacheLayer` using existing `kv.ts`
- Enable caching as composable middleware

**Files**:
- `src/server/cache-layer.ts` (new)
- `src/server/caching-middleware.ts` (new)

### Step 4: Create Optimizer Patterns
**Goal**: Enable rapid composition of optimizing middleware

**Changes**:
- Create base `Optimizer` class
- Implement specific optimizers (prompt caching, response caching, etc.)
- Create factory functions for common optimizers

**Files**:
- `src/server/optimizer.ts` (new)
- `src/server/optimizers/` (new directory)

### Step 5: Bash Short-Circuit Refactor
**Goal**: Make bash middleware more composable and testable

**Changes**:
- Extract pattern matching into `PatternMatcher` class
- Create `CommandExecutor` interface
- Make middleware stateless and composable

**Files**:
- `src/server/middleware/bash-shortcircuit.ts` (modify)
- `src/server/pattern-matcher.ts` (new)

## Testing Strategy

Each step will have:
1. Unit tests for new classes
2. Integration tests for composed behavior
3. Backward compatibility tests

## Success Criteria

1. Each component can be tested in isolation
2. Middleware can be composed without modifying server code
3. Caching layers can be added/removed easily
4. Optimizers can be created and combined rapidly
5. All existing functionality preserved

## Memo Tracking

Use the memo system to track:
- Refactor progress
- Test coverage
- Issues discovered
- Performance improvements