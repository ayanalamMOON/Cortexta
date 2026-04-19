# CORTEXA Operator Runbook (Day 1 / Day 2)

This runbook is for local operators running CORTEXA via the primary CLI.

[← Back to README](../README.md)

## Runbook flow overview

```mermaid
flowchart LR
  A[Bootstrap environment] --> B[Initialize and ingest]
  B --> C[Run daemon and verify health]
  C --> D[Daily checks]
  D --> E[Weekly maintenance]
  E --> F[Troubleshoot and recover]
```

| Cadence  | Primary objective                 | Typical commands                                    |
| -------- | --------------------------------- | --------------------------------------------------- |
| Day 1    | Bring runtime online safely       | `doctor`, `init`, `ingest`, `daemon status`         |
| Daily    | Verify posture and drift          | `daemon status`, `dashboard`, `memory stats`        |
| Weekly   | Reduce storage risk and anomalies | `memory backfill`, `memory audit`, dashboard export |
| Incident | Restore correctness quickly       | audit, inspect records, re-ingest, targeted delete  |

---

## Day 1: Bootstrap a healthy environment

### 1) Verify toolchain

```bash
pnpm run doctor
pnpm run typecheck
```

### 2) Configure environment (optional but recommended)

Create `.env` in repo root if you need overrides:

```env
CORTEXA_DB_PATH=data/cortexa.db
CORTEXA_VECTOR_PROVIDER=qdrant
CORTEXA_VECTOR_URL=http://localhost:6333
CORTEXA_DAEMON_TOKEN=replace-with-secure-token

# Optional self-healing scheduler (safe by default)
CORTEXA_SELF_HEAL_ENABLED=true
CORTEXA_SELF_HEAL_PROJECT_ID=cortexta
CORTEXA_SELF_HEAL_RUN_ON_START=true
CORTEXA_SELF_HEAL_APPLY_ENABLED=false
CORTEXA_SELF_HEAL_MAX_ALLOWED_ANOMALIES=0
CORTEXA_SELF_HEAL_MIN_OPPORTUNITY_RATE=0.2
CORTEXA_SELF_HEAL_MIN_DRY_RUN_COMPACTED_ROWS=50
CORTEXA_SELF_HEAL_MAX_APPLY_ROWS=2000
CORTEXA_SELF_HEAL_APPLY_WINDOW_START_HOUR=1
CORTEXA_SELF_HEAL_APPLY_WINDOW_END_HOUR=5
CORTEXA_SELF_HEAL_PERSIST_HISTORY=true
CORTEXA_SELF_HEAL_PERSISTED_HISTORY_LIMIT=2000
CORTEXA_SELF_HEAL_BACKOFF_ENABLED=true
CORTEXA_SELF_HEAL_BACKOFF_MULTIPLIER=2
CORTEXA_SELF_HEAL_BACKOFF_MAX_INTERVAL_MS=21600000
CORTEXA_SELF_HEAL_SLO_WINDOWS_MINUTES=60,1440,10080

# Optional session-resurrection scheduler (ingest + graph indexing + resurrection checks)
CORTEXA_SESSION_RESURRECTION_ENABLED=true
CORTEXA_SESSION_RESURRECTION_PROJECT_PATH=C:/Users/ayana/Projects/Cortexta
CORTEXA_SESSION_RESURRECTION_PROJECT_ID=cortexta
CORTEXA_SESSION_RESURRECTION_BRANCH=main
CORTEXA_SESSION_RESURRECTION_RUN_ON_START=true
CORTEXA_SESSION_RESURRECTION_INCLUDE_CHATS=true
CORTEXA_SESSION_RESURRECTION_SKIP_UNCHANGED=true
CORTEXA_SESSION_RESURRECTION_GRAPH_LOOKBACK_HOURS=336
CORTEXA_SESSION_RESURRECTION_APPLY_ENABLED=false
CORTEXA_SESSION_RESURRECTION_MAX_ALLOWED_ANOMALIES=0
CORTEXA_SESSION_RESURRECTION_PERSIST_HISTORY=true
CORTEXA_SESSION_RESURRECTION_PERSISTED_HISTORY_LIMIT=2000
CORTEXA_SESSION_RESURRECTION_BACKOFF_ENABLED=true
CORTEXA_SESSION_RESURRECTION_BACKOFF_MULTIPLIER=2
CORTEXA_SESSION_RESURRECTION_BACKOFF_MAX_INTERVAL_MS=21600000
CORTEXA_SESSION_RESURRECTION_SLO_WINDOWS_MINUTES=60,1440,10080
```

### 3) Initialize storage

```bash
pnpm run cortexa -- init
```

### 4) Ingest your project

```bash
pnpm run cortexa -- ingest . --project-id=cortexta
```

Useful variants:

```bash
pnpm run cortexa -- ingest . --project-id=cortexta --max-files=3000 --max-chat-files=500
pnpm run cortexa -- ingest . --project-id=cortexta --no-include-chats
pnpm run cortexa -- ingest . --project-id=cortexta --no-skip-unchanged
```

> Default behavior uses incremental ingestion (`skip-unchanged=true`) so repeated runs avoid re-processing unchanged files.

### 5) Smoke-test retrieval

```bash
pnpm run cortexa -- query "compaction dashboard"
pnpm run cortexa -- context "explain how dashboard snapshots are persisted"
pnpm run cortexa -- memory list --limit=5
```

### 6) Start daemon for API/MCP clients

```bash
pnpm run cortexa:daemon
```
To run MCP stdio transport for MCP-compatible clients:

```bash
pnpm run cortexa:mcp
```

To verify Prometheus metrics endpoint:

```bash
curl -s http://localhost:4312/metrics -H "x-cortexa-token: <token>" | head -n 20
```

Health check from another terminal:

```bash
pnpm run cortexa -- daemon status
```

---

## Day 2: Ongoing maintenance workflows

### Daily checks (quick)

```bash
pnpm run cortexa -- daemon status
pnpm run cortexa -- dashboard --trend-rows=8 --top-projects=12
pnpm run cortexa -- memory stats --project-id=cortexta
```

If daemon token auth is enabled, verify scheduler status via API:

```bash
curl -s -X POST http://localhost:4312/cxlink/compaction/self-heal/status \
  -H "content-type: application/json" \
  -H "x-cortexa-token: <token>" \
  -d '{}'

curl -s -X POST http://localhost:4312/cxlink/session-resurrection/status \
  -H "content-type: application/json" \
  -H "x-cortexa-token: <token>" \
  -d '{}'
```

### Weekly compaction hygiene

1) Dry-run backfill:

```bash
pnpm run cortexa -- memory backfill --project-id=cortexta --limit=5000
```

2) If dry-run looks good, apply:

```bash
pnpm run cortexa -- memory backfill --project-id=cortexta --limit=5000 --apply
```

Equivalent maintenance script:

```bash
pnpm run compact:memory -- --projectId=cortexta --limit=5000 --apply
```

### Scheduled self-healing mode (audit + guarded backfill)

The daemon scheduler is designed with explicit safety gates:
- always runs audit first
- always runs backfill dry-run before any apply
- blocks apply if anomaly guardrail fails
- blocks apply outside configured apply-window hours
- bounds apply size by `CORTEXA_SELF_HEAL_MAX_APPLY_ROWS`
- persists run history in SQLite (`self_healing_run_history`) across restarts
- increases schedule delay with exponential backoff on repeated `error` runs
- tracks rolling-window SLO counters (`applied`, `dry-run-only`, `skipped`, `error`)

To manually trigger a dry-run scheduler cycle:

```bash
curl -s -X POST http://localhost:4312/cxlink/compaction/self-heal/trigger \
  -H "content-type: application/json" \
  -H "x-cortexa-token: <token>" \
  -d '{"reason":"ops-manual-check","dryRunOnly":true}'

curl -s -X POST http://localhost:4312/cxlink/session-resurrection/trigger \
  -H "content-type: application/json" \
  -H "x-cortexa-token: <token>" \
  -d '{"reason":"ops-manual-check","dryRunOnly":true}'
```

### Dashboard artifact export (for ops review)

```bash
pnpm run cortexa -- dashboard --json --out-json=./tmp/compaction-dashboard.json
pnpm run cortexa -- dashboard --out-human=./tmp/compaction-dashboard.txt
```

### Triaging integrity anomalies (`invalidChecksum` / `decodeError`)

1) Scope the problem:

```bash
pnpm run cortexa -- memory stats --project-id=cortexta
pnpm run cortexa -- memory audit --project-id=cortexta --limit=5000 --max-issues=10
pnpm run cortexa -- dashboard --project-id=cortexta --trend-rows=20
```

2) Inspect suspect records:

```bash
pnpm run cortexa -- memory list cortexta --limit=50
pnpm run cortexa -- memory get <memory-id>
pnpm run cortexa -- memory resurrect <memory-id>
```

3) Recover by re-ingesting known-good source:

```bash
pnpm run cortexa -- ingest . --project-id=cortexta --max-files=3000
```

4) Remove irrecoverable records only when confirmed:

```bash
pnpm run cortexa -- memory delete <memory-id>
```

---

## Safe daemon operations

### Start

```bash
pnpm run cortexa:daemon
```

### Stop

- If started in a terminal foreground session: press `Ctrl+C` in that terminal.
- If started via `pnpm run cortexa -- daemon start` in the same process context, use:

```bash
pnpm run cortexa -- daemon stop
```

---

## Troubleshooting cheat sheet

**Symptom:** `ingest` is slow or appears stuck on huge repos
- Fix: reduce ingestion bounds:
  - `--max-files=<n>`
  - `--max-chat-files=<n>`
  - set `CORTEXA_INGEST_MAX_FILE_BYTES` to skip very large files.

**Symptom:** Vector backend unavailable (Qdrant/Chroma down)
- Behavior: CORTEXA continues with SQLite-first operations and degraded vector ranking.
- Fix: restore vector service or temporarily use `CORTEXA_VECTOR_PROVIDER=memory`.

**Symptom:** API returns `unauthorized`
- Fix: ensure client token exactly matches `CORTEXA_DAEMON_TOKEN` and is sent via `x-cortexa-token` or `Authorization: Bearer`.

**Symptom:** Dashboard trends are empty/flat
- Fix: avoid `--no-persist-snapshot` for normal runs and re-run dashboard over time to accumulate trend snapshots.

**Symptom:** Self-healing scheduler repeatedly fails
- Check `/cxlink/compaction/self-heal/status` for `consecutiveFailures`, `lastScheduledDelayMs`, and `slo.windows`.
- Tune backoff controls with:
  - `CORTEXA_SELF_HEAL_BACKOFF_MULTIPLIER`
  - `CORTEXA_SELF_HEAL_BACKOFF_MAX_INTERVAL_MS`
  - `CORTEXA_SELF_HEAL_SLO_WINDOWS_MINUTES`

**Symptom:** Session-resurrection scheduler repeatedly fails
- Check `/cxlink/session-resurrection/status` for `lastRun.error`, `consecutiveFailures`, `lastScheduledDelayMs`, and `slo.windows`.
- Confirm `CORTEXA_SESSION_RESURRECTION_PROJECT_PATH` exists and points to the intended project root.
- Tune backoff controls with:
  - `CORTEXA_SESSION_RESURRECTION_BACKOFF_MULTIPLIER`
  - `CORTEXA_SESSION_RESURRECTION_BACKOFF_MAX_INTERVAL_MS`
  - `CORTEXA_SESSION_RESURRECTION_SLO_WINDOWS_MINUTES`
