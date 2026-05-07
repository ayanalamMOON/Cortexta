# v0.3.0 — Intelligence and Scale Roadmap

## Release objective

Extend CORTEXA from single-project advanced memory runtime into a multi-project, quality-learning, privacy-aware intelligence layer with adaptive maintenance behavior.

## Planned feature integrations

---

### 1) Cross-project memory federation

#### Problem
Teams often need retrieval across related services, but current workflows are primarily project-scoped.

#### Integration scope
- Add federated retrieval mode across multiple `projectId`s.
- Add weighted scoring per project.

#### API changes
- Extend query/context payloads with:
  - `projectIds[]`
  - `projectWeights` map
  - `federationMode` (`balanced | weighted | strict-primary`)

#### Ranking strategy
Composite score:
- semantic similarity
- recency
- confidence
- project weight
- branch alignment bonus/penalty

#### Test plan
- Multi-project integration tests with controlled relevance sets.
- Performance checks for top-K latency under federation mode.

#### Definition of done
- Federated query returns relevant cross-service context without diluting primary project signal.

---

### 2) Memory branch conflict resolver

#### Problem
Branch memory merges can produce semantic conflict ambiguity where simple source/target wins is insufficient.

#### Integration scope
- Add semantic conflict classification:
  - `duplicate_title`
  - `contradictory_summary`
  - `temporal_divergence`
  - `policy_conflict`
- Provide merge recommendations with confidence.

#### API additions
- `POST /cxlink/branch/merge/preview`
- `POST /cxlink/branch/conflicts/resolve`

#### CLI additions
- `cortexa memory branch merge --interactive`
- `cortexa memory branch conflicts --project-id=<id>`

#### Test plan
- Deterministic conflict fixtures.
- Merge correctness tests under each strategy mode.

#### Definition of done
- Merge operations expose explicit conflict sets and guided resolution options before mutation.

---

### 3) Human feedback loop for ranking quality

#### Problem
Retrieval quality cannot continuously improve without user/operator feedback signals.

#### Integration scope
- Capture feedback (`useful`, `not-useful`, optional reason).
- Link feedback to memory IDs, query fingerprint, and context envelope.
- Feed aggregate scores back into ranking.

#### API additions
- `POST /cxlink/feedback/submit`
- `POST /cxlink/feedback/stats`

#### Data model
- `memory_feedback_events`
- `query_feedback_aggregates`

#### Ranking integration
- Add bounded `feedbackBoost` term to avoid overfitting.

#### Test plan
- Ensure feedback shifts ranking in expected direction over repeated runs.
- Guard against feedback spam (rate limit + dedupe window).

#### Definition of done
- Measurable ranking lift over baseline on golden query suite after feedback accumulation.

---

### 4) Security and privacy ingestion pass

#### Problem
Sensitive data can enter memory without strong first-class redaction policy enforcement.

#### Integration scope
- Add pre-storage security pass in ingestion pipeline.
- Detect and mask secrets/PII.
- Emit redaction telemetry.

#### Detection classes
- API keys/tokens
- credentials and connection strings
- email/phone/PII-like patterns
- configurable project-specific patterns

#### Observability
- metrics:
  - `redaction_events_total`
  - `redacted_records_total`
  - `redaction_failures_total`

#### Test plan
- curated fixture corpus with positive and false-positive cases.
- ensure masked content still remains semantically useful.

#### Definition of done
- No raw sensitive token from supported classes persists in stored memory rows.

---

### 5) Scheduler recommendation engine

#### Problem
Static scheduler thresholds can be suboptimal across varied workloads and evolving memory posture.

#### Integration scope
- Add recommendation engine that proposes dynamic scheduler settings.
- Inputs:
  - anomaly trend
  - compaction opportunity trend
  - failure rate trend
  - runtime windows and load

#### Outputs
- recommended interval
- recommended apply window
- recommended anomaly threshold
- recommendation confidence and rationale

#### API additions
- `POST /cxlink/scheduler/recommendations`
- optional `applyRecommendations` dry-run mode

#### Test plan
- synthetic trend simulation tests.
- guardrails to avoid extreme schedule oscillation.

#### Definition of done
- Recommendations improve maintenance outcomes without increasing failure rate.

---

## Milestone sequencing

### Milestone A — Scale retrieval and merge safety
- Cross-project federation.
- Branch conflict preview and resolver.

### Milestone B — Learn from usage
- Feedback ingestion and ranking integration.

### Milestone C — Autonomous and secure operations
- Security redaction pipeline.
- Scheduler recommendation engine.

## Release acceptance criteria

- Federated and conflict-aware flows are stable across integration tests.
- Feedback loop and redaction pass have observability coverage.
- Scheduler recommendations remain within safety guardrails under load and error simulations.
