import { WebSocketServer } from "ws";
import { agentBus } from "../agent-bus/bus";
import { isStreamDelta, makeDelta, type StreamDelta } from "./delta-protocol";

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

export function startWsServer(port = 4321): ReturnType<typeof createWsServer> {
    const wss = createWsServer({ port });
    const maxBufferedBytes = toBoundedInt(readEnv("CORTEXA_STREAM_MAX_BUFFERED_BYTES"), 1_048_576, 16_384, 16_777_216);
    const maxInboundMessageBytes = toBoundedInt(readEnv("CORTEXA_STREAM_MAX_MESSAGE_BYTES"), 262_144, 1_024, 4_194_304);
    const replayLimit = toBoundedInt(readEnv("CORTEXA_STREAM_REPLAY_LIMIT"), 20, 1, 200);
    const heartbeatMs = toBoundedInt(readEnv("CORTEXA_STREAM_HEARTBEAT_MS"), 30_000, 5_000, 120_000);
    const aliveMap = new WeakMap<any, boolean>();

    const broadcast = (delta: StreamDelta): void => {
        const data = JSON.stringify(delta);
        for (const client of wss.clients) {
            if (client.readyState === 1 && client.bufferedAmount <= maxBufferedBytes) {
                client.send(data);
            }
        }
    };

    const onDelta = (delta: StreamDelta): void => {
        broadcast(delta);
    };

    const heartbeat = setInterval(() => {
        for (const client of wss.clients) {
            if (aliveMap.get(client) === false) {
                client.terminate();
                continue;
            }

            aliveMap.set(client, false);
            try {
                client.ping();
            } catch {
                client.terminate();
            }
        }
    }, heartbeatMs);

    agentBus.onEvent("stream:delta", onDelta);

    wss.on("connection", (socket: any) => {
        aliveMap.set(socket, true);
        socket.on("pong", () => {
            aliveMap.set(socket, true);
        });

        const hello = makeDelta({
            sessionId: "bootstrap",
            step: 0,
            deltaType: "snapshot",
            payload: { message: "cortexa stream connected" }
        });

        socket.send(JSON.stringify(hello));

        const replay = agentBus.replay(replayLimit);
        for (const delta of replay) {
            socket.send(JSON.stringify(delta));
        }

        socket.on("message", (raw: any) => {
            try {
                const payload = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
                if (payload.length > maxInboundMessageBytes) {
                    return;
                }

                const parsed = JSON.parse(payload);
                if (!isStreamDelta(parsed)) {
                    return;
                }

                const normalized = makeDelta({
                    sessionId: parsed.sessionId,
                    projectId: parsed.projectId,
                    step: parsed.step,
                    deltaType: parsed.deltaType,
                    payload: parsed.payload,
                    tokenEstimate: parsed.tokenEstimate,
                    replaceSpan: parsed.replaceSpan
                });

                agentBus.emitEvent("stream:delta", normalized);
            } catch {
                // Ignore malformed payloads.
            }
        });

        socket.on("close", () => {
            aliveMap.delete(socket);
        });
    });

    wss.on("close", () => {
        clearInterval(heartbeat);
        agentBus.offEvent("stream:delta", onDelta);
    });

    return wss;
}

function createWsServer(options: { port: number }) {
    return new WebSocketServer(options);
}
