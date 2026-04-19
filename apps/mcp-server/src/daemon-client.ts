import type { McpServerConfig } from "./config";
import type { McpLogger } from "./logger";

export interface CortexaDaemonClient {
    postJson<T>(route: string, body: Record<string, unknown>): Promise<T>;
    getJson<T>(route: string): Promise<T>;
}

function normalizeRoute(route: string): string {
    const trimmed = route.trim();
    if (!trimmed) {
        return "/";
    }

    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

async function parseJsonSafely(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text.trim()) {
        return {};
    }

    try {
        return JSON.parse(text) as unknown;
    } catch {
        return { raw: text };
    }
}

export class HttpCortexaDaemonClient implements CortexaDaemonClient {
    constructor(
        private readonly config: McpServerConfig,
        private readonly logger: McpLogger
    ) { }

    async postJson<T>(route: string, body: Record<string, unknown>): Promise<T> {
        return this.requestJson<T>("POST", route, body);
    }

    async getJson<T>(route: string): Promise<T> {
        return this.requestJson<T>("GET", route);
    }

    private async requestJson<T>(method: "GET" | "POST", route: string, body?: Record<string, unknown>): Promise<T> {
        const normalizedRoute = normalizeRoute(route);
        const url = `${this.config.daemonBaseUrl}${normalizedRoute}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

        const headers: Record<string, string> = {
            accept: "application/json"
        };

        if (method === "POST") {
            headers["content-type"] = "application/json";
        }

        if (this.config.daemonToken) {
            headers["x-cortexa-token"] = this.config.daemonToken;
        }

        this.logger.debug("daemon.request", {
            method,
            route: normalizedRoute
        });

        try {
            const response = await fetch(url, {
                method,
                headers,
                body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
                signal: controller.signal
            });

            const payload = await parseJsonSafely(response);

            if (!response.ok) {
                const message =
                    payload && typeof payload === "object" && "error" in payload
                        ? String((payload as { error?: unknown }).error ?? "daemon_request_failed")
                        : `daemon_request_failed_${response.status}`;

                throw new Error(`[${method} ${normalizedRoute}] ${message}`);
            }

            return payload as T;
        } catch (error) {
            this.logger.error("daemon.request.failed", {
                method,
                route: normalizedRoute,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }
}
