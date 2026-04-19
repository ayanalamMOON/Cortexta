import { toBoolean, toBoundedInt, toTrimmedString } from "../../../core/daemon/http";

export interface McpServerConfig {
    serverName: string;
    serverVersion: string;
    protocolVersion: string;
    daemonBaseUrl: string;
    daemonToken?: string;
    requestTimeoutMs: number;
    enableMutationTools: boolean;
    logLevel: "debug" | "info" | "warn" | "error";
}

const DEFAULT_MCP_CONFIG: McpServerConfig = {
    serverName: "cortexa-mcp",
    serverVersion: "0.1.0",
    protocolVersion: "2024-11-05",
    daemonBaseUrl: "http://127.0.0.1:4312",
    daemonToken: undefined,
    requestTimeoutMs: 20_000,
    enableMutationTools: false,
    logLevel: "info"
};

function readEnv(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

function normalizeBaseUrl(value: string | undefined): string {
    const normalized = toTrimmedString(value, 2048) ?? DEFAULT_MCP_CONFIG.daemonBaseUrl;
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function normalizeLogLevel(value: string | undefined): McpServerConfig["logLevel"] {
    const normalized = value?.trim().toLowerCase();
    if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
        return normalized;
    }

    return DEFAULT_MCP_CONFIG.logLevel;
}

export function readMcpServerConfigFromEnv(): McpServerConfig {
    return {
        serverName: toTrimmedString(readEnv("CORTEXA_MCP_SERVER_NAME"), 128) ?? DEFAULT_MCP_CONFIG.serverName,
        serverVersion: toTrimmedString(readEnv("CORTEXA_MCP_SERVER_VERSION"), 128) ?? DEFAULT_MCP_CONFIG.serverVersion,
        protocolVersion:
            toTrimmedString(readEnv("CORTEXA_MCP_PROTOCOL_VERSION"), 64) ?? DEFAULT_MCP_CONFIG.protocolVersion,
        daemonBaseUrl: normalizeBaseUrl(readEnv("CORTEXA_MCP_DAEMON_URL")),
        daemonToken: toTrimmedString(readEnv("CORTEXA_MCP_DAEMON_TOKEN"), 512),
        requestTimeoutMs:
            toBoundedInt(readEnv("CORTEXA_MCP_TIMEOUT_MS"), 1_000, 120_000) ?? DEFAULT_MCP_CONFIG.requestTimeoutMs,
        enableMutationTools: toBoolean(
            readEnv("CORTEXA_MCP_ENABLE_MUTATIONS"),
            DEFAULT_MCP_CONFIG.enableMutationTools
        ),
        logLevel: normalizeLogLevel(readEnv("CORTEXA_MCP_LOG_LEVEL"))
    };
}
