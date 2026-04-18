import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";

type DaemonFactory = () => any;
type DaemonRuntime = {
    server: { address: () => AddressInfo | string | null; close: (cb?: () => void) => void };
    wss?: { address?: () => AddressInfo | string | null } | null;
    close: (cb?: () => void) => void;
};
type DaemonStarter = (port?: number, wsPort?: number) => DaemonRuntime;

const TOKEN = "integration-token";

async function withServer(name: string, factory: DaemonFactory, run: (baseUrl: string) => Promise<void>): Promise<void> {
    const app = factory();
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address() as AddressInfo | null;
    if (!address?.port) {
        throw new Error(`[${name}] Failed to bind ephemeral port`);
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
        await run(baseUrl);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

async function withRuntime(name: string, start: DaemonStarter, run: (baseUrl: string, wsUrl: string) => Promise<void>): Promise<void> {
    const runtime = start(0, 0);
    await once(runtime.server as any, "listening");

    const httpAddress = runtime.server.address() as AddressInfo | null;
    if (!httpAddress?.port) {
        throw new Error(`[${name}] Failed to resolve daemon HTTP port`);
    }

    const wsAddress = runtime.wss?.address?.() as AddressInfo | null;
    if (!wsAddress?.port) {
        throw new Error(`[${name}] Failed to resolve daemon WebSocket port`);
    }

    const baseUrl = `http://127.0.0.1:${httpAddress.port}`;
    const wsUrl = `ws://127.0.0.1:${wsAddress.port}`;

    try {
        await run(baseUrl, wsUrl);
    } finally {
        await new Promise<void>((resolve) => runtime.close(() => resolve()));
    }
}

async function postJson(baseUrl: string, route: string, body: unknown, token?: string): Promise<Response> {
    const headers: Record<string, string> = {
        "content-type": "application/json"
    };
    if (token) {
        headers["x-cortexa-token"] = token;
    }

    return fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
    });
}

async function expectStatus(response: Response, expected: number, context: string): Promise<void> {
    if (response.status === expected) {
        return;
    }

    const text = await response.text();
    throw new Error(`${context} expected status ${expected}, got ${response.status}. body=${text}`);
}

async function runContract(name: string, factory: DaemonFactory): Promise<void> {
    await withServer(name, factory, async (baseUrl) => {
        const health = await fetch(`${baseUrl}/health`);
        await expectStatus(health, 200, `[${name}] /health`);
        const healthBody = (await health.json()) as { ok?: boolean; service?: string };
        assert.equal(healthBody.ok, true, `[${name}] /health ok`);
        assert.equal(healthBody.service, "cortexa-daemon", `[${name}] /health service`);

        const unauthorizedQuery = await postJson(baseUrl, "/query", { query: "hello" });
        await expectStatus(unauthorizedQuery, 401, `[${name}] auth gate /query`);

        const missingQuery = await postJson(baseUrl, "/query", {}, TOKEN);
        await expectStatus(missingQuery, 400, `[${name}] /query missing query`);

        const missingContextQuery = await postJson(baseUrl, "/context", {}, TOKEN);
        await expectStatus(missingContextQuery, 400, `[${name}] /context missing query`);

        const missingIngestPath = await postJson(baseUrl, "/ingest", {}, TOKEN);
        await expectStatus(missingIngestPath, 400, `[${name}] /ingest missing path`);

        const cxContextMissingQuery = await postJson(baseUrl, "/cxlink/context", {}, TOKEN);
        await expectStatus(cxContextMissingQuery, 400, `[${name}] /cxlink/context missing query`);

        const cxQueryMissingQuery = await postJson(baseUrl, "/cxlink/query", {}, TOKEN);
        await expectStatus(cxQueryMissingQuery, 400, `[${name}] /cxlink/query missing query`);

        const cxPlanMissingQuery = await postJson(baseUrl, "/cxlink/plan", {}, TOKEN);
        await expectStatus(cxPlanMissingQuery, 400, `[${name}] /cxlink/plan missing query`);

        const evolveDryRun = await postJson(baseUrl, "/evolve", { dryRun: true, limit: 10 }, TOKEN);
        await expectStatus(evolveDryRun, 200, `[${name}] /evolve dryRun`);
        const evolveBody = (await evolveDryRun.json()) as { ok?: boolean; route?: string; dryRun?: boolean };
        assert.equal(evolveBody.ok, true, `[${name}] /evolve ok`);
        assert.equal(evolveBody.route, "evolve", `[${name}] /evolve route`);
        assert.equal(evolveBody.dryRun, true, `[${name}] /evolve dryRun flag`);

        const queryResponse = await postJson(baseUrl, "/query", { query: "cortexa daemon integration" }, TOKEN);
        await expectStatus(queryResponse, 200, `[${name}] /query success`);
        const queryBody = (await queryResponse.json()) as { ok?: boolean; route?: string; results?: unknown[] };
        assert.equal(queryBody.ok, true, `[${name}] /query ok`);
        assert.equal(queryBody.route, "query", `[${name}] /query route`);
        assert.ok(Array.isArray(queryBody.results), `[${name}] /query results array`);

        const cxlinkContextResponse = await postJson(
            baseUrl,
            "/cxlink/context",
            { query: "integration check", topK: 5, minScore: 0 },
            TOKEN
        );
        await expectStatus(cxlinkContextResponse, 200, `[${name}] /cxlink/context success`);
        const cxlinkContextBody = (await cxlinkContextResponse.json()) as {
            ok?: boolean;
            route?: string;
            context?: string;
            cxf?: string;
        };
        assert.equal(cxlinkContextBody.ok, true, `[${name}] /cxlink/context ok`);
        assert.equal(cxlinkContextBody.route, "cxlink/context", `[${name}] /cxlink/context route`);
        assert.equal(typeof cxlinkContextBody.context, "string", `[${name}] /cxlink/context context type`);
        assert.equal(typeof cxlinkContextBody.cxf, "string", `[${name}] /cxlink/context cxf type`);

        const cxlinkPlanResponse = await postJson(
            baseUrl,
            "/cxlink/plan",
            { query: "integration planning check", topK: 5, minScore: 0 },
            TOKEN
        );
        await expectStatus(cxlinkPlanResponse, 200, `[${name}] /cxlink/plan success`);
        const cxlinkPlanBody = (await cxlinkPlanResponse.json()) as { ok?: boolean; route?: string; steps?: unknown[] };
        assert.equal(cxlinkPlanBody.ok, true, `[${name}] /cxlink/plan ok`);
        assert.equal(cxlinkPlanBody.route, "cxlink/plan", `[${name}] /cxlink/plan route`);
        assert.ok(Array.isArray(cxlinkPlanBody.steps), `[${name}] /cxlink/plan steps array`);
        assert.ok((cxlinkPlanBody.steps?.length ?? 0) >= 4, `[${name}] /cxlink/plan minimum steps`);

        const compactionStatsResponse = await postJson(baseUrl, "/cxlink/compaction/stats", {}, TOKEN);
        await expectStatus(compactionStatsResponse, 200, `[${name}] /cxlink/compaction/stats success`);
        const compactionStatsBody = (await compactionStatsResponse.json()) as {
            ok?: boolean;
            route?: string;
            stats?: { totalRows?: number; compactedRows?: number; plainRows?: number };
        };
        assert.equal(compactionStatsBody.ok, true, `[${name}] /cxlink/compaction/stats ok`);
        assert.equal(compactionStatsBody.route, "cxlink/compaction/stats", `[${name}] /cxlink/compaction/stats route`);
        assert.equal(typeof compactionStatsBody.stats?.totalRows, "number", `[${name}] /cxlink/compaction/stats totalRows`);
        assert.equal(
            typeof compactionStatsBody.stats?.compactedRows,
            "number",
            `[${name}] /cxlink/compaction/stats compactedRows`
        );
        assert.equal(typeof compactionStatsBody.stats?.plainRows, "number", `[${name}] /cxlink/compaction/stats plainRows`);

        const compactionBackfillResponse = await postJson(
            baseUrl,
            "/cxlink/compaction/backfill",
            { dryRun: true, limit: 50 },
            TOKEN
        );
        await expectStatus(compactionBackfillResponse, 200, `[${name}] /cxlink/compaction/backfill success`);
        const compactionBackfillBody = (await compactionBackfillResponse.json()) as {
            ok?: boolean;
            route?: string;
            result?: { dryRun?: boolean; scanned?: number; eligible?: number; compacted?: number; skipped?: number };
        };
        assert.equal(compactionBackfillBody.ok, true, `[${name}] /cxlink/compaction/backfill ok`);
        assert.equal(
            compactionBackfillBody.route,
            "cxlink/compaction/backfill",
            `[${name}] /cxlink/compaction/backfill route`
        );
        assert.equal(compactionBackfillBody.result?.dryRun, true, `[${name}] /cxlink/compaction/backfill dryRun`);
        assert.equal(
            typeof compactionBackfillBody.result?.scanned,
            "number",
            `[${name}] /cxlink/compaction/backfill scanned`
        );

        const compactionDashboardResponse = await postJson(
            baseUrl,
            "/cxlink/compaction/dashboard",
            {
                lookbackDays: 30,
                maxTrendPoints: 40,
                maxProjects: 20,
                persistSnapshot: true,
                perProjectSnapshotLimit: 10,
                snapshotRetentionDays: 120
            },
            TOKEN
        );
        await expectStatus(compactionDashboardResponse, 200, `[${name}] /cxlink/compaction/dashboard success`);
        const compactionDashboardBody = (await compactionDashboardResponse.json()) as {
            ok?: boolean;
            route?: string;
            dashboard?: {
                generatedAt?: number;
                current?: { totalRows?: number; compactedRows?: number; plainRows?: number };
                trend?: { global?: unknown[]; scopedProject?: unknown[] };
                perProject?: unknown[];
                integrityAnomalies?: { invalidChecksum?: number; decodeError?: number; total?: number };
                totals?: { projectCount?: number; projectsWithAnomalies?: number; projectsMostlyCompacted?: number };
            };
        };
        assert.equal(compactionDashboardBody.ok, true, `[${name}] /cxlink/compaction/dashboard ok`);
        assert.equal(
            compactionDashboardBody.route,
            "cxlink/compaction/dashboard",
            `[${name}] /cxlink/compaction/dashboard route`
        );
        assert.equal(
            typeof compactionDashboardBody.dashboard?.generatedAt,
            "number",
            `[${name}] /cxlink/compaction/dashboard generatedAt`
        );
        assert.equal(
            typeof compactionDashboardBody.dashboard?.current?.totalRows,
            "number",
            `[${name}] /cxlink/compaction/dashboard current.totalRows`
        );
        assert.ok(
            Array.isArray(compactionDashboardBody.dashboard?.trend?.global),
            `[${name}] /cxlink/compaction/dashboard trend.global array`
        );
        assert.ok(
            Array.isArray(compactionDashboardBody.dashboard?.perProject),
            `[${name}] /cxlink/compaction/dashboard perProject array`
        );
        assert.equal(
            typeof compactionDashboardBody.dashboard?.integrityAnomalies?.total,
            "number",
            `[${name}] /cxlink/compaction/dashboard integrityAnomalies.total`
        );
        assert.equal(
            typeof compactionDashboardBody.dashboard?.totals?.projectCount,
            "number",
            `[${name}] /cxlink/compaction/dashboard totals.projectCount`
        );
    });
}

async function waitForBootstrap(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error(`Timed out waiting for bootstrap stream delta from ${url}`));
        }, 8000);

        socket.on("error", (error: Error) => {
            clearTimeout(timeout);
            reject(error);
        });

        socket.on("message", (raw: unknown) => {
            try {
                const payloadText =
                    typeof raw === "string"
                        ? raw
                        : Buffer.isBuffer(raw)
                            ? raw.toString("utf8")
                            : String(raw);
                const payload = JSON.parse(payloadText);
                if (payload?.sessionId === "bootstrap") {
                    clearTimeout(timeout);
                    socket.close();
                    resolve(payload);
                }
            } catch {
                // Ignore malformed messages in test harness.
            }
        });
    });
}

async function runRuntimeContract(name: string, start: DaemonStarter): Promise<void> {
    await withRuntime(name, start, async (baseUrl, wsUrl) => {
        const health = await fetch(`${baseUrl}/health`);
        await expectStatus(health, 200, `[${name}] runtime /health`);

        const bootstrap = await waitForBootstrap(wsUrl);
        assert.equal(bootstrap.sessionId, "bootstrap", `[${name}] stream bootstrap session`);
        assert.equal(bootstrap.deltaType, "snapshot", `[${name}] stream bootstrap type`);
        assert.equal(typeof bootstrap.checksum, "string", `[${name}] stream bootstrap checksum`);
    });
}

async function main(): Promise<void> {
    process.env.CORTEXA_DAEMON_TOKEN = TOKEN;
    process.env.CORTEXA_DAEMON_AUTOSTART = "0";

    const legacyModule = require("../daemon/server") as { createDaemonApp: DaemonFactory; startDaemon: DaemonStarter };
    const appsModule = require("../apps/daemon/src/server") as { createDaemonApp: DaemonFactory; startDaemon: DaemonStarter };

    await runContract("legacy-daemon-entry", legacyModule.createDaemonApp);
    await runContract("apps-daemon-entry", appsModule.createDaemonApp);
    await runRuntimeContract("legacy-daemon-runtime", legacyModule.startDaemon);
    await runRuntimeContract("apps-daemon-runtime", appsModule.startDaemon);

    console.log("✅ daemon integration tests passed for both daemon entrypoints");
}

main().catch((error) => {
    console.error("❌ daemon integration test failed");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
