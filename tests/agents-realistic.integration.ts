import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

interface DaemonRuntime {
    server: { address: () => AddressInfo | string | null; close: (cb?: () => void) => void };
    wss?: { address?: () => AddressInfo | string | null } | null;
    close: (cb?: () => void) => void;
}

interface StreamDeltaMessage {
    sessionId?: string;
    deltaType?: string;
    payload?: {
        eventType?: string;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

function parseStreamMessage(raw: unknown): StreamDeltaMessage | null {
    const text =
        typeof raw === "string"
            ? raw
            : Buffer.isBuffer(raw)
                ? raw.toString("utf8")
                : String(raw);

    try {
        return JSON.parse(text) as StreamDeltaMessage;
    } catch {
        return null;
    }
}

function waitForSocketMessage(
    socket: any,
    predicate: (message: StreamDeltaMessage) => boolean,
    timeoutMs: number,
    label: string
): Promise<StreamDeltaMessage> {
    return new Promise((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
            clearTimeout(timeout);
            socket.removeListener("message", onMessage);
            socket.removeListener("error", onError);
        };

        const settle = (error?: Error, message?: StreamDeltaMessage) => {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();

            if (error) {
                reject(error);
                return;
            }

            resolve(message as StreamDeltaMessage);
        };

        const timeout = setTimeout(() => {
            settle(new Error(`Timed out waiting for ${label} message over daemon WebSocket.`));
        }, timeoutMs);

        const onError = (error: Error) => {
            settle(error);
        };

        const onMessage = (raw: unknown) => {
            const parsed = parseStreamMessage(raw);
            if (!parsed) {
                return;
            }

            if (predicate(parsed)) {
                settle(undefined, parsed);
            }
        };

        socket.on("error", onError);
        socket.on("message", onMessage);
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
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortexa-agents-realistic-"));
    const tempDbPath = path.join(tempRoot, "agents-realistic.db");
    const token = "agents-realistic-token";
    const workspacePath = path.resolve(__dirname, "..");
    const runId = Date.now().toString(36);
    const projectId = `agent-realistic-${runId}`;
    const branch = "feature/agent-e2e";
    const applyMarker = `AGENT_E2E_APPLY_${runId}`;
    const wsMarker = `AGENT_WS_EVENT_${runId}`;

    process.env.CORTEXA_DB_PATH = tempDbPath;
    process.env.CORTEXA_VECTOR_PROVIDER = "memory";
    process.env.CORTEXA_DAEMON_TOKEN = token;
    process.env.CORTEXA_DAEMON_AUTOSTART = "0";

    const { runIngestion } = require("../core/ingestion/ingest.pipeline") as {
        runIngestion: (input: {
            projectPath: string;
            projectId: string;
            branch?: string;
            includeChats?: boolean;
            skipUnchanged?: boolean;
            maxFiles?: number;
        }) => Promise<{
            filesScanned: number;
            codeChunks: number;
            memoriesStored: number;
            errors: string[];
        }>;
    };

    const { searchMemories } = require("../core/mempalace/memory.service") as {
        searchMemories: (query: string, options?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };

    const { listCortexaAgents, runCortexaAgent } = require("../core/agents/orchestrator.service") as {
        listCortexaAgents: () => Array<{ id: string; family: string; mutation: boolean; description: string }>;
        runCortexaAgent: (input: {
            agent: string;
            text: string;
            projectId?: string;
            branch?: string;
            context?: string;
            dryRun?: boolean;
            topK?: number;
            maxChars?: number;
            existingSnippets?: string[];
        }) => Promise<{
            ok: boolean;
            agent: string;
            dryRun: boolean;
            output: unknown;
        }>;
    };

    const { startDaemon } = require("../apps/daemon/src/server") as {
        startDaemon: (port?: number, wsPort?: number) => DaemonRuntime;
    };

    const { closeSqlite } = require("../storage/sqlite/db") as {
        closeSqlite: () => void;
    };

    let runtime: DaemonRuntime | null = null;
    let socket: WebSocket | null = null;

    try {
        const ingestion = await runIngestion({
            projectPath: workspacePath,
            projectId,
            branch,
            includeChats: false,
            skipUnchanged: true,
            maxFiles: 600
        });

        assert.ok(ingestion.filesScanned > 0, "realistic ingest should scan project files");
        assert.ok(ingestion.codeChunks > 0, "realistic ingest should parse code chunks");
        assert.ok(ingestion.memoriesStored > 0, "realistic ingest should store memories");
        assert.equal(ingestion.errors.length, 0, "realistic ingest should complete without parse errors");

        const catalog = listCortexaAgents();
        const expectedAgents = [
            "writer",
            "critic",
            "compressor",
            "planner",
            "refactor",
            "evolution_writer",
            "evolution_critic",
            "evolution_consolidator",
            "evolution_archivist",
            "multi_agent_loop"
        ];

        for (const agentId of expectedAgents) {
            assert.ok(catalog.some((agent) => agent.id === agentId), `agent catalog should include ${agentId}`);
        }

        const plannerRun = await runCortexaAgent({
            agent: "planner",
            text: "Plan a safe rollout for cxlink agent orchestration with tests and telemetry.",
            projectId,
            branch,
            context: "Repository has daemon, CLI, and MCP surfaces; preserve backward compatibility.",
            dryRun: true,
            topK: 8
        });
        const plannerOutput = plannerRun.output as {
            plan?: {
                intent?: string;
                steps?: unknown[];
            };
        };

        assert.equal(plannerRun.ok, true, "planner run should succeed");
        assert.equal(plannerRun.dryRun, true, "planner run should remain dry-run");
        assert.equal(typeof plannerOutput.plan?.intent, "string", "planner run should infer intent");
        assert.ok((plannerOutput.plan?.steps?.length ?? 0) >= 3, "planner run should return structured steps");

        const refactorRun = await runCortexaAgent({
            agent: "refactor",
            text: "Refactor cxlink route handling to reduce duplication while preserving strict validation.",
            projectId,
            branch,
            dryRun: true,
            topK: 8
        });
        const refactorOutput = refactorRun.output as {
            suggestion?: {
                actions?: unknown[];
                tests?: unknown[];
            };
        };

        assert.equal(refactorRun.ok, true, "refactor run should succeed");
        assert.equal(refactorRun.dryRun, true, "refactor run should default to dry-run");
        assert.ok((refactorOutput.suggestion?.actions?.length ?? 0) >= 1, "refactor run should return actions");
        assert.ok((refactorOutput.suggestion?.tests?.length ?? 0) >= 1, "refactor run should return tests");

        const loopDryRun = await runCortexaAgent({
            agent: "multi_agent_loop",
            text: `Create and validate execution memory ${runId} for daemon CLI MCP coordination reliability.`,
            projectId,
            branch,
            context: "realistic end-to-end scenario",
            dryRun: true,
            topK: 8,
            maxChars: 600
        });
        const loopDryOutput = loopDryRun.output as {
            stages?: unknown[];
            progression?: {
                persisted?: boolean;
            };
        };

        assert.equal(loopDryRun.ok, true, "multi-agent dry run should succeed");
        assert.equal(loopDryRun.dryRun, true, "multi-agent dry run should set dryRun=true");
        assert.ok(Array.isArray(loopDryOutput.stages), "multi-agent dry run should expose stage list");
        assert.equal(loopDryOutput.progression?.persisted, false, "dry-run progression should not persist");

        const loopApplyRun = await runCortexaAgent({
            agent: "multi_agent_loop",
            text: `Persist execution memory ${applyMarker} proving non-dry loop writes to mempalace retrieval.`,
            projectId,
            branch,
            context: "apply verification",
            dryRun: false,
            topK: 8,
            maxChars: 600
        });
        const loopApplyOutput = loopApplyRun.output as {
            progression?: {
                persisted?: boolean;
                result?: {
                    stored?: boolean;
                };
            };
        };

        assert.equal(loopApplyRun.ok, true, "multi-agent apply run should succeed");
        assert.equal(loopApplyRun.dryRun, false, "multi-agent apply run should set dryRun=false");
        assert.equal(loopApplyOutput.progression?.persisted, true, "apply progression should persist");
        assert.equal(loopApplyOutput.progression?.result?.stored, true, "apply progression should store memory atom");

        const retrieved = await searchMemories(applyMarker, {
            projectId,
            branch,
            topK: 5,
            minScore: 0
        });

        assert.ok(retrieved.length >= 1, "persisted marker should be retrievable by query");
        assert.ok(
            retrieved.some((row) => JSON.stringify(row).includes(applyMarker)),
            "retrieved rows should include the persisted apply marker"
        );

        for (const descriptor of catalog) {
            const smoke = await runCortexaAgent({
                agent: descriptor.id,
                text: `Full catalog smoke ${runId}`,
                projectId,
                branch,
                context: "full-catalog realistic smoke",
                dryRun: true,
                topK: 6,
                maxChars: 500
            });

            assert.equal(smoke.ok, true, `catalog smoke should pass for agent ${descriptor.id}`);
        }

        runtime = startDaemon(0, 0);
        await once(runtime.server as any, "listening");

        const httpAddress = runtime.server.address() as AddressInfo | null;
        const wsAddress = runtime.wss?.address?.() as AddressInfo | null;

        if (!httpAddress?.port || !wsAddress?.port) {
            throw new Error("Failed to resolve daemon HTTP/WS ephemeral ports for realistic agent runtime test.");
        }

        const baseUrl = `http://127.0.0.1:${httpAddress.port}`;
        const wsUrl = `ws://127.0.0.1:${wsAddress.port}`;

        const activeSocket: any = new WebSocket(wsUrl);
        socket = activeSocket;
        const bootstrapPromise = waitForSocketMessage(
            activeSocket,
            (message) => message.sessionId === "bootstrap",
            8_000,
            "bootstrap"
        );
        await once(activeSocket as any, "open");
        const bootstrap = await bootstrapPromise;

        assert.equal(bootstrap.deltaType, "snapshot", "daemon WS should emit bootstrap snapshot");

        const agentStatusPromise = waitForSocketMessage(
            activeSocket,
            (message) => message.payload?.eventType === "agentStatus",
            10_000,
            "agentStatus"
        );

        const daemonAgentRun = await postJson(
            baseUrl,
            "/cxlink/agent/run",
            {
                projectId,
                branch,
                agent: "multi_agent_loop",
                text: `Emit ${wsMarker} through daemon stream for realistic validation.`,
                dryRun: true,
                topK: 8,
                maxChars: 600
            },
            token
        );

        await expectStatus(daemonAgentRun, 200, "daemon /cxlink/agent/run realistic scenario");
        const daemonAgentBody = (await daemonAgentRun.json()) as {
            ok?: boolean;
            route?: string;
            streamEvent?: {
                payload?: {
                    eventType?: string;
                };
            };
        };

        assert.equal(daemonAgentBody.ok, true, "daemon /cxlink/agent/run should return ok");
        assert.equal(daemonAgentBody.route, "cxlink/agent/run", "daemon route should match cxlink/agent/run");
        assert.equal(
            daemonAgentBody.streamEvent?.payload?.eventType,
            "agentStatus",
            "daemon response should include agentStatus streamEvent metadata"
        );

        const agentStatus = await agentStatusPromise;

        assert.equal(agentStatus.payload?.eventType, "agentStatus", "WS should emit agentStatus event type");
        assert.equal(agentStatus.payload?.agent, "multi_agent_loop", "WS agentStatus should identify executing agent");
        assert.equal(agentStatus.payload?.dryRun, true, "WS agentStatus should preserve dryRun value");

        activeSocket.close();
        socket = null;

        await new Promise<void>((resolve) => runtime?.close(() => resolve()));
        runtime = null;

        console.log("✅ realistic agents integration flow passed");
    } finally {
        if (socket) {
            try {
                socket.close();
            } catch {
                // no-op during cleanup
            }
        }

        if (runtime) {
            await new Promise<void>((resolve) => runtime?.close(() => resolve()));
        }

        try {
            closeSqlite();
        } catch {
            // no-op when sqlite was not initialized
        }

        for (const candidate of [tempDbPath, `${tempDbPath}-wal`, `${tempDbPath}-shm`]) {
            if (fs.existsSync(candidate)) {
                fs.unlinkSync(candidate);
            }
        }

        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error("❌ realistic agents integration flow failed");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
