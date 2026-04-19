import type { McpLogger } from "../logger";
import type { JsonRpcResponse } from "../protocol/types";

type MessageHandler = (payload: unknown) => Promise<JsonRpcResponse | undefined>;

function findHeaderTerminator(buffer: Buffer): number {
    return buffer.indexOf("\r\n\r\n");
}

function parseContentLength(headerText: string): number | undefined {
    const lines = headerText.split("\r\n");
    for (const line of lines) {
        const match = /^content-length\s*:\s*(\d+)$/i.exec(line.trim());
        if (!match) {
            continue;
        }

        const parsed = Number(match[1]);
        if (!Number.isFinite(parsed) || parsed < 0) {
            return undefined;
        }

        return Math.trunc(parsed);
    }

    return undefined;
}

function encodeResponse(response: JsonRpcResponse): Buffer {
    const body = Buffer.from(JSON.stringify(response), "utf8");
    const header = Buffer.from(
        `Content-Length: ${body.length}\r\nContent-Type: application/json\r\n\r\n`,
        "utf8"
    );

    return Buffer.concat([header, body]);
}

export class StdioJsonRpcTransport {
    private buffer = Buffer.alloc(0);

    private started = false;

    constructor(private readonly logger: McpLogger) { }

    start(handler: MessageHandler): void {
        if (this.started) {
            return;
        }
        this.started = true;

        process.stdin.on("data", (chunk: Buffer) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            void this.flush(handler);
        });

        process.stdin.on("error", (error: Error) => {
            this.logger.error("mcp.transport.stdin.error", {
                error: error.message
            });
        });

        process.stdin.resume();
    }

    async send(response: JsonRpcResponse): Promise<void> {
        const encoded = encodeResponse(response);

        await new Promise<void>((resolve, reject) => {
            process.stdout.write(encoded, (error?: Error | null) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });
    }

    private async flush(handler: MessageHandler): Promise<void> {
        while (true) {
            const headerEndIndex = findHeaderTerminator(this.buffer);
            if (headerEndIndex < 0) {
                return;
            }

            const headerText = this.buffer.slice(0, headerEndIndex).toString("utf8");
            const contentLength = parseContentLength(headerText);
            if (contentLength === undefined) {
                this.logger.warn("mcp.transport.invalid_header", {
                    header: headerText
                });

                this.buffer = this.buffer.slice(headerEndIndex + 4);
                await this.send({
                    jsonrpc: "2.0",
                    id: null,
                    error: {
                        code: -32700,
                        message: "Parse error: missing or invalid Content-Length header"
                    }
                });
                continue;
            }

            const frameStart = headerEndIndex + 4;
            const frameEnd = frameStart + contentLength;
            if (this.buffer.length < frameEnd) {
                return;
            }

            const bodyText = this.buffer.slice(frameStart, frameEnd).toString("utf8");
            this.buffer = this.buffer.slice(frameEnd);

            let payload: unknown;
            try {
                payload = JSON.parse(bodyText) as unknown;
            } catch (error) {
                this.logger.warn("mcp.transport.invalid_json", {
                    error: error instanceof Error ? error.message : String(error)
                });

                await this.send({
                    jsonrpc: "2.0",
                    id: null,
                    error: {
                        code: -32700,
                        message: "Parse error: invalid JSON payload"
                    }
                });
                continue;
            }

            try {
                const response = await handler(payload);
                if (response) {
                    await this.send(response);
                }
            } catch (error) {
                this.logger.error("mcp.transport.handler.error", {
                    error: error instanceof Error ? error.message : String(error)
                });

                await this.send({
                    jsonrpc: "2.0",
                    id: null,
                    error: {
                        code: -32603,
                        message: "Internal error"
                    }
                });
            }
        }
    }
}
