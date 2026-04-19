export type McpLogLevel = "debug" | "info" | "warn" | "error";

interface McpLogRecord {
    ts: string;
    level: McpLogLevel;
    message: string;
    [key: string]: unknown;
}

const LOG_LEVEL_ORDER: Record<McpLogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40
};

export class McpLogger {
    constructor(private readonly level: McpLogLevel) { }

    debug(message: string, fields?: Record<string, unknown>): void {
        this.log("debug", message, fields);
    }

    info(message: string, fields?: Record<string, unknown>): void {
        this.log("info", message, fields);
    }

    warn(message: string, fields?: Record<string, unknown>): void {
        this.log("warn", message, fields);
    }

    error(message: string, fields?: Record<string, unknown>): void {
        this.log("error", message, fields);
    }

    private log(level: McpLogLevel, message: string, fields?: Record<string, unknown>): void {
        if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.level]) {
            return;
        }

        const payload: McpLogRecord = {
            ts: new Date().toISOString(),
            level,
            message,
            ...(fields ?? {})
        };

        process.stderr.write(`${JSON.stringify(payload)}\n`);
    }
}

export function createMcpLogger(level: McpLogLevel): McpLogger {
    return new McpLogger(level);
}
