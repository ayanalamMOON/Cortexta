# v0.2.0 — Foundation Hardening Roadmap

## Release objective

Turn the current runtime into a stable operator-grade baseline by adding deep diagnostics, retention controls, replayability for agents, deterministic ingestion policy controls, and measurable retrieval evaluation.

## Planned feature integrations

---

### 1) LLM runtime status and diagnostics surface

#### Problem
When strict local/remote LLM mode fails, diagnosis can be slow because effective runtime values (mode, timeout, strict flags, endpoint health) are not centrally observable.

#### Integration scope
- Add `POST /cxlink/llm/status`.
- Add CLI shortcut: `cortexa llm status --runtime`.
- Include effective values, not only configured values.

#### Contract shape
Return:
- `mode` (`mini-local | qwen-http | auto | disabled`)
- `strictRemote`
- `effectiveTimeoutMs`
- `effectiveJsonMaxTokens`
- `serviceUrl`
- `serviceReachable`
- `modelPathDetected`
- `lastSuccessAt`
- `lastError`
- `diagnosticHints[]`

#### Integration points
- `core/llm/cortexa-llm.service.ts`
- daemon CX-LINK route handlers
- CLI `llm status`
- docs: `docs/api-examples.md`, `docs/operator-runbook.md`

#### Test plan
- Unit: env parsing + status payload mapping.
- Integration: strict mode status against online/offline local service.
- Regression: verify no fallback when strict mode is enabled.

#### Definition of done
- Operators can identify root cause of failed strict LLM request in a single status call.

---

### 2) Memory pinning and retention policies

#### Problem
High-value architectural memories can be decayed/compacted similarly to low-value memories, reducing long-term fidelity.

#### Integration scope
- Add memory retention metadata:
  - `pinned` (boolean)
  - `retentionClass` (`critical | standard | ephemeral`)
  - `expiresAt` (optional unix ms)
- Ensure evolution/compaction jobs respect retention policy.

#### Data model and migration
- SQLite schema changes on memory table.
- Migration script for existing rows:
  - default `retentionClass=standard`
  - default `pinned=false`

#### API and CLI changes
- Extend responses for:
  - `/query`, `/context`, `/cxlink/*` memory rows
- Add CLI commands:
  - `cortexa memory pin <id>`
  - `cortexa memory unpin <id>`
  - `cortexa memory retention set <id> --class=<class> --ttl=<duration>`

#### Test plan
- Unit: retention policy evaluator.
- Integration: self-healing/session-resurrection should skip or protect pinned critical rows.
- Migration test: old DB upgrades safely.

#### Definition of done
- No pinned critical memory can be deleted/overwritten by automated maintenance paths.

---

### 3) Agent run replay timeline

#### Problem
Current orchestrator output is useful in real time, but post-run debugging is difficult without persisted stage-level history.

#### Integration scope
- Persist run metadata and stage timeline.
- Correlate run ID across stream events and API responses.
- Add retrieval API for run history.

#### Data model
- `agent_run_history`
- `agent_run_stage_events`

#### API additions
- `POST /cxlink/agent/runs` (filter by project, agent, branch, status)
- `POST /cxlink/agent/run/get` (run details + stages)

#### Stream updates
- Ensure `agentStatus` includes `runId`, `stage`, `attempt`, `durationMs`.

#### Test plan
- Integration test for multi-agent loop with persisted stage replay.
- Backward compatibility check for existing `/cxlink/agent/run` consumers.

#### Definition of done
- Any run can be replayed with ordered stage transitions and failure points.

---

### 4) Ingestion policy file (`cortexa.policy.json`)

#### Problem
Ingestion scope currently relies mostly on flags/env and can drift across teams and machines.

#### Integration scope
- Add policy file resolution in project root.
- Support deterministic include/exclude/sensitivity controls.

#### Policy schema (initial)
- `includeGlobs[]`
- `excludeGlobs[]`
- `maxFileBytes`
- `languages[]`
- `chat` (`enabled`, `roots[]`, `maxFiles`)
- `redaction` (`maskSecrets`, `maskPII`, `customPatterns[]`)

#### CLI additions
- `cortexa ingest --policy=<path>`
- `cortexa ingest --policy-check`

#### Test plan
- Unit: schema validation.
- Integration: policy-driven ingestion across workspace and chat files.
- Security regression: redaction patterns correctly applied before storage.

#### Definition of done
- Running ingestion in two environments with same policy yields consistent scope decisions.

---

### 5) Golden query evaluation harness

#### Problem
There is no native benchmark loop to catch retrieval/context regressions before release.

#### Integration scope
- Add evaluation suite file format (`eval/golden-queries.json`).
- Add command: `cortexa eval run`.
- Report retrieval + context quality metrics.

#### Metrics (minimum)
- `hitAtK`
- `ndcgAtK`
- `contextCoverage`
- `suggestionAccuracy` (intent hint relevance)

#### Output modes
- JSON report for CI
- human summary for local runs

#### CI integration
- Optional gate label for heavy evaluation (similar to realistic agents gate).

#### Definition of done
- Release candidate cannot ship if evaluation score drops below configured threshold.

---

## Milestone sequencing

### Milestone A — Contracts and diagnostics
- LLM status endpoint + CLI runtime status.
- Policy schema draft.

### Milestone B — Data model and replayability
- Retention metadata migration.
- Agent run history persistence.

### Milestone C — Quality control loop
- Golden query harness and CI integration.
- Docs/runbook updates.

## Release acceptance criteria

- All v0.2.0 integrations implemented and documented.
- Quality gates pass:
  - `typecheck`
  - baseline integration suite
  - new eval suite threshold
- No critical unresolved issue in strict LLM operation, memory retention integrity, or agent replayability.
