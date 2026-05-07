import WebSocket from "ws";

export interface ContextStreamSuggestionAckInput {
    projectId: string;
    branch?: string;
    suggestionHash: string;
    action: "ack" | "applied" | "suppressed";
    reason?: string;
}

export interface ContextStreamStartInput {
    rootPath: string;
    projectId?: string;
    branch?: string;
    config?: Record<string, unknown>;
}

export interface ContextStreamSubscriptionOptions {
    onOpen?: () => void;
    onClose?: (code: number, reason: string) => void;
    onError?: (error: Error) => void;
    onDelta?: (delta: ContextStreamSocketMessage) => void;
    onSuggestion?: (message: ContextStreamSocketMessage) => void;
    filterProjectId?: string;
}

export interface ContextStreamSubscription {
    socket: WebSocket;
    waitForOpen(): Promise<void>;
    close(code?: number, reason?: string): void;
}

export interface ContextStreamSocketMessage {
    sessionId: string;
    projectId?: string;
    step: number;
    deltaType: "snapshot" | "append" | "replace" | "remove";
    payload: {
        eventType?: string;
        [key: string]: unknown;
    };
    tokenEstimate?: number;
    replaceSpan?: {
        start: number;
        end: number;
    };
    checksum?: string;
    timestamp?: number;
}

export interface ContextStreamClientOptions {
    daemonBaseUrl?: string;
    daemonToken?: string;
    requestTimeoutMs?: number;
    wsBaseUrl?: string;
    wsPort?: number;
}

export interface ContextStreamStatusResponse {
    ok?: boolean;
    status?: {
        enabled?: boolean;
        running?: boolean;
        streams?: Array<Record<string, unknown>>;
    };
}

function readEnv(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

function toBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
    const source = typeof value === "string" ? Number(value) : value;
    if (typeof source !== "number" || !Number.isFinite(source)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.trunc(source)));
}

function normalizeBaseUrl(value?: string): string {
    const trimmed = value?.trim();
    if (trimmed) {
        return trimmed.replace(/\/+$/, "");
    }

    const envBase = readEnv("CORTEXA_DAEMON_BASE_URL")?.trim();
    if (envBase) {
        return envBase.replace(/\/+$/, "");
    }

    const daemonPort = toBoundedInt(readEnv("CORTEXA_DAEMON_PORT"), 4312, 1, 65535);
    return `http://127.0.0.1:${daemonPort}`;
}

function normalizeWsUrl(value?: string): string | undefined {
    const trimmed = value?.trim();
    if (trimmed) {
        return trimmed.replace(/\/+$/, "");
    }

    const envUrl = readEnv("CORTEXA_WS_URL")?.trim();
    if (envUrl) {
        return envUrl.replace(/\/+$/, "");
    }

    return undefined;
}

function buildWebSocketUrl(daemonBaseUrl: string, wsBaseUrl?: string, wsPort?: number): string {
    const explicit = normalizeWsUrl(wsBaseUrl);
    if (explicit) {
        return explicit;
    }

    const daemonUrl = new URL(daemonBaseUrl);
    const protocol = daemonUrl.protocol === "https:" ? "wss:" : "ws:";
    const port = toBoundedInt(wsPort ?? readEnv("CORTEXA_WS_PORT"), 4321, 1, 65535);
    return `${protocol}//${daemonUrl.hostname}:${port}`;
}

function normalizeRoute(route: string): string {
    const trimmed = route.trim();
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

function toContextStreamMessage(raw: unknown): ContextStreamSocketMessage | null {
    if (!raw || typeof raw !== "object") {
        return null;
    }

    const candidate = raw as ContextStreamSocketMessage;
    if (
        typeof candidate.sessionId !== "string" ||
        typeof candidate.step !== "number" ||
        !Number.isFinite(candidate.step) ||
        (candidate.deltaType !== "snapshot" && candidate.deltaType !== "append" && candidate.deltaType !== "replace" && candidate.deltaType !== "remove") ||
        !candidate.payload ||
        typeof candidate.payload !== "object"
    ) {
        return null;
    }

    return candidate;
}

function parseSocketPayload(raw: unknown): ContextStreamSocketMessage | null {
    const text =
        typeof raw === "string"
            ? raw
            : Buffer.isBuffer(raw)
                ? raw.toString("utf8")
                : raw instanceof ArrayBuffer
                    ? Buffer.from(raw).toString("utf8")
                    : ArrayBuffer.isView(raw)
                        ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8")
                        : String(raw);

    try {
        return toContextStreamMessage(JSON.parse(text));
    } catch {
        return null;
    }
}

export class CortexaContextStreamClient {
    private readonly daemonBaseUrl: string;

    private readonly daemonToken?: string;

    private readonly requestTimeoutMs: number;

    private readonly wsBaseUrl: string;

    constructor(options: ContextStreamClientOptions = {}) {
        this.daemonBaseUrl = normalizeBaseUrl(options.daemonBaseUrl);
        this.daemonToken = options.daemonToken?.trim() || readEnv("CORTEXA_DAEMON_TOKEN")?.trim() || undefined;
        this.requestTimeoutMs = toBoundedInt(options.requestTimeoutMs ?? readEnv("CORTEXA_DAEMON_REQUEST_TIMEOUT_MS"), 10_000, 1_000, 60_000);
        this.wsBaseUrl = buildWebSocketUrl(this.daemonBaseUrl, options.wsBaseUrl, options.wsPort);
    }

    get daemonUrl(): string {
        return this.daemonBaseUrl;
    }

    get websocketUrl(): string {
        return this.wsBaseUrl;
    }

    async start(input: ContextStreamStartInput): Promise<Record<string, unknown>> {
        return this.requestJson("POST", "/context/stream/start", input);
    }

    async stop(projectId: string, branch?: string): Promise<Record<string, unknown>> {
        return this.requestJson("POST", "/context/stream/stop", {
            projectId,
            branch
        });
    }

    async status(): Promise<ContextStreamStatusResponse> {
        return this.requestJson<ContextStreamStatusResponse>("POST", "/context/stream/status", {});
    }

    async ack(input: ContextStreamSuggestionAckInput): Promise<Record<string, unknown>> {
        return this.requestJson("POST", "/context/stream/ack", input);
    }

    subscribe(options: ContextStreamSubscriptionOptions = {}): ContextStreamSubscription {
        const socket = new WebSocket(this.wsBaseUrl);
        let settled = false;
        let openResolve: (() => void) | null = null;
        let openReject: ((error: Error) => void) | null = null;

        const openPromise = new Promise<void>((resolve, reject) => {
            openResolve = resolve;
            openReject = reject;
        });

        const failOpen = (error: Error): void => {
            if (!settled) {
                settled = true;
                openReject?.(error);
            }
            options.onError?.(error);
        };

        socket.on("open", () => {
            if (!settled) {
                settled = true;
                openResolve?.();
            }
            options.onOpen?.();
        });

        socket.on("error", (error: Error) => {
            failOpen(error);
        });

        socket.on("close", (code: number, reason: Buffer) => {
            options.onClose?.(code, reason.toString("utf8"));
        });

        socket.on("message", (raw: unknown) => {
            const delta = parseSocketPayload(raw);
            if (!delta) {
                return;
            }

            if (options.filterProjectId && delta.projectId && delta.projectId !== options.filterProjectId) {
                return;
            }

            options.onDelta?.(delta);
            if (delta.payload?.eventType && delta.payload.eventType.startsWith("contextDelta")) {
                options.onSuggestion?.(delta);
            }
        });

        return {
            socket,
            waitForOpen: () => openPromise,
            close: (code = 1000, reason = "client_close") => {
                if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
                    return;
                }
                socket.close(code, reason);
            }
        };
    }

    async requestJson<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
        const normalizedRoute = normalizeRoute(route);
        const url = `${this.daemonBaseUrl}${normalizedRoute}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

        const headers: Record<string, string> = {
            accept: "application/json"
        };

        if (method === "POST") {
            headers["content-type"] = "application/json";
        }

        if (this.daemonToken) {
            headers["x-cortexa-token"] = this.daemonToken;
        }

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
        } finally {
            clearTimeout(timeout);
        }
    }
}

export function createCortexaContextStreamClient(options: ContextStreamClientOptions = {}): CortexaContextStreamClient {
    return new CortexaContextStreamClient(options);
}
