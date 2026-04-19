<div align="center">
  <img src="assets/Art.png" alt="CORTEXA Art" width="100%" />
  <h1>CORTEXA</h1>
  <p><strong>Local-First Cognitive Runtime & Developer Memory OS</strong></p>
  <p>
    <img src="https://img.shields.io/badge/Status-Alpha-blue?style=flat-square" alt="Status" />
    <img src="https://img.shields.io/badge/Language-TypeScript-007acc?style=flat-square&logo=typescript" alt="TS" />
    <img src="https://img.shields.io/badge/Env-Node.js_20%2F22-339933?style=flat-square&logo=node.js" alt="Node" />
  </p>
</div>

<br />

CORTEXA is a local-first memory runtime for software development workflows. It ingests code and chat history, stores optimized memory units, retrieves relevant context with hybrid ranking, and compiles prompt-ready context for coding agents and tools.

**CX-LINK** is CORTEXA’s context exchange protocol: a stable contract for turning retrieval results + constraints into agent-ready envelopes (`/cxlink/context`, `/cxlink/query`, `/cxlink/plan`).

This README is fully updated for:
- primary `cortexa` CLI wiring (ingestion, resurrection, compaction, dashboard)
- primary `cortexa` progression evolve command telemetry
- compaction + deterministic resurrection pipeline
- third-wave compaction dashboard payload with trend snapshots and per-project risk/anomaly reporting
- daemon HTTP/WS routes and operational scripts

---

## What’s in CORTEXA today

- **Hybrid memory store (`Mempalace`)**
  - SQLite metadata (`better-sqlite3`)
  - vector index provider: `qdrant` / `chroma` / in-memory fallback
- **Ingestion pipeline**
  - code parsing/chunking + AST-derived hints
  - optional Copilot chat transcript/session ingestion
- **Compaction + resurrection**
  - compact envelope format: `cortexa://mem/compact/v1/`
  - Brotli payload + checksum verification
  - deterministic resurrection at read/retrieval time
- **Compaction analytics**
  - stats, dry-run/apply backfill, dashboard payloads
  - persisted trend snapshots (`memory_compaction_snapshots`)
  - integrity anomaly tracking (`invalidChecksum`, `decodeError`)
- **Self-healing scheduler hardening**
  - persisted scheduler run history (`self_healing_run_history`) across restarts
  - exponential backoff on repeated run failures
  - rolling-window SLO counters for `applied` / `dry-run-only` / `skipped` / `error`
- **Context compiler**
  - token-bounded packing
  - copilot-friendly content summaries (`copilotContent`) for lower token cost
- **Daemon APIs + WS stream**
  - query/context/evolve/cxlink + compaction endpoints

---

## Architecture (high level)

```text
Primary CLI (cortexa)
  ├── ingest        (code/chat ingestion)
  ├── query         (hybrid retrieval)
  ├── context       (token-bounded context compile)
  ├── memory        (list/search/get/resurrect/delete/stats/backfill/dashboard)
  ├── dashboard     (alias => memory dashboard)
  └── daemon        (local HTTP + WS runtime)
           ↓
Mempalace (core memory engine)
  ├── SQLite metadata + snapshots
  ├── Vector index (Qdrant/Chroma/InMemory)
  ├── Compaction + resurrection layer
  └── Retrieval + ranking + context formatting
```

---

## Prerequisites

- Node.js `^20.11.1` or `^22.0.0`
- `pnpm@9.15.0`

---

## Setup

```bash
git clone <your-repo-url>
cd Cortexta
pnpm install
pnpm run build
```

Optional health checks:

```bash
pnpm run doctor
pnpm run typecheck
```

---

## Docs Index

- [`docs/api-examples.md`](docs/api-examples.md) — Copy/paste JSON request and response examples for all daemon endpoints.
- [`docs/operator-runbook.md`](docs/operator-runbook.md) — Day-1 and Day-2 operational workflows (setup, maintenance, compaction, troubleshooting).
- [`docs/cxlink-spec.md`](docs/cxlink-spec.md) — CX-LINK protocol spec (concepts, contract, versioning, route semantics).
- [`docs/containerization.md`](docs/containerization.md) — Docker/Docker Compose setup for daemon + Qdrant.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — Contribution workflow, quality gates, and PR checklist.

---

## 5-minute workflow (end-to-end)

```bash
pnpm install
pnpm run doctor

# 1) ingest project memory
pnpm run cortexa -- ingest . --project-id=my-project --max-files=500 --no-include-chats

# 2) retrieve and compile context
pnpm run cortexa -- query "how is cxlink context assembled?"
pnpm run cortexa -- context "add a new daemon route with tests"

# 3) run progression telemetry
pnpm run cortexa -- evolve "improve progression selection quality" --project-id=my-project --dry-run --json

# 4) run daemon for API clients
pnpm run cortexa:daemon
```

In another terminal (optional API smoke check):

```bash
curl -s http://localhost:4312/health
curl -s -X POST http://localhost:4312/cxlink/context -H "content-type: application/json" -d '{"query":"wire telemetry","projectId":"my-project"}'
```

---

## Primary CLI (source of truth)

Use the primary CLI through:

```bash
pnpm run cortexa -- <command> [args]
```

> The `--` delimiter is intentionally supported/normalized in the primary CLI.

### Command reference

#### `init`

Initialize SQLite schema + vector collection bootstrap.

```bash
pnpm run cortexa -- init
```

#### `ingest`

Ingest code and (by default) chat sessions.

```bash
pnpm run cortexa -- ingest <path> [options]
```

Options:
- `--project-id=<id>`
- `--no-include-chats`
- `--no-skip-unchanged` (force full re-ingest)
- `--skip-unchanged=<true|false>`
- `--max-files=<n>`
- `--max-chat-files=<n>`
- `--chat-root=<path>`

Examples:

```bash
pnpm run cortexa -- ingest .
pnpm run cortexa -- ingest . --project-id=my-service --max-files=1500 --max-chat-files=500
pnpm run cortexa -- ingest . --no-include-chats
```

#### `query`

Hybrid memory retrieval.

```bash
pnpm run cortexa -- query "how did we harden websocket streaming?"
```

#### `context`

Compile a prompt-ready context payload.

```bash
pnpm run cortexa -- context "add retry-safe checkpointing"
```

#### `evolve`

Run progression-aware memory evolution from freeform text and surface stage telemetry.

```bash
pnpm run cortexa -- evolve "upgrade evolution progression telemetry"
```

Options:
- `--project-id=<id>` (default `default`)
- `--context=<text>` (optional context hint)
- `--dry-run` (compute progression without persisting)
- `--json` or `--format=json` (emit full telemetry payload)

#### `daemon`

Manage local daemon runtime.

```bash
pnpm run cortexa -- daemon start
pnpm run cortexa -- daemon status
pnpm run cortexa -- daemon stop
```

#### `memory`

Memory lifecycle + compaction ops.

```bash
pnpm run cortexa -- memory <action> [args/options]
```

Actions:

- `list [projectId] [--limit=<n>]`
- `search <query> [--project-id=<id>] [--top-k=<n>] [--min-score=<0..1>]`
- `get <id> [--full]`
- `resurrect <id> [--full]`
- `delete <id>`
- `stats [--project-id=<id>]`
- `audit [--project-id=<id>] [--limit=<n>] [--max-issues=<n>] [--json]`
- `backfill [--project-id=<id>] [--limit=<n>] [--apply]`
- `dashboard [dashboard-options]`

Examples:

```bash
pnpm run cortexa -- memory list --limit=20
pnpm run cortexa -- memory search "compaction checksum"
pnpm run cortexa -- memory resurrect <id>
pnpm run cortexa -- memory stats --project-id=Cortexta
pnpm run cortexa -- memory audit --project-id=Cortexta --limit=5000 --max-issues=10
pnpm run cortexa -- memory backfill --limit=2000           # dry-run by default
pnpm run cortexa -- memory backfill --limit=2000 --apply   # persist updates
```

#### `dashboard` (alias)

Equivalent to `memory dashboard ...`.

```bash
pnpm run cortexa -- dashboard --no-persist-snapshot --trend-rows=10 --top-projects=20
```

Dashboard options (primary CLI):
- `--json` or `--format=json`
- `--project-id=<id>`
- `--lookback-days=<n>`
- `--max-trend-points=<n>`
- `--max-projects=<n>`
- `--no-persist-snapshot`
- `--per-project-snapshot-limit=<n>`
- `--snapshot-retention-days=<n>`
- `--top-projects=<n>`
- `--trend-rows=<n>`
- `--out-json=<path>`
- `--out-human=<path>`

---

## Standalone scripts

### Compaction maintenance script

```bash
pnpm run compact:memory -- --limit=1000
pnpm run compact:memory -- --projectId=Cortexta --limit=5000 --apply
```

- dry-run by default
- `--apply` to persist

### Dashboard script

```bash
pnpm run dashboard:compaction -- --help
pnpm run dashboard:compaction -- --no-persist-snapshot
pnpm run dashboard:compaction -- --json --out-json=./tmp/dashboard.json
pnpm run dashboard:compaction -- --out-human=./tmp/dashboard.txt
```

Output modes:
- human-readable terminal report (default)
- JSON payload for automation (`--json` / `--format=json`)

---

## Daemon APIs

Start daemon:

```bash
pnpm run cortexa -- daemon start
```

Base default:
- HTTP: `http://localhost:4312`
- WS: `ws://localhost:4321`

### Auth

- If `CORTEXA_DAEMON_TOKEN` is set (and not placeholder), send either:
  - header `x-cortexa-token: <token>`
  - or `Authorization: Bearer <token>`

### Routes

- `GET /health`
- `POST /ingest`
- `POST /query`
- `POST /context`
- `POST /evolve`
- `POST /evolve/progression`
- `POST /cxlink/context`
- `POST /cxlink/query`
- `POST /cxlink/plan`
- `POST /cxlink/compaction/stats`
- `POST /cxlink/compaction/backfill`
- `POST /cxlink/compaction/dashboard`
- `POST /cxlink/compaction/audit`
- `POST /cxlink/compaction/self-heal/status`
- `POST /cxlink/compaction/self-heal/trigger`

`/cxlink/context`, `/cxlink/query`, and `/cxlink/plan` responses now also include a `memoryHealth` signal so agent runtimes can react to compaction/anomaly posture.

The daemon health payload now includes summarized self-healing scheduler status (`enabled`, `started`, `running`, `nextRunAt`, `lastScheduledDelayMs`, `consecutiveFailures`, `lastOutcome`, `runCount`, `slo`).

`POST /evolve` supports two modes:
- **consolidate mode** (existing behavior): no `text` field, runs compaction-style consolidation preview/apply over stored memories.
- **progression mode** (new): include `text` (and optional `context`) to run `evolveWithProgression(...)` and return stage telemetry (`progression`).

`POST /evolve/progression` is a strict alias for progression mode and always requires `text` (returns `400` when missing).

---

## Compaction + resurrection model

### Envelope format

- Prefix: `cortexa://mem/compact/v1/`
- Encoded envelope includes:
  - codec (`br64`)
  - original char count
  - preview text
  - payload (Brotli)
  - optional checksum

### Read-time behavior

- `getMemoryById()` and memory retrieval paths resurrect compacted content.
- `copilotContent` is generated as token-bounded preview content for context compilation.
- Integrity anomalies are tracked as:
  - `invalidChecksum`
  - `decodeError`

### Dashboard snapshot persistence

- Snapshot table: `memory_compaction_snapshots`
- Stores global + selected per-project snapshots
- Drives trend views and risk/anomaly reporting

### Self-healing run history persistence

- Scheduler history table: `self_healing_run_history`
- Persists every scheduler/manual run payload so status survives daemon restarts
- Powers rolling-window SLO counters exposed by status + health payloads

---

## Configuration (env vars)

### Core storage/vector

- `CORTEXA_DB_PATH` (default: `data/cortexa.db`)
- `CORTEXA_VECTOR_PROVIDER` (`qdrant` | `chroma` | `memory`, default `qdrant`)
- `CORTEXA_VECTOR_URL` (Qdrant endpoint, default `http://localhost:6333`)
- `CORTEXA_CHROMA_URL` (Chroma endpoint, default `http://localhost:8001`)
- `CORTEXA_EMBEDDING_URL` (optional external embedding service)

### Ingestion

- `CORTEXA_INGEST_MAX_FILE_BYTES` (default: `786432`)

### Compaction tuning

- `CORTEXA_MEM_COMPACT_MIN_CHARS`
- `CORTEXA_MEM_COMPACT_MIN_WIN_RATIO`
- `CORTEXA_MEM_COMPACT_PREVIEW_CHARS`
- `CORTEXA_MEM_COPILOT_PREVIEW_CHARS`
- `CORTEXA_MEM_COMPACT_BROTLI_QUALITY`

### Daemon

- `CORTEXA_DAEMON_PORT` (default `4312`)
- `CORTEXA_WS_PORT` (default `4321`)
- `CORTEXA_DAEMON_TOKEN`
- `CORTEXA_DAEMON_BODY_LIMIT` (default `6mb`)
- `CORTEXA_DAEMON_AUTOSTART` (`0` disables module auto-start)

### Self-healing scheduler

- `CORTEXA_SELF_HEAL_ENABLED` (default `false`)
- `CORTEXA_SELF_HEAL_PROJECT_ID` (optional; default all projects)
- `CORTEXA_SELF_HEAL_INTERVAL_MS` (default `1800000`)
- `CORTEXA_SELF_HEAL_JITTER_MS` (default `60000`)
- `CORTEXA_SELF_HEAL_RUN_ON_START` (default `false`)
- `CORTEXA_SELF_HEAL_AUDIT_LIMIT` (default `5000`)
- `CORTEXA_SELF_HEAL_AUDIT_MAX_ISSUES` (default `20`)
- `CORTEXA_SELF_HEAL_BACKFILL_LIMIT` (default `5000`)
- `CORTEXA_SELF_HEAL_APPLY_ENABLED` (default `false`)
- `CORTEXA_SELF_HEAL_MAX_ALLOWED_ANOMALIES` (default `0`)
- `CORTEXA_SELF_HEAL_MIN_OPPORTUNITY_RATE` (default `0.2`)
- `CORTEXA_SELF_HEAL_MIN_DRY_RUN_COMPACTED_ROWS` (default `50`)
- `CORTEXA_SELF_HEAL_MAX_APPLY_ROWS` (default `2000`)
- `CORTEXA_SELF_HEAL_APPLY_WINDOW_START_HOUR` (default `1`)
- `CORTEXA_SELF_HEAL_APPLY_WINDOW_END_HOUR` (default `5`)
- `CORTEXA_SELF_HEAL_HISTORY_LIMIT` (default `50`)
- `CORTEXA_SELF_HEAL_PERSIST_HISTORY` (default `true`)
- `CORTEXA_SELF_HEAL_PERSISTED_HISTORY_LIMIT` (default `2000`)
- `CORTEXA_SELF_HEAL_BACKOFF_ENABLED` (default `true`)
- `CORTEXA_SELF_HEAL_BACKOFF_MULTIPLIER` (default `2`)
- `CORTEXA_SELF_HEAL_BACKOFF_MAX_INTERVAL_MS` (default `min(8x interval, 24h)`)
- `CORTEXA_SELF_HEAL_SLO_WINDOWS_MINUTES` (default `60,1440,10080`)

---

## Testing and verification

```bash
pnpm run typecheck
pnpm run test:unit
pnpm run test:self-healing
pnpm run test:compaction
pnpm run test:daemons
```

CI runs on GitHub Actions with a Node matrix (`20`, `22`) and an integration suite gate on Node `22`.

---

## Open-source and distribution

- License: [MIT](LICENSE)
- npm package metadata is configured for public distribution (`cortexa`)
- Runtime support: Node `^20.11.1` and `^22.0.0`

For containerized deployments, see [`docs/containerization.md`](docs/containerization.md).

---

## Troubleshooting

- **Unexpected daemon startup while running CLI command**
  - primary CLI now lazy-loads daemon command; non-daemon commands should not auto-start daemon.
- **Vector backend unavailable messages**
  - CORTEXA falls back to SQLite lexical behavior and deterministic embeddings where possible.
- **Backfill did not persist**
  - `memory backfill` and `compact:memory` default to dry-run; use `--apply`.
- **No dashboard trend points**
  - enable snapshot persistence (don’t use `--no-persist-snapshot`) and run dashboard repeatedly.
- **Self-healing runs but never applies backfill**
  - check safety gates in status/last run reasons (`/cxlink/compaction/self-heal/status`), especially anomaly guardrail, opportunity threshold, and apply-window hours.
- **Self-healing scheduler keeps failing repeatedly**
  - check `consecutiveFailures`, `lastScheduledDelayMs`, and `slo.windows` in `/cxlink/compaction/self-heal/status` or `/health`.
  - if needed, widen `CORTEXA_SELF_HEAL_BACKOFF_MAX_INTERVAL_MS` and inspect latest `error` run payload in persisted history.

---

## Package scripts quick list

```bash
pnpm run doctor
pnpm run build
pnpm run dev
pnpm run typecheck
pnpm run test:self-healing
pnpm run test:compaction
pnpm run test:daemons
pnpm run cortexa -- <command>
pnpm run cortexa:daemon
pnpm run compact:memory -- --limit=1000
pnpm run dashboard:compaction -- --help
```

---

<div align="center">
  <i>"Don't memorize tokens. Preserve and retrieve semantics."</i>
</div>
