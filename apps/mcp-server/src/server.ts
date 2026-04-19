import { readMcpServerConfigFromEnv } from "./config";
import { HttpCortexaDaemonClient } from "./daemon-client";
import { createMcpLogger } from "./logger";
import { McpProtocolRouter } from "./protocol/router";
import type { McpToolDescriptor } from "./protocol/types";
import { getCortexaToolCatalog } from "./tools/catalog";
import { executeCortexaTool } from "./tools/handlers";
import { StdioJsonRpcTransport } from "./transport/stdio";

async function main(): Promise<void> {
    const config = readMcpServerConfigFromEnv();
    const logger = createMcpLogger(config.logLevel);
    const daemonClient = new HttpCortexaDaemonClient(config, logger);

    const catalog = getCortexaToolCatalog({
        enableMutationTools: config.enableMutationTools
    });

    const tools: McpToolDescriptor[] = catalog.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
    }));

    const router = new McpProtocolRouter({
        serverName: config.serverName,
        serverVersion: config.serverVersion,
        protocolVersion: config.protocolVersion,
        tools,
        logger,
        executeTool: (name, argumentsValue) =>
            executeCortexaTool({
                name,
                argumentsValue,
                enableMutationTools: config.enableMutationTools,
                daemonClient,
                logger
            })
    });

    const transport = new StdioJsonRpcTransport(logger);
    transport.start((payload) => router.handle(payload));

    logger.info("mcp.server.started", {
        serverName: config.serverName,
        serverVersion: config.serverVersion,
        protocolVersion: config.protocolVersion,
        daemonBaseUrl: config.daemonBaseUrl,
        mutationToolsEnabled: config.enableMutationTools,
        toolCount: tools.length
    });

    process.on("SIGINT", () => {
        logger.info("mcp.server.stopping", {
            signal: "SIGINT"
        });
        process.exit(0);
    });

    process.on("SIGTERM", () => {
        logger.info("mcp.server.stopping", {
            signal: "SIGTERM"
        });
        process.exit(0);
    });
}

void main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(
        `${JSON.stringify({ ts: new Date().toISOString(), level: "error", message: "mcp.server.fatal", error: message })}\n`
    );
    process.exit(1);
});
