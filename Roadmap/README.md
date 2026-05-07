# CORTEXA Roadmap

Current baseline version: **v0.1.2**

This folder is the planning source of truth for upcoming release trains. Each version subfolder contains detailed integration plans, delivery scope, execution sequencing, and acceptance gates.

## Version tracks

| Version  | Theme                     | Primary Outcome                                                           | Plan                                                                                 |
| -------- | ------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `v0.2.0` | Foundation hardening      | Improve reliability, diagnostics, retention controls, and evaluation      | [`v0.2.0-foundation-hardening/ROADMAP.md`](./v0.2.0-foundation-hardening/ROADMAP.md) |
| `v0.3.0` | Intelligence and scale    | Expand multi-project retrieval, quality loops, and autonomous maintenance | [`v0.3.0-intelligence-scale/ROADMAP.md`](./v0.3.0-intelligence-scale/ROADMAP.md)     |
| `v1.0.0` | Adaptive runtime platform | Deliver IDE-native intelligence, graph UX, and task-mode orchestration    | [`v1.0.0-adaptive-runtime/ROADMAP.md`](./v1.0.0-adaptive-runtime/ROADMAP.md)         |

## How to use this roadmap

1. Pick the version plan and execute by milestones.
2. For each feature integration, implement in this order:
   - contract/API updates
   - core runtime behavior
   - observability
   - tests and migration
   - documentation
3. Ship only when release acceptance criteria are fully satisfied.

## Cross-version dependency chain

- `v0.2.0` establishes diagnostics and quality baselines used by all later versions.
- `v0.3.0` builds on `v0.2.0` storage and scoring controls for federation and autonomous optimization.
- `v1.0.0` depends on both prior versions for stable APIs, replayable agent traces, and confidence-aware retrieval behavior.

## Definition of roadmap completion

A version is considered complete when all items below are true:

- Feature scope delivered with tests.
- Backward compatibility policy validated.
- Operator docs and API examples updated.
- Release notes drafted with migration guidance.
- No unresolved critical issues in the release gate suite.
