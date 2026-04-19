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

## Branching model

- Create feature branches from `main`.
- Prefer small, focused pull requests.
- Keep one logical change per PR when possible.

## Quality gates

Before opening a PR, run:

```bash
pnpm run typecheck
pnpm run test:unit
pnpm run test:cli-routing
pnpm run test:evolution
pnpm run test:ingestion
pnpm run test:compaction
pnpm run test:self-healing
pnpm run test:daemons
```

For daemon/API route changes, also run a quick live smoke check:

```bash
pnpm run cortexa -- doctor
pnpm run cortexa -- ingest . --project-id=contrib-smoke --max-files=200 --no-include-chats
pnpm run cortexa -- query "smoke"
pnpm run cortexa -- context "smoke"
pnpm run cortexa -- evolve "smoke" --dry-run --json
```

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
