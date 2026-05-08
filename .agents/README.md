# CORTEXA Agent Skills

Skill definitions for GitHub Copilot Chat to assist with CORTEXA development.

## Structure
```
.agents/
├── skills/cortexa-dev.skill.md
├── skills/cortexa-memory.skill.md
├── skills/cortexa-orchestrator.skill.md
├── skills/cortexa-compaction.skill.md
├── skills/cortexa-ingestion.skill.md
├── skills/cortexa-daemon.skill.md
├── skills/cortexa-security.skill.md
├── skills/cortexa-observability.skill.md
├── skills/cortexa-graph-index.skill.md
├── skills/cortexa-security-ops.skill.md
├── skills/cortexa-api-contracts.skill.md
├── skills/cortexa-scheduler.skill.md
├── skills/cortexa-slo.skill.md
├── skills/cortexa-mcp-safety.skill.md
├── skills/cortexa-branching.skill.md
├── skills/cortexa-coordination.skill.md
├── skills/cortexa-coordination-map.md
├── agents/cortexa-coordination.agent.md
├── assistants/cortexa-assist.md
├── assistants/cortexa-coordination.assist.md
├── assistants/cortexa-direction.assist.md
├── assistants/cortexa-mcp.assist.md
├── assistants/cortexa-ops.assist.md
├── assistants/cortexa-deploy.assist.md
├── assistants/cortexa-testing.assist.md
├── github-copilot-instructions.md
└── README.md
```

## Installation

### GitHub Copilot (Recommended)
```bash
mkdir -p .github
cp .agents/github-copilot-instructions.md .github/copilot-instructions.md
```

### VS Code Settings
```json
{
  "github.copilot.chat.codeGeneration.instructions": [
    { "file": ".agents/skills/cortexa-dev.skill.md" },
    { "file": ".agents/skills/cortexa-memory.skill.md" },
    { "file": ".agents/skills/cortexa-orchestrator.skill.md" },
    { "file": ".agents/skills/cortexa-compaction.skill.md" },
    { "file": ".agents/skills/cortexa-ingestion.skill.md" },
    { "file": ".agents/skills/cortexa-daemon.skill.md" },
    { "file": ".agents/skills/cortexa-security.skill.md" },
    { "file": ".agents/skills/cortexa-observability.skill.md" },
    { "file": ".agents/skills/cortexa-graph-index.skill.md" },
    { "file": ".agents/skills/cortexa-security-ops.skill.md" },
    { "file": ".agents/skills/cortexa-api-contracts.skill.md" },
    { "file": ".agents/skills/cortexa-scheduler.skill.md" },
    { "file": ".agents/skills/cortexa-slo.skill.md" },
    { "file": ".agents/skills/cortexa-mcp-safety.skill.md" },
    { "file": ".agents/skills/cortexa-branching.skill.md" },
    { "file": ".agents/skills/cortexa-coordination.skill.md" },
    { "file": ".agents/skills/cortexa-coordination-map.md" },
    { "file": ".agents/assistants/cortexa-assist.md" },
    { "file": ".agents/assistants/cortexa-mcp.assist.md" },
    { "file": ".agents/assistants/cortexa-ops.assist.md" },
    { "file": ".agents/assistants/cortexa-deploy.assist.md" },
    { "file": ".agents/assistants/cortexa-testing.assist.md" },
    { "file": ".agents/assistants/cortexa-coordination.assist.md" },
    { "file": ".agents/assistants/cortexa-direction.assist.md" }
  ]
}
```

### Cursor IDE
```bash
mkdir -p .cursor/rules
cat .agents/skills/*.md .agents/assistants/*.md > .cursor/rules/cortexa.mdc
```

## Skill Activation

**cortexa-dev**: Architecture, CLI, APIs, agents, CX-LINK, MCP
**cortexa-memory**: Storage engines, compaction/resurrection, temporal/graph
**cortexa-orchestrator**: CX-LINK envelopes, agent orchestration, mini-LLM
**cortexa-compaction**: Compaction/audit/backfill/self-healing safety gates
**cortexa-ingestion**: Ingest pipeline, AST chunking, chat discovery
**cortexa-daemon**: HTTP/WS runtime, auth, metrics, rate limits
**cortexa-security**: Auth, rate limits, secrets, MCP mutation safety
**cortexa-observability**: Logs, metrics, health diagnostics, alerting
**cortexa-graph-index**: Graph nodes/edges, session resurrection, lineage
**cortexa-security-ops**: Incident response, abuse handling, operational security
**cortexa-api-contracts**: API schema stability, CX-LINK envelope contracts
**cortexa-scheduler**: Self-healing and session-resurrection scheduling
**cortexa-slo**: SLO/SLI targets, error budgets, burn-rate guidance
**cortexa-mcp-safety**: MCP mutation gating, client isolation, tool safety
**cortexa-branching**: Branch creation/merge/switch, lineage isolation
**cortexa-coordination**: Standardized routing, handoffs, and verification

**cortexa-assist**: Debugging, deployment, performance, integration
**cortexa-mcp**: MCP wiring, tool surface, mutation safety
**cortexa-ops**: Observability, schedulers, runtime reliability
**cortexa-deploy**: Docker/Compose deployment posture
**cortexa-testing**: Test matrix execution and CI parity
**cortexa-coordination-assist**: Coordination checklists and routing briefs
**cortexa-direction**: Directional planning and acceptance criteria

## Coordination Matrix
- **Cross-cutting changes** → `cortexa-dev`
- **API/contract changes** → `cortexa-api-contracts`
- **Reliability/SLO** → `cortexa-observability`, `cortexa-slo`, `cortexa-scheduler`
- **Security posture** → `cortexa-security`, `cortexa-security-ops`, `cortexa-mcp-safety`
- **Branch/graph workflows** → `cortexa-branching`, `cortexa-graph-index`
- **Memory lifecycle** → `cortexa-memory`, `cortexa-compaction`, `cortexa-ingestion`

## Updating
When CORTEXA adds features, update both skill files and bump the version header.
