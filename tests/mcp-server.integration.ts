import assert from "node:assert/strict";
import { createMcpLogger } from "../apps/mcp-server/src/logger";
import { McpProtocolRouter } from "../apps/mcp-server/src/protocol/router";
import type { McpToolDescriptor } from "../apps/mcp-server/src/protocol/types";
import { getCortexaToolCatalog } from "../apps/mcp-server/src/tools/catalog";
import { executeCortexaTool } from "../apps/mcp-server/src/tools/handlers";

interface MockCall {
    method: "GET" | "POST";
    route: string;
    body?: Record<string, unknown>;
}

function buildTools(enableMutationTools: boolean): McpToolDescriptor[] {
    return getCortexaToolCatalog({ enableMutationTools }).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
    }));
}

async function main(): Promise<void> {
    const logger = createMcpLogger("error");
    const calls: MockCall[] = [];

    const daemonClient = {
        async postJson<T>(route: string, body: Record<string, unknown>): Promise<T> {
            calls.push({ method: "POST", route, body });
            return {
                ok: true,
                route,
                echo: body
            } as T;
        },
        async getJson<T>(route: string): Promise<T> {
            calls.push({ method: "GET", route });
            return {
                ok: true,
                route
            } as T;
        }
    };

    const router = new McpProtocolRouter({
        serverName: "cortexa-mcp",
        serverVersion: "0.1.0",
        protocolVersion: "2024-11-05",
        tools: buildTools(false),
        logger,
        executeTool: (name, argumentsValue) =>
            executeCortexaTool({
                name,
                argumentsValue,
                enableMutationTools: false,
                daemonClient,
                logger
            })
    });

    const initializeResponse = await router.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {}
    });

    assert.equal(initializeResponse?.error, undefined, "initialize should succeed");
    const initResult = initializeResponse?.result as {
        protocolVersion?: string;
        serverInfo?: { name?: string };
        capabilities?: { tools?: Record<string, unknown> };
    };
    assert.equal(initResult.protocolVersion, "2024-11-05", "protocol version should be returned");
    assert.equal(initResult.serverInfo?.name, "cortexa-mcp", "server name should match config");
    assert.ok(initResult.capabilities?.tools, "tools capability should be advertised");

    const listToolsResponse = await router.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {}
    });
    assert.equal(listToolsResponse?.error, undefined, "tools/list should succeed");

    const listedTools = (listToolsResponse?.result as { tools?: Array<{ name?: string }> }).tools ?? [];
    assert.ok(listedTools.length >= 6, "expected a broad tool surface");
    assert.ok(listedTools.some((tool) => tool.name === "cortexa_context"), "context tool should be listed");
    assert.ok(!listedTools.some((tool) => tool.name === "cortexa_ingest"), "mutation tool should be hidden when disabled");

    const queryResponse = await router.handle({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
            name: "cortexa_query",
            arguments: {
                query: "how does telemetry flow?",
                topK: 5
            }
        }
    });

    assert.equal(queryResponse?.error, undefined, "cortexa_query tool call should succeed");
    const queryResult = queryResponse?.result as {
        content?: Array<{ type?: string; text?: string }>;
        isError?: boolean;
    };
    assert.equal(queryResult.isError, undefined, "query result should not be marked as error");
    assert.equal(queryResult.content?.[0]?.type, "text", "query result should return text content block");
    assert.ok(calls.some((call) => call.method === "POST" && call.route === "/cxlink/query"), "query tool should hit cxlink query route");

    const disabledMutationResponse = await router.handle({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
            name: "cortexa_ingest",
            arguments: {
                path: "./"
            }
        }
    });

    assert.equal(disabledMutationResponse?.error?.code, -32601, "disabled mutation tool should not be exposed");

    const mcpCodecRouter = new McpProtocolRouter({
        serverName: "cortexa-mcp",
        serverVersion: "0.1.0",
        protocolVersion: "2024-11-05",
        tools: buildTools(true),
        logger,
        executeTool: (name, argumentsValue) =>
            executeCortexaTool({
                name,
                argumentsValue,
                enableMutationTools: true,
                daemonClient,
                logger
            })
    });

    await mcpCodecRouter.handle({
        jsonrpc: "2.0",
        id: 10,
        method: "initialize",
        params: {}
    });

    const encodeResponse = await mcpCodecRouter.handle({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
            name: "cortexa_encode_mcp_ctx",
            arguments: {
                intent: "normalize payload",
                scope: "integration",
                concepts: ["a", "a", "b"],
                entities: ["route:/cxlink/context"],
                constraints: ["token-bounded"]
            }
        }
    });

    assert.equal(encodeResponse?.error, undefined, "encode tool should succeed");
    const encodedText = (encodeResponse?.result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
    const encodedBody = JSON.parse(encodedText) as { payload?: string };
    assert.equal(typeof encodedBody.payload, "string", "encode tool should return payload text");

    const decodeResponse = await mcpCodecRouter.handle({
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: {
            name: "cortexa_decode_mcp_ctx",
            arguments: {
                payload: encodedBody.payload
            }
        }
    });

    assert.equal(decodeResponse?.error, undefined, "decode tool should succeed");
    const decodedText = (decodeResponse?.result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
    const decodedBody = JSON.parse(decodedText) as {
        decoded?: {
            intent?: string;
            concepts?: string[];
        };
    };
    assert.equal(decodedBody.decoded?.intent, "normalize payload", "decoded payload should preserve intent");
    assert.deepEqual(decodedBody.decoded?.concepts, ["a", "b"], "decoded payload should normalize concepts");

    console.log("✅ MCP server integration tests passed");
}

main().catch((error) => {
    console.error("❌ MCP server integration tests failed");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
