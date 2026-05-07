import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

type DaemonRuntime = {
    server: { address: () => AddressInfo | string | null; close: (cb?: () => void) => void };
    wss?: { address?: () => AddressInfo | string | null } | null;
    close: (cb?: () => void) => void;
};

function parseStreamMessage(raw: unknown): Record<string, any> | null {
    const text =
        typeof raw === "string"
            ? raw
            : Buffer.isBuffer(raw)
                ? raw.toString("utf8")
                : String(raw);

    try {
        return JSON.parse(text) as Record<string, any>;
    } catch {
        return null;
    }
}

async function waitForMessage(
    socket: WebSocket,
    predicate: (message: Record<string, any>) => boolean,
    timeoutMs: number,
    label: string
): Promise<Record<string, any>> {
    const wsSocket = socket as any;
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for ${label}`));
        }, timeoutMs);

        const cleanup = () => {
            clearTimeout(timeout);
            wsSocket.removeListener("message", onMessage);
            wsSocket.removeListener("error", onError);
        };

        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };

        const onMessage = (raw: unknown) => {
            const parsed = parseStreamMessage(raw);
            if (parsed && predicate(parsed)) {
                cleanup();
                resolve(parsed);
            }
        };

        wsSocket.on("error", onError);
        wsSocket.on("message", onMessage);
    });
}

async function postJson(baseUrl: string, route: string, body: unknown, token: string): Promise<Response> {
    return fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-cortexa-token": token
        },
        body: JSON.stringify(body)
    });
}

async function expectStatus(response: Response, expected: number, context: string): Promise<void> {
    if (response.status === expected) {
        return;
    }

    const body = await response.text();
    throw new Error(`${context} expected status ${expected}, got ${response.status}. body=${body}`);
}

async function main(): Promise<void> {
    const token = "context-stream-token";
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortexa-context-stream-"));
    const workspacePath = path.join(tempRoot, "workspace");
    fs.mkdirSync(workspacePath, { recursive: true });

    const sourceFile = path.join(workspacePath, "live-stream-sample.ts");
    fs.writeFileSync(
        sourceFile,
        [
            "export function initialContextStreamValue(input: number): number {",
            "  return input + 1;",
            "}",
            ""
        ].join("\n"),
        "utf8"
    );

    process.env.CORTEXA_DAEMON_TOKEN = token;
    process.env.CORTEXA_DAEMON_AUTOSTART = "0";
    process.env.CORTEXA_VECTOR_PROVIDER = "memory";
    process.env.CORTEXA_CONTEXT_STREAM_ENABLED = "false";

    const { startDaemon } = require("../apps/daemon/src/server") as {
        startDaemon: (port?: number, wsPort?: number) => DaemonRuntime;
    };

    let runtime: DaemonRuntime | null = null;
    let socket: WebSocket | null = null;

    try {
        runtime = startDaemon(0, 0);
        await once(runtime.server as any, "listening");

        const httpAddress = runtime.server.address() as AddressInfo | null;
        const wsAddress = runtime.wss?.address?.() as AddressInfo | null;
        if (!httpAddress?.port || !wsAddress?.port) {
            throw new Error("failed to resolve daemon ports");
        }

        const baseUrl = `http://127.0.0.1:${httpAddress.port}`;
        const wsUrl = `ws://127.0.0.1:${wsAddress.port}`;

        const wsSocket = new WebSocket(wsUrl);
        socket = wsSocket;
        await once(wsSocket as any, "open");

        const startResponse = await postJson(
            baseUrl,
            "/context/stream/start",
            {
                rootPath: workspacePath,
                projectId: "context-stream-e2e",
                branch: "feature/live-stream",
                debounceMs: 250,
                minConfidence: 0.1,
                maxSuggestionsPerMinute: 8,
                topK: 6,
                maxTokens: 1200,
                previewChars: 600,
                suggestionTtlMs: 20_000,
                dedupeWindowMs: 5_000,
                includeUnknownLanguages: false,
                suppressOnCriticalRisk: false
            },
            token
        );
        await expectStatus(startResponse, 200, "[context-stream] start route");
        const startBody = (await startResponse.json()) as {
            ok?: boolean;
            route?: string;
            started?: {
                id?: string;
                projectId?: string;
                branch?: string;
                activeSuggestions?: number;
            };
        };
        assert.equal(startBody.ok, true, "[context-stream] start ok");
        assert.equal(startBody.route, "context/stream/start", "[context-stream] start route name");
        assert.equal(startBody.started?.projectId, "context-stream-e2e", "[context-stream] start projectId");
        assert.equal(startBody.started?.branch, "feature/live-stream", "[context-stream] start branch");

        const statusResponse = await postJson(baseUrl, "/context/stream/status", {}, token);
        await expectStatus(statusResponse, 200, "[context-stream] status route");
        const statusBody = (await statusResponse.json()) as {
            ok?: boolean;
            status?: {
                running?: boolean;
                streams?: Array<{
                    projectId?: string;
                    activeSuggestions?: number;
                    queuedEvents?: number;
                    processedEvents?: number;
                    lastSuggestionHash?: string;
                }>;
            };
        };
        assert.equal(statusBody.ok, true, "[context-stream] status ok");
        assert.equal(statusBody.status?.running, true, "[context-stream] status running");
        assert.ok((statusBody.status?.streams?.length ?? 0) >= 1, "[context-stream] status stream count");
        assert.equal(typeof statusBody.status?.streams?.[0]?.queuedEvents, "number", "[context-stream] status queuedEvents");
        assert.equal(typeof statusBody.status?.streams?.[0]?.processedEvents, "number", "[context-stream] status processedEvents");

        const updateEventPromise = waitForMessage(
            wsSocket,
            (message) => message?.payload?.eventType === "contextDeltaSuggested" && message?.projectId === "context-stream-e2e",
            15000,
            "contextDeltaSuggested"
        );

        fs.writeFileSync(
            sourceFile,
            [
                "export function initialContextStreamValue(input: number): number {",
                "  return input + 2;",
                "}",
                "",
                "export function liveContextStreamHelper(value: string): string {",
                "  return value.trim().toUpperCase();",
                "}"
            ].join("\n"),
            "utf8"
        );

        const updateEvent = await updateEventPromise;
        assert.equal(updateEvent?.payload?.eventType, "contextDeltaSuggested", "[context-stream] websocket event type");
        assert.equal(updateEvent?.projectId, "context-stream-e2e", "[context-stream] websocket projectId");
        assert.equal(typeof updateEvent?.payload?.reason, "string", "[context-stream] websocket reason");
        assert.equal(typeof updateEvent?.payload?.contextPreview, "string", "[context-stream] websocket preview");
        assert.ok(Array.isArray(updateEvent?.payload?.memoryIds), "[context-stream] websocket memoryIds array");
        assert.equal(typeof updateEvent?.payload?.fileKind, "string", "[context-stream] websocket fileKind");

        const suggestionHash = updateEvent?.payload?.suggestionHash as string | undefined;
        assert.equal(typeof suggestionHash, "string", "[context-stream] suggestion hash");

        const ackResponse = await postJson(
            baseUrl,
            "/context/stream/ack",
            {
                projectId: "context-stream-e2e",
                branch: "feature/live-stream",
                suggestionHash,
                action: "applied",
                reason: "integration-test"
            },
            token
        );
        await expectStatus(ackResponse, 200, "[context-stream] ack route");
        const ackBody = (await ackResponse.json()) as {
            ok?: boolean;
            suggestion?: { suggestionHash?: string; projectId?: string };
        };
        assert.equal(ackBody.ok, true, "[context-stream] ack ok");
        assert.equal(ackBody.suggestion?.suggestionHash, suggestionHash, "[context-stream] acked hash");

        const postAckStatusResponse = await postJson(baseUrl, "/context/stream/status", {}, token);
        await expectStatus(postAckStatusResponse, 200, "[context-stream] post-ack status route");
        const postAckStatusBody = (await postAckStatusResponse.json()) as {
            status?: { streams?: Array<{ activeSuggestions?: number; lastSuggestionHash?: string }> };
        };
        assert.equal(
            postAckStatusBody.status?.streams?.[0]?.activeSuggestions,
            0,
            "[context-stream] active suggestions cleared after apply"
        );
        assert.equal(
            postAckStatusBody.status?.streams?.[0]?.lastSuggestionHash,
            suggestionHash,
            "[context-stream] last suggestion hash tracked"
        );

        const stopResponse = await postJson(
            baseUrl,
            "/context/stream/stop",
            {
                projectId: "context-stream-e2e",
                branch: "feature/live-stream"
            },
            token
        );
        await expectStatus(stopResponse, 200, "[context-stream] stop route");
        const stopBody = (await stopResponse.json()) as { ok?: boolean; stopped?: boolean };
        assert.equal(stopBody.ok, true, "[context-stream] stop ok");
        assert.equal(stopBody.stopped, true, "[context-stream] stopped true");

        const stoppedStatusResponse = await postJson(baseUrl, "/context/stream/status", {}, token);
        await expectStatus(stoppedStatusResponse, 200, "[context-stream] stopped status route");
        const stoppedStatusBody = (await stoppedStatusResponse.json()) as {
            status?: { running?: boolean; streams?: unknown[] };
        };
        assert.equal(stoppedStatusBody.status?.running, false, "[context-stream] stopped running false");
        assert.equal((stoppedStatusBody.status?.streams?.length ?? 0), 0, "[context-stream] stopped stream count");

        console.log("✅ context stream integration test passed");
    } finally {
        if (socket) {
            socket.close();
        }
        if (runtime) {
            await new Promise<void>((resolve) => runtime?.close(() => resolve()));
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error("❌ context stream integration test failed");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
