# Copilot Instructions for CORTEXA

## Quick references (canonical docs)

- Project overview & commands: [`README.md`](../README.md)
- Contribution & CI labels: [`CONTRIBUTING.md`](../CONTRIBUTING.md)
- Protocols & contracts: [`docs/cxlink-spec.md`](../docs/cxlink-spec.md), [`docs/api-examples.md`](../docs/api-examples.md)
- MCP server: [`docs/mcp-server.md`](../docs/mcp-server.md)
- Observability: [`docs/observability.md`](../docs/observability.md)
- Ops & safety: [`docs/operator-runbook.md`](../docs/operator-runbook.md), [`docs/security.md`](../docs/security.md)
- Containerization: [`docs/containerization.md`](../docs/containerization.md)

## Agent-specific guidance

- Setup + overview: [`/.agents/README.md`](../.agents/README.md)
- Extended Copilot guidance: [`/.agents/github-copilot-instructions.md`](../.agents/github-copilot-instructions.md)
- Specialist skills: [`/.agents/skills/`](../.agents/skills/)
- Role assistants: [`/.agents/assistants/`](../.agents/assistants/)

## Build, test, and lint commands

- **Prereqs:** Node `^20.11.1 || ^22`, `pnpm@9.15.0`
- **Install:** `pnpm install`
- **Build (workspace):** `pnpm run build`
- **Typecheck:** `pnpm run typecheck`
- **Primary runtime commands:**
  - CLI: `pnpm run cortexa -- <command>`
  - Daemon: `pnpm run cortexa:daemon`
  - MCP server: `pnpm run cortexa:mcp`

### Tests

- **Core baseline (from CONTRIBUTING/CI):**
  - `pnpm run test:unit`
  - `pnpm run test:observability`
  - `pnpm run test:mcp`
  - `pnpm run test:cli-routing`
  - `pnpm run test:evolution`
- **Integration set (CI):**
  - `pnpm run test:ingestion`
  - `pnpm run test:ingestion-scope`
  - `pnpm run test:compaction`
  - `pnpm run test:self-healing`
  - `pnpm run test:session-resurrection`
  - `pnpm run test:daemons`
  - `pnpm run test:llm`
  - `pnpm run test:branch-temporal`
- **Heavier gate (label-driven in PRs):**
  - `pnpm run test:agents-realistic`
  - In CI this runs on PRs only when label `ci:agents-realistic` is present.

### Running a single test

- This repo uses standalone `ts-node` test scripts (not Jest/Vitest).
- Run one file directly:
  - `pnpm exec ts-node tests/core-algorithms.unit.ts`
- Or use the matching package script when available:
  - `pnpm run test:unit`
  - `pnpm run test:mcp`

### Lint

- There is currently **no dedicated `lint` script** in `package.json`.
- `eslint` is installed as a dev dependency; if needed, run directly (for example): `pnpm exec eslint .`

## High-level architecture

CORTEXA is a local-first memory runtime with five main surfaces:

1. **Primary CLI (`cli/index.ts`)**
   - Command router for `ingest`, `query`, `context`, `llm`, `agents`, `memory`, `daemon`.
   - No-args mode starts daemon and opens interactive shell (`cortexa>`), and `exit` stops in-process daemon.
   - Supports top-level normalization like `--daemon`, `--llm`, and `agent` aliasing to `agents`.

2. **Daemon HTTP/WS (`apps/daemon/src/server.ts`)**
   - Express app with observability middleware, optional rate limiting, token auth, and JSON input hardening.
   - HTTP routes mount `ingest`, `query`, `context`, `evolve`, `cxlink/*`, plus health/metrics.
   - WS emits stream lifecycle events including `contextSuggested`, `branchSwitched`, `agentStatus`, `sessionResurrectionStatus`.

3. **Core runtime (`core/*` + `packages/core/src/*`)**
   - Ingestion pipeline parses code + Copilot chat transcripts, chunks content, and writes memories.
   - Retrieval/context stack performs hybrid ranking and token-bounded context compilation.
   - CX-LINK adapter builds CxF + envelope payloads used by daemon/CLI/MCP surfaces.

4. **Memory engine (`core/mempalace/*`)**
   - SQLite metadata + vector provider (Qdrant/Chroma/in-memory fallback) + graph indexing.
   - Branch-aware memory model (copy-on-write overlays + tombstones) with temporal `asOf` retrieval/diffs.
   - Compaction/resurrection layer with compact envelope format and integrity checks.

5. **MCP server (`apps/mcp-server/src/server.ts`)**
   - JSON-RPC over stdio; tools proxy to daemon endpoints.
   - Mutation tools are gated by `CORTEXA_MCP_ENABLE_MUTATIONS` and are off by default.

## Key conventions in this codebase

1. **API response shape and error contract**
   - Success responses use `ok: true`; failures use `ok: false` with explicit `error`.
   - Request IDs are attached at daemon middleware level and surfaced in headers/logs.
   - Keep payload changes additive-first, especially in CX-LINK contracts.

2. **Strict input normalization on daemon routes**
   - Route handlers consistently parse/trim/bound inputs using helpers in `core/daemon/http.ts` (`toTrimmedString`, `toBoundedInt`, `toBoundedNumber`, etc.).
   - Follow this pattern for new route parameters instead of ad-hoc parsing.

3. **Branch + temporal semantics are first-class**
   - `branch` defaults to `main` across CLI/daemon surfaces.
   - `asOf` is supported in retrieval/context/CX-LINK routes and maps to snapshot-based historical reads.
   - Branch deletes are modeled with tombstones to mask inherited parent memories.

4. **Ingestion defaults are opinionated**
   - `projectId` auto-infers from project directory name if not provided.
   - `includeChats` defaults to enabled; workspace-scoped Copilot transcript discovery is preferred.
   - `skipUnchanged` defaults to enabled and uses persisted source fingerprints + ingest versioning.

5. **Safety defaults for mutable operations**
   - Backfill and several operational endpoints default to dry-run behavior unless explicitly switched.
   - MCP mutation tools stay disabled unless opt-in env var is enabled.

6. **Test style**
   - Tests are executable TS scripts using `node:assert/strict`, typically with a local `main()` and explicit process exit on failure.
   - When adding tests, follow existing file naming (`*.unit.ts`, `*.integration.ts`) and invoke via `ts-node`.
