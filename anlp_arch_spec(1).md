# ANLP Coevolution System — Architecture Spec

## Overview
A polyglot simulation where Python manages agent lifecycle and Java provides swappable algorithmic implementations. Agents acquire behaviour at runtime via lateral adoption of compiled Java classes — analogous to horizontal gene transfer in bacterial evolution.

## Components

**`Makefile`** — single entry point. Compiles all `.java` files in the working directory, then invokes the Python arena via a named rule (`make simulate`).

**`Arena` (Python)** — the petri dish. Instantiates a population of `Agent` objects, runs the generational loop, administers fitness evaluation, and mediates inter-agent interactions (recombination, competition over spans).

**`Agent` (Python)** — thin wrapper implementing a fixed interface:
- `classify(tokens) → List[Span]`
- `display_gene()`
- `mutate()`
- `combine(other: Agent) → Agent`
- `invoke(method: str, *args)` — POSTs to the bound Quarkus endpoint over localhost HTTP

On spawn, each `Agent` randomly selects one base URL from the available Quarkus resource paths and binds to it. All interface calls are forwarded as HTTP POST requests with JSON-serialised bodies; responses are deserialised and returned to the arena.

**Quarkus application** — a long-lived Java 25 / Quarkus 3.31 HTTP server started once by the Makefile and terminated when the simulation exits. It acts as a pure functional projection into the algorithmic layer: it owns no simulation state, holds no agent identity, and carries no mutable fields between requests. Every endpoint is a stateless pure function — gene and token data arrive in the request body, a transformed result is returned, and nothing is retained. This makes the server trivially safe for concurrent access. Endpoints are annotated `@RunOnVirtualThread`, delegating each request to a Project Loom virtual thread; hundreds of concurrent agent calls are handled with the OS-thread overhead of a small fixed pool. Current resource classes: `RuleAgentResource` (LCS-style rule evolution) and `WeightAgentResource` (perceptron-style token scoring), each exposing `/classify`, `/mutate`, and `/recombine` routes. Adding an implementation is a matter of adding a new JAX-RS resource class — Quarkus CDI picks it up on the next application start.

## Data Flow
```
Makefile → mvn quarkus:run (Quarkus HTTP server, port 8080)
Makefile → python arena.py
Arena    → spawn Agent population
Agent    → randomly bind to one of {/rule-agent, /weight-agent, ...}
Arena    → generational loop
  Agent.classify() → POST localhost:8080/{binding}/classify  (JSON)
  Agent.combine()  → offspring inherits one parent's base-URL binding
  Agent.mutate()   → POST localhost:8080/{binding}/mutate    (JSON)
Makefile → terminate Quarkus process
```

## Lateral Transfer Mechanic
An agent may re-bind to a different Quarkus resource path at a configurable low probability each generation — simulating horizontal gene transfer. Because lateral transfer is simply a base-URL reassignment in the Python object, no process lifecycle is involved; the cost is negligible. This allows a weight-based agent to defect to rule-based behaviour mid-simulation if its current binding is underperforming.
