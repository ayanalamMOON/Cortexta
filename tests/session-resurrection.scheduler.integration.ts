import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function uniqueProjectId(prefix: string): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${ts}-${rand}`;
}

async function testGraphIndexerReal(modules: {
    upsertMemory: (input: Record<string, unknown>) => Promise<{ createdAt: number }>;
    deleteMemory: (id: string, options?: { projectId?: string; branch?: string }) => Promise<void>;
    indexMemoryGraph: (input: {
        projectId: string;
        branch?: string;
        sinceMs?: number;
        lookbackHours?: number;
        limit?: number;
        snapshotLimit?: number;
    }) => {
        nodesUpserted: number;
        edgesUpserted: number;
        sessionNodes: number;
        temporalNodes: number;
        chatToCodeEdges: number;
        temporalEdges: number;
    };
    connectSqlite: () => {
        prepare: (sql: string) => {
            all: <T = unknown>(...params: unknown[]) => T[];
        };
    };
}): Promise<void> {
    const projectId = uniqueProjectId("session-resurrection-graph");
    const branch = "main";

    await modules.upsertMemory({
        id: "mem.code.auth",
        projectId,
        branch,
        kind: "code_entity",
        sourceType: "code",
        title: "Auth guard function",
        summary: "Core auth guard logic for route protection.",
        content: "export function authGuard(req) { return Boolean(req.user); }",
        tags: ["typescript", "file:src/auth.ts", "code"],
        sourceRef: "src/auth.ts",
        embedding: []
    });

    await modules.upsertMemory({
        id: "mem.chat.active",
        projectId,
        branch,
        kind: "chat_turn",
        sourceType: "chat",
        title: "Copilot Interaction",
        summary: "Discussed auth guard hardening and route checks.",
        content: "How do we harden auth guard?\n\n---\n\nValidate req.user and fallback roles.",
        tags: [
            "copilot",
            "chat",
            "chat-file:.vscode/workspaceStorage/demo/chatSessions/session-1.jsonl",
            "file:src/auth.ts"
        ],
        sourceRef: ".vscode/workspaceStorage/demo/chatSessions/session-1.jsonl",
        embedding: []
    });

    await modules.upsertMemory({
        id: "mem.chat.deleted",
        projectId,
        branch,
        kind: "chat_turn",
        sourceType: "chat",
        title: "Copilot Interaction",
        summary: "Temporary chat row that will be deleted.",
        content: "temporary prompt\n\n---\n\ntemporary response",
        tags: [
            "copilot",
            "chat",
            "chat-file:.vscode/workspaceStorage/demo/chatSessions/session-2.jsonl"
        ],
        sourceRef: ".vscode/workspaceStorage/demo/chatSessions/session-2.jsonl",
        embedding: []
    });

    await modules.deleteMemory("mem.chat.deleted", {
        projectId,
        branch
    });

    const result = modules.indexMemoryGraph({
        projectId,
        branch,
        lookbackHours: 24 * 7,
        limit: 200,
        snapshotLimit: 200
    });

    assert.ok(result.nodesUpserted >= 3, "graph indexer should upsert memory/session/time nodes");
    assert.ok(result.edgesUpserted >= 3, "graph indexer should upsert relationship edges");
    assert.ok(result.sessionNodes >= 1, "graph indexer should produce session nodes");
    assert.ok(result.temporalNodes >= 1, "graph indexer should produce temporal bucket nodes");
    assert.ok(result.chatToCodeEdges >= 1, "graph indexer should connect chat to referenced code memories");
    assert.ok(result.temporalEdges >= 1, "graph indexer should produce temporal edges");

    const db = modules.connectSqlite();
    const nodes = db
        .prepare(
            `
            SELECT id, type, metadata
            FROM graph_nodes
            WHERE projectId = ?
          `
        )
        .all<Array<{ id?: string; type?: string; metadata?: string }>[number]>(projectId);

    const edges = db
        .prepare(
            `
            SELECT id, type, metadata
            FROM graph_edges
            WHERE projectId = ?
          `
        )
        .all<Array<{ id?: string; type?: string; metadata?: string }>[number]>(projectId);

    assert.ok(nodes.some((row) => row.type === "session"), "graph_nodes should include session node records");
    assert.ok(nodes.some((row) => row.type === "concept"), "graph_nodes should include temporal concept nodes");
    assert.ok(edges.some((row) => row.type === "explains"), "graph_edges should include chat->code explains edges");

    const hasDeleteSnapshotEdge = edges.some((row) => {
        try {
            const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : {};
            return metadata?.operation === "delete";
        } catch {
            return false;
        }
    });

    assert.ok(hasDeleteSnapshotEdge, "graph index should include snapshot delete lineage edges for resurrection history");
}

function baseConfig(projectPath: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        enabled: true,
        projectPath,
        projectId: uniqueProjectId("session-resurrection-scheduler"),
        branch: "main",
        intervalMs: 60_000,
        jitterMs: 0,
        runOnStart: false,
        includeChats: true,
        skipUnchanged: true,
        maxChatFiles: 400,
        graphIndexLookbackHours: 24 * 14,
        graphIndexLimit: 5000,
        graphSnapshotLimit: 5000,
        auditLimit: 5000,
        auditMaxIssues: 20,
        backfillLimit: 500,
        applyEnabled: true,
        maxAllowedAnomalies: 0,
        historyLimit: 25,
        persistHistory: false,
        persistedHistoryLimit: 200,
        backoffEnabled: true,
        backoffMultiplier: 2,
        maxBackoffIntervalMs: 6 * 60 * 60 * 1000,
        sloWindowsMinutes: [60, 180],
        ...overrides
    };
}

function ingestionResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        filesScanned: 5,
        codeFilesSkippedUnchanged: 2,
        chatFilesScanned: 1,
        chatFilesSkippedUnchanged: 0,
        codeChunks: 7,
        chatTurns: 3,
        memoriesStored: 10,
        staleMemoriesRemoved: 1,
        staleCodeMemoriesRemoved: 1,
        staleChatMemoriesRemoved: 0,
        skipUnchanged: true,
        ingestVersion: "ingest-v2",
        errors: [],
        ...overrides
    };
}

function graphIndexResult(projectId: string, branch = "main", overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        projectId,
        branch,
        sinceMs: Date.now() - 1000,
        scannedMemories: 12,
        scannedSnapshots: 6,
        nodesUpserted: 18,
        edgesUpserted: 24,
        memoryNodes: 12,
        sessionNodes: 2,
        temporalNodes: 4,
        sessionEdges: 4,
        temporalEdges: 10,
        chatToCodeEdges: 3,
        ...overrides
    };
}

function auditReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        projectId: "session-resurrection",
        scannedRows: 1000,
        compactedRows: 700,
        plainRows: 300,
        validCompactedRows: 700,
        anomalies: {
            invalidChecksum: 0,
            decodeError: 0,
            total: 0
        },
        anomalyRate: 0,
        compactionOpportunityRate: 0.3,
        issueSamples: [],
        recommendations: ["baseline"],
        ...overrides
    };
}

function backfillResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        projectId: "session-resurrection",
        dryRun: true,
        scanned: 1000,
        eligible: 300,
        compacted: 120,
        skipped: 700,
        savedChars: 50_000,
        ...overrides
    };
}

async function testSchedulerRunFlow(modules: {
    createSessionResurrectionScheduler: (config: Record<string, unknown>, services: Record<string, unknown>) => {
        triggerNow: (options?: Record<string, unknown>) => Promise<any>;
        getStatus: () => any;
    };
}, projectPath: string): Promise<void> {
    const projectId = uniqueProjectId("session-resurrection-flow");
    const calls: Array<{ phase: string; dryRun?: boolean; limit?: number }> = [];

    const scheduler = modules.createSessionResurrectionScheduler(
        baseConfig(projectPath, {
            projectId,
            branch: "main",
            applyEnabled: true,
            backfillLimit: 100
        }),
        {
            now: () => new Date(2026, 3, 19, 12, 0, 0, 0).getTime(),
            random: () => 0,
            ingest: async () => {
                calls.push({ phase: "ingest" });
                return ingestionResult() as any;
            },
            indexGraph: () => {
                calls.push({ phase: "index" });
                return graphIndexResult(projectId) as any;
            },
            audit: () => {
                calls.push({ phase: "audit" });
                return auditReport() as any;
            },
            backfill: (options: { dryRun?: boolean; limit?: number }) => {
                calls.push({ phase: "backfill", dryRun: options.dryRun !== false, limit: options.limit });
                if (options.dryRun === false) {
                    return backfillResult({
                        dryRun: false,
                        compacted: 40,
                        savedChars: 22_000
                    }) as any;
                }

                return backfillResult({
                    dryRun: true,
                    compacted: 110,
                    savedChars: 48_000
                }) as any;
            },
            log: () => {
                // mute logs in tests
            }
        }
    );

    const report = await scheduler.triggerNow({
        reason: "integration-run-flow"
    });

    assert.equal(report.trigger, "manual", "manual trigger should be reported");
    assert.equal(report.outcome, "applied", "apply path should run when gates pass");
    assert.equal(calls.filter((call) => call.phase === "ingest").length, 1, "ingest should run exactly once");
    assert.equal(calls.filter((call) => call.phase === "index").length, 1, "graph indexing should run exactly once");
    assert.equal(calls.filter((call) => call.phase === "audit").length, 1, "audit should run exactly once");

    const backfillCalls = calls.filter((call) => call.phase === "backfill");
    assert.equal(backfillCalls.length, 2, "backfill should run dry-run + apply in successful flow");
    assert.equal(backfillCalls[0]?.dryRun, true, "first backfill call should be dry-run");
    assert.equal(backfillCalls[1]?.dryRun, false, "second backfill call should be apply");
    assert.equal(backfillCalls[1]?.limit, 100, "apply call should respect configured backfill limit");

    const status = scheduler.getStatus();
    assert.equal(status.runCount, 1, "run count should increase after manual trigger");
    assert.equal(status.lastRun?.outcome, "applied", "last run outcome should be applied");

    const dryRunOnlyReport = await scheduler.triggerNow({
        reason: "integration-dry-run-only",
        dryRunOnly: true
    });

    assert.equal(dryRunOnlyReport.outcome, "indexed", "dry-run-only mode should skip apply and keep indexed outcome");
    assert.ok(
        dryRunOnlyReport.decision.reasons.some((reason: string) => reason.toLowerCase().includes("dry-run only")),
        "dry-run-only decision reason should be present"
    );
}

async function testBackoffProgression(modules: {
    createSessionResurrectionScheduler: (config: Record<string, unknown>, services: Record<string, unknown>) => {
        start: () => void;
        stop: () => void;
        triggerNow: (options?: Record<string, unknown>) => Promise<any>;
        getStatus: () => any;
    };
}, projectPath: string): Promise<void> {
    let now = new Date(2026, 3, 19, 12, 0, 0, 0).getTime();
    let attempts = 0;

    const scheduler = modules.createSessionResurrectionScheduler(
        baseConfig(projectPath, {
            projectId: uniqueProjectId("session-resurrection-backoff"),
            intervalMs: 1000,
            jitterMs: 0,
            backoffMultiplier: 2,
            maxBackoffIntervalMs: 8000
        }),
        {
            now: () => now,
            random: () => 0,
            ingest: async () => {
                attempts += 1;
                if (attempts <= 3) {
                    throw new Error(`simulated-session-resurrection-failure-${attempts}`);
                }

                return ingestionResult() as any;
            },
            indexGraph: () => graphIndexResult("session-resurrection-backoff") as any,
            audit: () => auditReport() as any,
            backfill: (options: { dryRun?: boolean }) => {
                if (options.dryRun === false) {
                    return backfillResult({
                        dryRun: false,
                        compacted: 8,
                        savedChars: 8_000
                    }) as any;
                }

                return backfillResult({
                    dryRun: true,
                    compacted: 60,
                    savedChars: 12_000
                }) as any;
            },
            log: () => {
                // mute logs in tests
            }
        }
    );

    scheduler.start();
    assert.equal(
        scheduler.getStatus().lastScheduledDelayMs,
        1000,
        "initial schedule should use baseline interval without failures"
    );
    scheduler.stop();

    await scheduler.triggerNow({ reason: "backoff-1" });
    assert.equal(scheduler.getStatus().consecutiveFailures, 1, "first failure should increment failure streak");
    scheduler.start();
    assert.equal(
        scheduler.getStatus().lastScheduledDelayMs,
        1000,
        "first failure keeps baseline before exponential growth"
    );
    scheduler.stop();

    now += 1000;
    await scheduler.triggerNow({ reason: "backoff-2" });
    assert.equal(scheduler.getStatus().consecutiveFailures, 2, "second failure should increment failure streak");
    scheduler.start();
    assert.equal(
        scheduler.getStatus().lastScheduledDelayMs,
        2000,
        "second consecutive failure should double schedule delay"
    );
    scheduler.stop();

    now += 1000;
    await scheduler.triggerNow({ reason: "backoff-3" });
    assert.equal(scheduler.getStatus().consecutiveFailures, 3, "third failure should increment failure streak");
    scheduler.start();
    assert.equal(
        scheduler.getStatus().lastScheduledDelayMs,
        4000,
        "third consecutive failure should continue exponential backoff"
    );
    scheduler.stop();

    now += 1000;
    await scheduler.triggerNow({ reason: "backoff-recovery" });
    assert.equal(scheduler.getStatus().consecutiveFailures, 0, "successful run should reset failure streak");
    scheduler.start();
    assert.equal(
        scheduler.getStatus().lastScheduledDelayMs,
        1000,
        "post-recovery schedule should return to baseline interval"
    );
    scheduler.stop();
}

async function testPersistedHistoryHydration(modules: {
    createSessionResurrectionScheduler: (config: Record<string, unknown>, services: Record<string, unknown>) => {
        triggerNow: (options?: Record<string, unknown>) => Promise<any>;
        getStatus: () => any;
    };
}, projectPath: string): Promise<void> {
    const projectId = uniqueProjectId("session-resurrection-persist");
    let now = new Date(2026, 3, 19, 12, 0, 0, 0).getTime();

    const config = baseConfig(projectPath, {
        projectId,
        persistHistory: true,
        historyLimit: 10,
        persistedHistoryLimit: 30
    });

    const services = {
        now: () => now,
        random: () => 0,
        ingest: async () => ingestionResult() as any,
        indexGraph: () => graphIndexResult(projectId) as any,
        audit: () => auditReport({ projectId }) as any,
        backfill: (options: { dryRun?: boolean }) => {
            if (options.dryRun === false) {
                return backfillResult({
                    projectId,
                    dryRun: false,
                    compacted: 16,
                    savedChars: 11_000
                }) as any;
            }

            return backfillResult({
                projectId,
                dryRun: true,
                compacted: 32,
                savedChars: 18_000
            }) as any;
        },
        log: () => {
            // mute logs in tests
        }
    };

    const schedulerA = modules.createSessionResurrectionScheduler(config, services);
    const firstRun = await schedulerA.triggerNow({ reason: "persisted-history-1" });
    now += 1000;
    const secondRun = await schedulerA.triggerNow({
        reason: "persisted-history-2",
        dryRunOnly: true
    });

    const statusA = schedulerA.getStatus();
    assert.equal(statusA.runCount, 2, "first scheduler instance should record two runs");
    assert.equal(statusA.lastRun?.runId, secondRun.runId, "first scheduler should keep newest run as lastRun");

    const schedulerB = modules.createSessionResurrectionScheduler(config, services);
    const statusB = schedulerB.getStatus();

    assert.equal(statusB.runCount, 2, "second scheduler instance should hydrate persisted run count");
    assert.equal(statusB.lastRun?.runId, secondRun.runId, "second scheduler should hydrate latest persisted run");
    assert.ok(
        statusB.recentRuns.some((run: { runId?: string }) => run.runId === firstRun.runId),
        "second scheduler should hydrate first persisted run"
    );
    assert.ok(
        statusB.recentRuns.some((run: { runId?: string }) => run.runId === secondRun.runId),
        "second scheduler should hydrate second persisted run"
    );
}

async function main(): Promise<void> {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortexa-session-resurrection-"));
    const tempDbPath = path.join(tempRoot, "session-resurrection.db");
    const projectPath = path.join(tempRoot, "project");

    process.env.CORTEXA_DB_PATH = tempDbPath;
    process.env.CORTEXA_VECTOR_PROVIDER = "memory";

    fs.mkdirSync(projectPath, { recursive: true });
    fs.writeFileSync(
        path.join(projectPath, "sample.ts"),
        [
            "export function sessionResurrectionSample(value: number): number {",
            "  return value + 1;",
            "}",
            "",
            "export const marker = 'session-resurrection';"
        ].join("\n"),
        "utf8"
    );

    const {
        upsertMemory,
        deleteMemory,
        closeSqlite,
        connectSqlite
    } = require("../core/mempalace/memory.service") as {
        upsertMemory: (input: Record<string, unknown>) => Promise<{ createdAt: number }>;
        deleteMemory: (id: string, options?: { projectId?: string; branch?: string }) => Promise<void>;
        closeSqlite?: () => void;
        connectSqlite?: () => unknown;
    };

    const dbModule = require("../storage/sqlite/db") as {
        closeSqlite: () => void;
        connectSqlite: () => {
            prepare: (sql: string) => {
                all: <T = unknown>(...params: unknown[]) => T[];
            };
        };
    };

    const { indexMemoryGraph } = require("../core/graph/memory.graph.indexer") as {
        indexMemoryGraph: (input: {
            projectId: string;
            branch?: string;
            sinceMs?: number;
            lookbackHours?: number;
            limit?: number;
            snapshotLimit?: number;
        }) => {
            nodesUpserted: number;
            edgesUpserted: number;
            sessionNodes: number;
            temporalNodes: number;
            chatToCodeEdges: number;
            temporalEdges: number;
        };
    };

    const {
        createSessionResurrectionScheduler
    } = require("../apps/daemon/src/session-resurrection/scheduler") as {
        createSessionResurrectionScheduler: (
            config: Record<string, unknown>,
            services: Record<string, unknown>
        ) => {
            start: () => void;
            stop: () => void;
            triggerNow: (options?: Record<string, unknown>) => Promise<any>;
            getStatus: () => any;
        };
    };

    try {
        await testGraphIndexerReal({
            upsertMemory,
            deleteMemory,
            indexMemoryGraph,
            connectSqlite: dbModule.connectSqlite
        });

        await testSchedulerRunFlow({ createSessionResurrectionScheduler }, projectPath);
        await testBackoffProgression({ createSessionResurrectionScheduler }, projectPath);
        await testPersistedHistoryHydration({ createSessionResurrectionScheduler }, projectPath);

        console.log("✅ session-resurrection scheduler integration tests passed");
    } finally {
        dbModule.closeSqlite();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error("❌ session-resurrection scheduler integration tests failed");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
