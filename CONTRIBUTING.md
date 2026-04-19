# Contributing to CORTEXA

Thanks for contributing to CORTEXA. This guide keeps changes reviewable, reliable, and production-ready.

## Prerequisites

- Node.js `^20.11.1` or `^22.0.0`
- `pnpm@9.15.0`

## Local setup

1. Fork + clone the repository.
2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Run baseline checks:

   ```bash
   pnpm run doctor
   pnpm run typecheck
   ```

   ## Contribution flow

   ```mermaid
   flowchart LR
      A[Fork and branch from main] --> B[Implement focused change]
      B --> C[Run local quality gates]
      C --> D[Open PR with clear scope]
      D --> E[Optional heavy gate label]
      E --> F[Review and merge]
   ```

## Branching model

- Create feature branches from `main`.
- Prefer small, focused pull requests.
- Keep one logical change per PR when possible.

## Quality gates

Before opening a PR, run:

```bash
pnpm run typecheck
pnpm run test:unit
pnpm run test:observability
pnpm run test:mcp
pnpm run test:cli-routing
pnpm run test:evolution
pnpm run test:ingestion
pnpm run test:ingestion-scope
pnpm run test:compaction
pnpm run test:self-healing
pnpm run test:session-resurrection
pnpm run test:daemons
```

For daemon/API route changes, also run a quick live smoke check:

```bash
pnpm run cortexa -- doctor
pnpm run cortexa -- ingest . --max-files=200 --no-include-chats
pnpm run cortexa -- query "smoke"
pnpm run cortexa -- context "smoke"
pnpm run cortexa -- evolve "smoke" --dry-run --json
```

### PR label contract: `ci:agents-realistic`

CI includes a heavier integration gate (`Agents Realistic Gate`) that runs:

```bash
pnpm run test:agents-realistic
```

This gate runs automatically on pushes to `main`. For pull requests, it runs when the PR has label:

- `ci:agents-realistic`

Because it is intentionally heavier than baseline CI, request it when changes affect cross-surface agent behavior, including:

- `core/agents/*` orchestration logic
- `agents/*` planner/refactor/writer/critic/compressor behavior
- daemon agent routes or stream events (`/cxlink/agent/*`, `agentStatus`)
- daemon scheduler/stream events (`/cxlink/session-resurrection/*`, `sessionResurrectionStatus`)
- evolution pipeline behavior used by `multi_agent_loop`
- integration contracts spanning CLI + daemon + MCP agent surfaces

Reviewer workflow:

1. Add label `ci:agents-realistic` to trigger the gate on the PR.
2. Remove label if the PR scope changes and the heavy gate is no longer needed.

> Tip: run `pnpm run test:agents-realistic` locally before requesting the label to reduce CI churn.

## Governance matrix

| Change area                 | Minimum local checks                              | Optional extra check           |
| --------------------------- | ------------------------------------------------- | ------------------------------ |
| Core runtime / memory       | `typecheck`, `test:unit`, `test:compaction`       | `test:daemons`                 |
| Daemon route / stream event | `typecheck`, `test:daemons`, `test:observability` | live smoke block in this guide |
| MCP tool bridge             | `typecheck`, `test:mcp`                           | `test:agents-realistic`        |
| Agent orchestration         | baseline quality gates                            | PR label `ci:agents-realistic` |

## Commit guidance

- Use imperative commit messages (e.g., `Add CX-LINK protocol spec`).
- Include context in commit body when behavior changes.
- Avoid unrelated formatting-only churn.

## Pull request checklist

- [ ] Problem statement and scope are clear.
- [ ] Behavior changes are covered by tests.
- [ ] Docs updated (`README.md`, `docs/*`) when needed.
- [ ] Backward compatibility considered for CLI/API contracts.
- [ ] No secrets or local paths committed.

## Security and responsible disclosure

If you discover a security issue, do not open a public issue with exploit details.
Open a private security advisory or contact maintainers directly with:

- impact summary
- reproduction steps
- affected versions
- mitigation suggestions

## License

By contributing, you agree that your contributions are licensed under the repository `LICENSE` (MIT).
