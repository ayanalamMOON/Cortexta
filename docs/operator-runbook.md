# CORTEXA Operator Runbook (Day 1 / Day 2)

This runbook is for local operators running CORTEXA via the primary CLI.

[← Back to README](../README.md)

---

## 🚀 Day 1: Bootstrap a healthy environment

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
```

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

Health check from another terminal:

```bash
pnpm run cortexa -- daemon status
```

---

## 🛠️ Day 2: Ongoing maintenance workflows

### Daily checks (quick)

```bash
pnpm run cortexa -- daemon status
pnpm run cortexa -- dashboard --trend-rows=8 --top-projects=12
pnpm run cortexa -- memory stats --project-id=cortexta
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

### Dashboard artifact export (for ops review)

```bash
pnpm run cortexa -- dashboard --json --out-json=./tmp/compaction-dashboard.json
pnpm run cortexa -- dashboard --out-human=./tmp/compaction-dashboard.txt
```

### Triaging integrity anomalies (`invalidChecksum` / `decodeError`)

1) Scope the problem:

```bash
pnpm run cortexa -- memory stats --project-id=cortexta
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

## 🔁 Safe daemon operations

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

## 🧩 Troubleshooting cheat sheet

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
