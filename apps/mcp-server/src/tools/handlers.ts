import {
    toBoolean,
    toBoundedInt,
    toBoundedNumber,
    toRecord,
    toTrimmedString
} from "../../../../core/daemon/http";
import { decodeMcpCtx } from "../../../../formats/mcp-ctx/decoder";
import { encodeMcpCtx } from "../../../../formats/mcp-ctx/encoder";
import type { CortexaDaemonClient } from "../daemon-client";
import type { McpLogger } from "../logger";
import { isMutationTool } from "./catalog";

export interface McpToolCallResult {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
}

interface ExecuteToolParams {
    name: string;
    argumentsValue: unknown;
    enableMutationTools: boolean;
    daemonClient: CortexaDaemonClient;
    logger: McpLogger;
}

function successResult(payload: unknown): McpToolCallResult {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(payload, null, 2)
            }
        ]
    };
}

function errorResult(message: string): McpToolCallResult {
    return {
        isError: true,
        content: [
            {
                type: "text",
                text: message
            }
        ]
    };
}

function toArgsRecord(value: unknown): Record<string, unknown> {
    return toRecord(value);
}

function requiredString(args: Record<string, unknown>, key: string, maxLength: number): string | undefined {
    return toTrimmedString(args[key], maxLength);
}

function optionalStringArray(args: Record<string, unknown>, key: string, maxItems: number, maxItemLength: number): string[] | undefined {
    const value = args[key];
    if (value === undefined) {
        return undefined;
    }

    if (!Array.isArray(value)) {
        return [];
    }

    const output: string[] = [];
    for (const item of value) {
        const normalized = toTrimmedString(item, maxItemLength);
        if (!normalized) {
            continue;
        }

        output.push(normalized);
        if (output.length >= maxItems) {
            break;
        }
    }

    return output;
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }

    return value as Record<string, unknown>;
}

function compactBody(input: Record<string, unknown>): Record<string, unknown> {
    const output: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(input)) {
        if (value === undefined) {
            continue;
        }

        output[key] = value;
    }

    return output;
}

export async function executeCortexaTool(params: ExecuteToolParams): Promise<McpToolCallResult> {
    const args = toArgsRecord(params.argumentsValue);

    if (!params.enableMutationTools && isMutationTool(params.name)) {
        return errorResult(
            `Tool ${params.name} is disabled because mutation tools are not enabled. Set CORTEXA_MCP_ENABLE_MUTATIONS=true to allow write operations.`
        );
    }

    try {
        switch (params.name) {
            case "cortexa_health": {
                const payload = await params.daemonClient.getJson("/health");
                return successResult(payload);
            }

            case "cortexa_query": {
                const query = requiredString(args, "query", 16_384);
                if (!query) {
                    return errorResult("Missing required field: query");
                }

                const payload = await params.daemonClient.postJson("/cxlink/query", compactBody({
                    query,
                    projectId: toTrimmedString(args.projectId, 256),
                    topK: toBoundedInt(args.topK, 1, 50),
                    minScore: toBoundedNumber(args.minScore, 0, 1),
                    agent: toTrimmedString(args.agent, 256)
                }));

                return successResult(payload);
            }

            case "cortexa_context": {
                const query = requiredString(args, "query", 16_384);
                if (!query) {
                    return errorResult("Missing required field: query");
                }

                const payload = await params.daemonClient.postJson("/cxlink/context", compactBody({
                    query,
                    projectId: toTrimmedString(args.projectId, 256),
                    topK: toBoundedInt(args.topK, 1, 50),
                    minScore: toBoundedNumber(args.minScore, 0, 1),
                    agent: toTrimmedString(args.agent, 256)
                }));

                return successResult(payload);
            }

            case "cortexa_plan": {
                const query = requiredString(args, "query", 16_384);
                if (!query) {
                    return errorResult("Missing required field: query");
                }

                const payload = await params.daemonClient.postJson("/cxlink/plan", compactBody({
                    query,
                    projectId: toTrimmedString(args.projectId, 256),
                    topK: toBoundedInt(args.topK, 1, 50),
                    minScore: toBoundedNumber(args.minScore, 0, 1),
                    agent: toTrimmedString(args.agent, 256)
                }));

                return successResult(payload);
            }

            case "cortexa_compaction_stats": {
                const payload = await params.daemonClient.postJson("/cxlink/compaction/stats", compactBody({
                    projectId: toTrimmedString(args.projectId, 256)
                }));

                return successResult(payload);
            }

            case "cortexa_compaction_dashboard": {
                const payload = await params.daemonClient.postJson("/cxlink/compaction/dashboard", compactBody({
                    projectId: toTrimmedString(args.projectId, 256),
                    lookbackDays: toBoundedInt(args.lookbackDays, 1, 3650),
                    maxTrendPoints: toBoundedInt(args.maxTrendPoints, 1, 1000),
                    maxProjects: toBoundedInt(args.maxProjects, 1, 500)
                }));

                return successResult(payload);
            }

            case "cortexa_self_heal_status": {
                const payload = await params.daemonClient.postJson("/cxlink/compaction/self-heal/status", {});
                return successResult(payload);
            }

            case "cortexa_self_heal_trigger": {
                const payload = await params.daemonClient.postJson("/cxlink/compaction/self-heal/trigger", {
                    reason: toTrimmedString(args.reason, 512),
                    dryRunOnly: toBoolean(args.dryRunOnly, false)
                });
                return successResult(payload);
            }

            case "cortexa_ingest": {
                const projectPath = requiredString(args, "path", 4096);
                if (!projectPath) {
                    return errorResult("Missing required field: path");
                }

                const payload = await params.daemonClient.postJson("/ingest", compactBody({
                    path: projectPath,
                    projectId: toTrimmedString(args.projectId, 256),
                    includeChats: toBoolean(args.includeChats, false),
                    skipUnchanged: toBoolean(args.skipUnchanged, true),
                    maxFiles: toBoundedInt(args.maxFiles, 0, 200_000),
                    maxChatFiles: toBoundedInt(args.maxChatFiles, 1, 50_000),
                    chatRoot: toTrimmedString(args.chatRoot, 4096)
                }));

                return successResult(payload);
            }

            case "cortexa_evolve": {
                const text = requiredString(args, "text", 24_000);
                if (!text) {
                    return errorResult("Missing required field: text");
                }

                const payload = await params.daemonClient.postJson("/evolve/progression", compactBody({
                    text,
                    projectId: toTrimmedString(args.projectId, 256),
                    context: toTrimmedString(args.context, 24_000),
                    dryRun: toBoolean(args.dryRun, false)
                }));

                return successResult(payload);
            }

            case "cortexa_encode_mcp_ctx": {
                const intent = requiredString(args, "intent", 4096);
                const scope = requiredString(args, "scope", 4096);
                const concepts = optionalStringArray(args, "concepts", 128, 256);
                const entities = optionalStringArray(args, "entities", 128, 256);
                const constraints = optionalStringArray(args, "constraints", 128, 256);

                if (!intent || !scope || !concepts || !entities || !constraints) {
                    return errorResult(
                        "Missing required fields for cortexa_encode_mcp_ctx. Required: intent, scope, concepts[], entities[], constraints[]"
                    );
                }

                const payload = encodeMcpCtx(
                    {
                        intent,
                        scope,
                        concepts,
                        entities,
                        constraints,
                        metadata: optionalObject(args.metadata)
                    },
                    {
                        pretty: true
                    }
                );

                return successResult({
                    ok: true,
                    route: "mcp/encode",
                    payload
                });
            }

            case "cortexa_decode_mcp_ctx": {
                const payload = requiredString(args, "payload", 250_000);
                if (!payload) {
                    return errorResult("Missing required field: payload");
                }

                const decoded = decodeMcpCtx(payload);
                return successResult({
                    ok: true,
                    route: "mcp/decode",
                    decoded
                });
            }

            default:
                return errorResult(`Unknown tool: ${params.name}`);
        }
    } catch (error) {
        params.logger.error("mcp.tool.execution.failed", {
            tool: params.name,
            error: error instanceof Error ? error.message : String(error)
        });

        return errorResult(error instanceof Error ? error.message : String(error));
    }
}
