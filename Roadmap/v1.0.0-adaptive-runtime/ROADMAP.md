# v1.0.0 — Adaptive Runtime Platform Roadmap

## Release objective

Ship CORTEXA 1.0 as an IDE-native adaptive intelligence platform: real-time context streaming, visual memory intelligence, and dependable task-mode orchestration suitable for production developer workflows.

## Planned feature integrations

---

### 1) Live IDE context stream

#### Problem
Context assembly is currently request-driven. Developers need near-real-time assistance during active coding, not only after explicit query calls.

#### Integration scope
- Add continuous context suggestion stream tied to editor/workspace activity.
- Emit prioritized suggestions with confidence, source memories, and safe token budgets.

#### Protocol and transport
- Extend WS stream event family with:
  - `contextDeltaSuggested`
  - `contextDeltaApplied`
  - `contextDeltaSuppressed`
- Optional client ack channel for relevance feedback.

#### Runtime controls
- stream debounce windows
- minimum confidence threshold
- max suggestion rate per minute
- project and branch scoping

#### Test plan
- integration tests for stream stability and event ordering.
- load tests for event throughput and latency under active file changes.

#### Definition of done
- Context suggestions remain stable, bounded, and relevant during active coding sessions.

---

### 2) Knowledge graph visual explorer

#### Problem
Memory graph and lineage power exists, but operators and developers lack an ergonomic visualization/debugging surface.

#### Integration scope
- Add graph explorer UI in `site/` (or dedicated route) with:
  - node/edge search
  - branch and temporal overlays
  - neighborhood expansion
  - conflict and anomaly highlighting

#### Data APIs
- add graph query endpoints for:
  - neighborhood traversal
  - temporal slice view
  - branch delta overlays

#### UX requirements
- filter by memory kind/source/tag
- inspect node history and references
- copy context pack directly from graph selection

#### Test plan
- API contract tests + UI interaction tests.
- performance baseline for graph queries and rendering.

#### Definition of done
- Teams can inspect why a memory/context decision happened through a visual lineage path.

---

### 3) Task-mode agent bundles

#### Problem
Agent orchestration exists but requires manual tuning per request; repeatable high-quality workflows need preset task modes.

#### Integration scope
- Add bundle presets:
  - `debug-mode`
  - `refactor-mode`
  - `incident-mode`
  - `feature-mode`
- Each bundle defines:
  - retrieval scope profile
  - constraints profile
  - preferred agent chain
  - strictness and fallback policies

#### API and CLI changes
- `POST /cxlink/agent/bundle/list`
- `POST /cxlink/agent/bundle/run`
- CLI:
  - `cortexa agents bundles`
  - `cortexa agents run-bundle <bundle> <text>`

#### Quality controls
- each bundle validated against golden scenarios.
- replay timeline persistence required for auditability.

#### Test plan
- scenario-based bundle tests across representative tasks.
- ensure deterministic fallback behavior under strict mode configs.

#### Definition of done
- Operators can run a bundle and get consistently high-quality outcomes with minimal manual tuning.

---

## v1.0 platform-readiness gates

### Reliability and SLOs
- Stable daemon and stream behavior under sustained workload.
- Defined SLO targets for latency, availability, and scheduler success rates.

### Backward compatibility
- No breaking changes to core v0.x contracts without migration docs.
- Add migration guides for any renamed/expanded API fields.

### Security and governance
- Privacy redaction and auth posture verified in production-like test environment.
- Auditability available for agent runs and automated maintenance actions.

### Documentation and onboarding
- docs fully updated for all v1.0 surfaces.
- operator runbook includes incident playbooks for stream and agent-bundle failures.

## Milestone sequencing

### Milestone A — Real-time intelligence
- Implement live IDE context stream with bounded controls.

### Milestone B — Explainability UX
- Deliver graph explorer APIs and UI.

### Milestone C — Productized orchestration
- Ship task-mode bundles + scenario validation.
- Close release-readiness gates and publish v1.0 release documentation.

## Release acceptance criteria

- All v1.0 integrations complete with tests and operator docs.
- Stream, graph, and bundle workflows validated in realistic end-to-end scenarios.
- Release readiness checklist signed off with no unresolved critical blockers.
