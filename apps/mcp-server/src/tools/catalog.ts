export interface CortexaMcpToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    mutation: boolean;
}

function emptySchema(): Record<string, unknown> {
    return {
        type: "object",
        properties: {},
        additionalProperties: false
    };
}

const TOOL_DEFINITIONS: CortexaMcpToolDefinition[] = [
    {
        name: "cortexa_health",
        description: "Read daemon health and runtime status (includes self-healing and observability signals).",
        inputSchema: emptySchema(),
        mutation: false
    },
    {
        name: "cortexa_query",
        description: "Run retrieval over CORTEXA memories and return ranked context results.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", minLength: 1, maxLength: 16384 },
                projectId: { type: "string", maxLength: 256 },
                branch: { type: "string", maxLength: 128 },
                topK: { type: "integer", minimum: 1, maximum: 50 },
                minScore: { type: "number", minimum: 0, maximum: 1 },
                asOf: { type: "integer", minimum: 0, maximum: 32503680000000 }
            },
            required: ["query"],
            additionalProperties: false
        },
        mutation: false
    },
    {
        name: "cortexa_context",
        description: "Compile token-bounded context bundle for coding assistants via CX-LINK.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", minLength: 1, maxLength: 16384 },
                projectId: { type: "string", maxLength: 256 },
                branch: { type: "string", maxLength: 128 },
                topK: { type: "integer", minimum: 1, maximum: 50 },
                minScore: { type: "number", minimum: 0, maximum: 1 },
                asOf: { type: "integer", minimum: 0, maximum: 32503680000000 },
                agent: { type: "string", maxLength: 256 }
            },
            required: ["query"],
            additionalProperties: false
        },
        mutation: false
    },
    {
        name: "cortexa_plan",
        description: "Generate implementation plan steps from retrieval-backed context.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", minLength: 1, maxLength: 16384 },
                projectId: { type: "string", maxLength: 256 },
                branch: { type: "string", maxLength: 128 },
                topK: { type: "integer", minimum: 1, maximum: 50 },
                minScore: { type: "number", minimum: 0, maximum: 1 },
                asOf: { type: "integer", minimum: 0, maximum: 32503680000000 },
                agent: { type: "string", maxLength: 256 }
            },
            required: ["query"],
            additionalProperties: false
        },
        mutation: false
    },
    {
        name: "cortexa_context_suggest",
        description: "Generate intent-aware proactive context suggestions and optional warmed context payload.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", minLength: 1, maxLength: 16384 },
                projectId: { type: "string", maxLength: 256 },
                branch: { type: "string", maxLength: 128 },
                asOf: { type: "integer", minimum: 0, maximum: 32503680000000 },
                warmup: { type: "boolean" },
                topK: { type: "integer", minimum: 1, maximum: 100 },
                maxTokens: { type: "integer", minimum: 128, maximum: 32768 }
            },
            required: ["query"],
            additionalProperties: false
        },
        mutation: false
    },
    {
        name: "cortexa_agent_list",
        description: "List all integrated Cortexa agents (heuristic, evolution, orchestrator).",
        inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false
        },
        mutation: false
    },
    {
        name: "cortexa_agent_run",
        description: "Run a specific Cortexa agent or the multi-agent loop.",
        inputSchema: {
            type: "object",
            properties: {
                agent: {
                    type: "string",
                    enum: [
                        "writer",
                        "critic",
                        "compressor",
                        "planner",
                        "refactor",
                        "evolution_writer",
                        "evolution_critic",
                        "evolution_consolidator",
                        "evolution_archivist",
                        "multi_agent_loop"
                    ]
                },
                text: { type: "string", minLength: 1, maxLength: 24000 },
                projectId: { type: "string", maxLength: 256 },
                branch: { type: "string", maxLength: 128 },
                context: { type: "string", maxLength: 24000 },
                dryRun: { type: "boolean" },
                topK: { type: "integer", minimum: 1, maximum: 40 },
                maxChars: { type: "integer", minimum: 64, maximum: 32000 },
                existingSnippets: {
                    type: "array",
                    items: { type: "string", maxLength: 512 },
                    maxItems: 40
                }
            },
            required: ["agent", "text"],
            additionalProperties: false
        },
        mutation: true
    },
    {
        name: "cortexa_temporal_query",
        description: "Run memory retrieval at a historical timestamp (time-travel query).",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", minLength: 1, maxLength: 16384 },
                projectId: { type: "string", minLength: 1, maxLength: 256 },
                branch: { type: "string", maxLength: 128 },
                asOf: { type: "integer", minimum: 0, maximum: 32503680000000 },
                topK: { type: "integer", minimum: 1, maximum: 50 },
                minScore: { type: "number", minimum: 0, maximum: 1 }
            },
            required: ["query", "projectId", "asOf"],
            additionalProperties: false
        },
        mutation: false
    },
    {
        name: "cortexa_temporal_diff",
        description: "Return memory delta between two timestamps for a project/branch.",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string", minLength: 1, maxLength: 256 },
                branch: { type: "string", maxLength: 128 },
                from: { type: "integer", minimum: 0, maximum: 32503680000000 },
                to: { type: "integer", minimum: 0, maximum: 32503680000000 },
                limit: { type: "integer", minimum: 1, maximum: 2000 }
            },
            required: ["projectId", "from", "to"],
            additionalProperties: false
        },
        mutation: false
    },
    {
        name: "cortexa_branch_list",
        description: "List available memory branches for a project.",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string", minLength: 1, maxLength: 256 }
            },
            required: ["projectId"],
            additionalProperties: false
        },
        mutation: false
    },
    {
        name: "cortexa_branch_create",
        description: "Create a memory branch from a parent branch.",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string", minLength: 1, maxLength: 256 },
                branch: { type: "string", minLength: 1, maxLength: 128 },
                fromBranch: { type: "string", maxLength: 128 },
                forkedFromCommit: { type: "string", maxLength: 256 }
            },
            required: ["projectId", "branch"],
            additionalProperties: false
        },
        mutation: true
    },
    {
        name: "cortexa_branch_merge",
        description: "Merge source branch changes into target branch.",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string", minLength: 1, maxLength: 256 },
                sourceBranch: { type: "string", minLength: 1, maxLength: 128 },
                targetBranch: { type: "string", minLength: 1, maxLength: 128 },
                strategy: { type: "string", enum: ["source-wins", "target-wins"] }
            },
            required: ["projectId", "sourceBranch", "targetBranch"],
            additionalProperties: false
        },
        mutation: true
    },
    {
        name: "cortexa_branch_switch",
        description: "Switch active branch context (emits branch switch stream event).",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string", minLength: 1, maxLength: 256 },
                fromBranch: { type: "string", maxLength: 128 },
                toBranch: { type: "string", minLength: 1, maxLength: 128 },
                reason: { type: "string", maxLength: 512 }
            },
            required: ["projectId", "toBranch"],
            additionalProperties: false
        },
        mutation: true
    },
    {
        name: "cortexa_compaction_stats",
        description: "Return compaction and integrity metrics for global or project scope.",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string", maxLength: 256 }
            },
            additionalProperties: false
        },
        mutation: false
    },
    {
        name: "cortexa_compaction_dashboard",
        description: "Fetch compaction dashboard snapshot with trends and per-project risk posture.",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string", maxLength: 256 },
                lookbackDays: { type: "integer", minimum: 1, maximum: 3650 },
                maxTrendPoints: { type: "integer", minimum: 1, maximum: 1000 },
                maxProjects: { type: "integer", minimum: 1, maximum: 500 }
            },
            additionalProperties: false
        },
        mutation: false
    },
    {
        name: "cortexa_self_heal_status",
        description: "Inspect self-healing scheduler status, SLO windows, and recent outcomes.",
        inputSchema: emptySchema(),
        mutation: false
    },
    {
        name: "cortexa_self_heal_trigger",
        description: "Trigger a self-healing run (typically dry-run) and return execution report.",
        inputSchema: {
            type: "object",
            properties: {
                reason: { type: "string", maxLength: 512 },
                dryRunOnly: { type: "boolean" }
            },
            additionalProperties: false
        },
        mutation: true
    },
    {
        name: "cortexa_ingest",
        description: "Ingest or refresh project memory from source files/chats.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", minLength: 1, maxLength: 4096 },
                projectId: { type: "string", maxLength: 256 },
                branch: { type: "string", maxLength: 128 },
                includeChats: { type: "boolean" },
                skipUnchanged: { type: "boolean" },
                maxFiles: { type: "integer", minimum: 0, maximum: 200000 },
                maxChatFiles: { type: "integer", minimum: 1, maximum: 50000 },
                chatRoot: { type: "string", maxLength: 4096 }
            },
            required: ["path"],
            additionalProperties: false
        },
        mutation: true
    },
    {
        name: "cortexa_evolve",
        description: "Run progression-mode memory evolution using input text and optional context hints.",
        inputSchema: {
            type: "object",
            properties: {
                text: { type: "string", minLength: 1, maxLength: 24000 },
                context: { type: "string", maxLength: 24000 },
                projectId: { type: "string", maxLength: 256 },
                dryRun: { type: "boolean" }
            },
            required: ["text"],
            additionalProperties: false
        },
        mutation: true
    },
    {
        name: "cortexa_encode_mcp_ctx",
        description: "Encode normalized MCP context envelope JSON from intent/scope/entities metadata.",
        inputSchema: {
            type: "object",
            properties: {
                intent: { type: "string", minLength: 1, maxLength: 4096 },
                scope: { type: "string", minLength: 1, maxLength: 4096 },
                concepts: { type: "array", items: { type: "string", maxLength: 256 }, maxItems: 128 },
                entities: { type: "array", items: { type: "string", maxLength: 256 }, maxItems: 128 },
                constraints: { type: "array", items: { type: "string", maxLength: 256 }, maxItems: 128 },
                metadata: { type: "object" }
            },
            required: ["intent", "scope", "concepts", "entities", "constraints"],
            additionalProperties: false
        },
        mutation: false
    },
    {
        name: "cortexa_decode_mcp_ctx",
        description: "Decode and validate an MCP context envelope payload string.",
        inputSchema: {
            type: "object",
            properties: {
                payload: { type: "string", minLength: 2 }
            },
            required: ["payload"],
            additionalProperties: false
        },
        mutation: false
    }
];

export function getCortexaToolCatalog(options: { enableMutationTools: boolean }): CortexaMcpToolDefinition[] {
    return TOOL_DEFINITIONS.filter((tool) => options.enableMutationTools || !tool.mutation).map((tool) => ({ ...tool }));
}

export function isMutationTool(name: string): boolean {
    return TOOL_DEFINITIONS.some((tool) => tool.name === name && tool.mutation);
}
