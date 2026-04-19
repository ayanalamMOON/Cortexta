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
        const healthBody = (await health.json()) as {
            ok?: boolean;
            service?: string;
            selfHealing?: {
                enabled?: boolean;
                started?: boolean;
                running?: boolean;
                nextRunAt?: number;
                lastScheduledDelayMs?: number;
                consecutiveFailures?: number;
                lastOutcome?: string;
                runCount?: number;
                slo?: {
                    generatedAt?: number;
                    windows?: unknown[];
                };
            };
        };
        assert.equal(healthBody.ok, true, `[${name}] /health ok`);
        assert.equal(healthBody.service, "cortexa-daemon", `[${name}] /health service`);
        assert.equal(typeof healthBody.selfHealing?.enabled, "boolean", `[${name}] /health selfHealing.enabled`);
        assert.equal(typeof healthBody.selfHealing?.started, "boolean", `[${name}] /health selfHealing.started`);
        assert.equal(typeof healthBody.selfHealing?.running, "boolean", `[${name}] /health selfHealing.running`);
        assert.equal(typeof healthBody.selfHealing?.runCount, "number", `[${name}] /health selfHealing.runCount`);
        assert.equal(
            typeof healthBody.selfHealing?.consecutiveFailures,
            "number",
            `[${name}] /health selfHealing.consecutiveFailures`
        );
        assert.equal(
            typeof healthBody.selfHealing?.slo?.generatedAt,
            "number",
            `[${name}] /health selfHealing.slo.generatedAt`
        );
        assert.ok(Array.isArray(healthBody.selfHealing?.slo?.windows), `[${name}] /health selfHealing.slo.windows`);

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
        const evolveBody = (await evolveDryRun.json()) as { ok?: boolean; route?: string; mode?: string; dryRun?: boolean };
        assert.equal(evolveBody.ok, true, `[${name}] /evolve ok`);
        assert.equal(evolveBody.route, "evolve", `[${name}] /evolve route`);
        assert.equal(evolveBody.mode, "consolidate", `[${name}] /evolve mode consolidate`);
        assert.equal(evolveBody.dryRun, true, `[${name}] /evolve dryRun flag`);

        const evolveProgression = await postJson(
            baseUrl,
            "/evolve",
            {
                projectId: "daemon-evolve-integration",
                text: "upgrade evolution progression telemetry in daemon mode",
                context: "integration-check",
                dryRun: true
            },
            TOKEN
        );
        await expectStatus(evolveProgression, 200, `[${name}] /evolve progression`);
        const evolveProgressionBody = (await evolveProgression.json()) as {
            ok?: boolean;
            route?: string;
            mode?: string;
            projectId?: string;
            dryRun?: boolean;
            stored?: boolean;
            persisted?: boolean;
            action?: string;
            reason?: string;
            atomId?: string;
            progression?: {
                proposedCandidates?: number;
                reviewedCandidates?: number;
                selectedCandidateIndex?: number;
                selectedScore?: number;
                merged?: boolean;
                neighborCount?: number;
                promoted?: boolean;
                archived?: boolean;
                stages?: unknown[];
            };
        };
        assert.equal(evolveProgressionBody.ok, true, `[${name}] /evolve progression ok`);
        assert.equal(evolveProgressionBody.route, "evolve", `[${name}] /evolve progression route`);
        assert.equal(evolveProgressionBody.mode, "progression", `[${name}] /evolve progression mode`);
        assert.equal(evolveProgressionBody.projectId, "daemon-evolve-integration", `[${name}] /evolve progression projectId`);
        assert.equal(evolveProgressionBody.dryRun, true, `[${name}] /evolve progression dryRun`);
        assert.equal(typeof evolveProgressionBody.stored, "boolean", `[${name}] /evolve progression stored`);
        assert.equal(typeof evolveProgressionBody.persisted, "boolean", `[${name}] /evolve progression persisted`);
        assert.equal(evolveProgressionBody.persisted, false, `[${name}] /evolve progression persisted dry-run`);
        assert.equal(typeof evolveProgressionBody.action, "string", `[${name}] /evolve progression action`);
        assert.equal(typeof evolveProgressionBody.reason, "string", `[${name}] /evolve progression reason`);
        assert.equal(
            typeof evolveProgressionBody.progression?.proposedCandidates,
            "number",
            `[${name}] /evolve progression proposedCandidates`
        );
        assert.equal(
            typeof evolveProgressionBody.progression?.reviewedCandidates,
            "number",
            `[${name}] /evolve progression reviewedCandidates`
        );
        assert.equal(
            typeof evolveProgressionBody.progression?.neighborCount,
            "number",
            `[${name}] /evolve progression neighborCount`
        );
        assert.equal(
            typeof evolveProgressionBody.progression?.promoted,
            "boolean",
            `[${name}] /evolve progression promoted`
        );
        assert.equal(
            typeof evolveProgressionBody.progression?.archived,
            "boolean",
            `[${name}] /evolve progression archived`
        );
        assert.ok(
            Array.isArray(evolveProgressionBody.progression?.stages),
            `[${name}] /evolve progression stages array`
        );

        const evolveProgressionAliasMissingText = await postJson(
            baseUrl,
            "/evolve/progression",
            {
                projectId: "daemon-evolve-integration",
                dryRun: true
            },
            TOKEN
        );
        await expectStatus(evolveProgressionAliasMissingText, 400, `[${name}] /evolve/progression missing text`);
        const evolveProgressionAliasMissingTextBody = (await evolveProgressionAliasMissingText.json()) as {
            ok?: boolean;
            error?: string;
        };
        assert.equal(evolveProgressionAliasMissingTextBody.ok, false, `[${name}] /evolve/progression missing text ok`);
        assert.equal(
            evolveProgressionAliasMissingTextBody.error,
            "Missing required field: text",
            `[${name}] /evolve/progression missing text error`
        );

        const evolveProgressionAlias = await postJson(
            baseUrl,
            "/evolve/progression",
            {
                projectId: "daemon-evolve-alias",
                text: "strict alias progression telemetry check",
                context: "integration-check",
                dryRun: true
            },
            TOKEN
        );
        await expectStatus(evolveProgressionAlias, 200, `[${name}] /evolve/progression success`);
        const evolveProgressionAliasBody = (await evolveProgressionAlias.json()) as {
            ok?: boolean;
            route?: string;
            mode?: string;
            projectId?: string;
            dryRun?: boolean;
            stored?: boolean;
            persisted?: boolean;
            action?: string;
            reason?: string;
            atomId?: string;
            progression?: {
                proposedCandidates?: number;
                reviewedCandidates?: number;
                selectedCandidateIndex?: number;
                selectedScore?: number;
                merged?: boolean;
                neighborCount?: number;
                promoted?: boolean;
                archived?: boolean;
                stages?: unknown[];
            };
        };
        assert.equal(evolveProgressionAliasBody.ok, true, `[${name}] /evolve/progression ok`);
        assert.equal(evolveProgressionAliasBody.route, "evolve/progression", `[${name}] /evolve/progression route`);
        assert.equal(evolveProgressionAliasBody.mode, "progression", `[${name}] /evolve/progression mode`);
        assert.equal(evolveProgressionAliasBody.projectId, "daemon-evolve-alias", `[${name}] /evolve/progression projectId`);
        assert.equal(evolveProgressionAliasBody.dryRun, true, `[${name}] /evolve/progression dryRun`);
        assert.equal(typeof evolveProgressionAliasBody.stored, "boolean", `[${name}] /evolve/progression stored`);
        assert.equal(typeof evolveProgressionAliasBody.persisted, "boolean", `[${name}] /evolve/progression persisted`);
        assert.equal(evolveProgressionAliasBody.persisted, false, `[${name}] /evolve/progression persisted dry-run`);
        assert.equal(typeof evolveProgressionAliasBody.action, "string", `[${name}] /evolve/progression action`);
        assert.equal(typeof evolveProgressionAliasBody.reason, "string", `[${name}] /evolve/progression reason`);
        assert.equal(
            typeof evolveProgressionAliasBody.progression?.proposedCandidates,
            "number",
            `[${name}] /evolve/progression proposedCandidates`
        );
        assert.equal(
            typeof evolveProgressionAliasBody.progression?.reviewedCandidates,
            "number",
            `[${name}] /evolve/progression reviewedCandidates`
        );
        assert.equal(
            typeof evolveProgressionAliasBody.progression?.neighborCount,
            "number",
            `[${name}] /evolve/progression neighborCount`
        );
        assert.equal(
            typeof evolveProgressionAliasBody.progression?.promoted,
            "boolean",
            `[${name}] /evolve/progression promoted`
        );
        assert.equal(
            typeof evolveProgressionAliasBody.progression?.archived,
            "boolean",
            `[${name}] /evolve/progression archived`
        );
        assert.ok(
            Array.isArray(evolveProgressionAliasBody.progression?.stages),
            `[${name}] /evolve/progression stages array`
        );

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
            memoryHealth?: { status?: string; anomalyTotal?: number };
            context?: string;
            cxf?: string;
        };
        assert.equal(cxlinkContextBody.ok, true, `[${name}] /cxlink/context ok`);
        assert.equal(cxlinkContextBody.route, "cxlink/context", `[${name}] /cxlink/context route`);
        assert.equal(typeof cxlinkContextBody.memoryHealth?.status, "string", `[${name}] /cxlink/context memoryHealth.status`);
        assert.equal(
            typeof cxlinkContextBody.memoryHealth?.anomalyTotal,
            "number",
            `[${name}] /cxlink/context memoryHealth.anomalyTotal`
        );
        assert.equal(typeof cxlinkContextBody.context, "string", `[${name}] /cxlink/context context type`);
        assert.equal(typeof cxlinkContextBody.cxf, "string", `[${name}] /cxlink/context cxf type`);

        const cxlinkQueryResponse = await postJson(
            baseUrl,
            "/cxlink/query",
            { query: "integration memory health check", topK: 5, minScore: 0 },
            TOKEN
        );
        await expectStatus(cxlinkQueryResponse, 200, `[${name}] /cxlink/query success`);
        const cxlinkQueryBody = (await cxlinkQueryResponse.json()) as {
            ok?: boolean;
            route?: string;
            memoryHealth?: { status?: string; anomalyTotal?: number };
            results?: unknown[];
        };
        assert.equal(cxlinkQueryBody.ok, true, `[${name}] /cxlink/query ok`);
        assert.equal(cxlinkQueryBody.route, "cxlink/query", `[${name}] /cxlink/query route`);
        assert.equal(typeof cxlinkQueryBody.memoryHealth?.status, "string", `[${name}] /cxlink/query memoryHealth.status`);
        assert.equal(
            typeof cxlinkQueryBody.memoryHealth?.anomalyTotal,
            "number",
            `[${name}] /cxlink/query memoryHealth.anomalyTotal`
        );
        assert.ok(Array.isArray(cxlinkQueryBody.results), `[${name}] /cxlink/query results array`);

        const cxlinkPlanResponse = await postJson(
            baseUrl,
            "/cxlink/plan",
            { query: "integration planning check", topK: 5, minScore: 0 },
            TOKEN
        );
        await expectStatus(cxlinkPlanResponse, 200, `[${name}] /cxlink/plan success`);
        const cxlinkPlanBody = (await cxlinkPlanResponse.json()) as {
            ok?: boolean;
            route?: string;
            memoryHealth?: { status?: string; anomalyTotal?: number };
            steps?: unknown[];
        };
        assert.equal(cxlinkPlanBody.ok, true, `[${name}] /cxlink/plan ok`);
        assert.equal(cxlinkPlanBody.route, "cxlink/plan", `[${name}] /cxlink/plan route`);
        assert.equal(typeof cxlinkPlanBody.memoryHealth?.status, "string", `[${name}] /cxlink/plan memoryHealth.status`);
        assert.equal(
            typeof cxlinkPlanBody.memoryHealth?.anomalyTotal,
            "number",
            `[${name}] /cxlink/plan memoryHealth.anomalyTotal`
        );
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

        const compactionAuditResponse = await postJson(
            baseUrl,
            "/cxlink/compaction/audit",
            { limit: 100, maxIssues: 5 },
            TOKEN
        );
        await expectStatus(compactionAuditResponse, 200, `[${name}] /cxlink/compaction/audit success`);
        const compactionAuditBody = (await compactionAuditResponse.json()) as {
            ok?: boolean;
            route?: string;
            report?: {
                scannedRows?: number;
                anomalies?: { total?: number; invalidChecksum?: number; decodeError?: number };
                issueSamples?: unknown[];
                recommendations?: string[];
            };
        };
        assert.equal(compactionAuditBody.ok, true, `[${name}] /cxlink/compaction/audit ok`);
        assert.equal(compactionAuditBody.route, "cxlink/compaction/audit", `[${name}] /cxlink/compaction/audit route`);
        assert.equal(
            typeof compactionAuditBody.report?.scannedRows,
            "number",
            `[${name}] /cxlink/compaction/audit scannedRows`
        );
        assert.equal(
            typeof compactionAuditBody.report?.anomalies?.total,
            "number",
            `[${name}] /cxlink/compaction/audit anomalies.total`
        );
        assert.ok(
            Array.isArray(compactionAuditBody.report?.issueSamples),
            `[${name}] /cxlink/compaction/audit issueSamples array`
        );
        assert.ok(
            Array.isArray(compactionAuditBody.report?.recommendations),
            `[${name}] /cxlink/compaction/audit recommendations array`
        );

        const selfHealStatusResponse = await postJson(baseUrl, "/cxlink/compaction/self-heal/status", {}, TOKEN);
        await expectStatus(selfHealStatusResponse, 200, `[${name}] /cxlink/compaction/self-heal/status success`);
        const selfHealStatusBody = (await selfHealStatusResponse.json()) as {
            ok?: boolean;
            route?: string;
            status?: {
                enabled?: boolean;
                started?: boolean;
                running?: boolean;
                runCount?: number;
                consecutiveFailures?: number;
                lastScheduledDelayMs?: number;
                config?: { applyEnabled?: boolean };
                recentRuns?: unknown[];
                slo?: {
                    generatedAt?: number;
                    windows?: unknown[];
                };
            };
        };
        assert.equal(selfHealStatusBody.ok, true, `[${name}] /cxlink/compaction/self-heal/status ok`);
        assert.equal(
            selfHealStatusBody.route,
            "cxlink/compaction/self-heal/status",
            `[${name}] /cxlink/compaction/self-heal/status route`
        );
        assert.equal(
            typeof selfHealStatusBody.status?.enabled,
            "boolean",
            `[${name}] /cxlink/compaction/self-heal/status enabled`
        );
        assert.equal(
            typeof selfHealStatusBody.status?.runCount,
            "number",
            `[${name}] /cxlink/compaction/self-heal/status runCount`
        );
        assert.equal(
            typeof selfHealStatusBody.status?.consecutiveFailures,
            "number",
            `[${name}] /cxlink/compaction/self-heal/status consecutiveFailures`
        );
        assert.ok(
            Array.isArray(selfHealStatusBody.status?.recentRuns),
            `[${name}] /cxlink/compaction/self-heal/status recentRuns`
        );
        assert.equal(
            typeof selfHealStatusBody.status?.slo?.generatedAt,
            "number",
            `[${name}] /cxlink/compaction/self-heal/status slo.generatedAt`
        );
        assert.ok(
            Array.isArray(selfHealStatusBody.status?.slo?.windows),
            `[${name}] /cxlink/compaction/self-heal/status slo.windows`
        );

        const selfHealTriggerResponse = await postJson(
            baseUrl,
            "/cxlink/compaction/self-heal/trigger",
            {
                reason: "integration-test",
                dryRunOnly: true
            },
            TOKEN
        );
        await expectStatus(selfHealTriggerResponse, 200, `[${name}] /cxlink/compaction/self-heal/trigger success`);
        const selfHealTriggerBody = (await selfHealTriggerResponse.json()) as {
            ok?: boolean;
            route?: string;
            report?: {
                trigger?: string;
                outcome?: string;
                dryRunOnly?: boolean;
                audit?: { scannedRows?: number };
                dryRunBackfill?: { scanned?: number };
                decision?: { reasons?: string[] };
            };
            status?: {
                runCount?: number;
                lastRun?: { outcome?: string; trigger?: string };
                consecutiveFailures?: number;
                slo?: { windows?: unknown[] };
            };
        };
        assert.equal(selfHealTriggerBody.ok, true, `[${name}] /cxlink/compaction/self-heal/trigger ok`);
        assert.equal(
            selfHealTriggerBody.route,
            "cxlink/compaction/self-heal/trigger",
            `[${name}] /cxlink/compaction/self-heal/trigger route`
        );
        assert.equal(
            selfHealTriggerBody.report?.trigger,
            "manual",
            `[${name}] /cxlink/compaction/self-heal/trigger report.trigger`
        );
        assert.equal(
            selfHealTriggerBody.report?.dryRunOnly,
            true,
            `[${name}] /cxlink/compaction/self-heal/trigger report.dryRunOnly`
        );
        assert.equal(
            typeof selfHealTriggerBody.report?.outcome,
            "string",
            `[${name}] /cxlink/compaction/self-heal/trigger report.outcome`
        );
        assert.equal(
            typeof selfHealTriggerBody.report?.audit?.scannedRows,
            "number",
            `[${name}] /cxlink/compaction/self-heal/trigger report.audit.scannedRows`
        );
        assert.equal(
            typeof selfHealTriggerBody.report?.dryRunBackfill?.scanned,
            "number",
            `[${name}] /cxlink/compaction/self-heal/trigger report.dryRunBackfill.scanned`
        );
        assert.ok(
            Array.isArray(selfHealTriggerBody.report?.decision?.reasons),
            `[${name}] /cxlink/compaction/self-heal/trigger report.decision.reasons`
        );
        assert.equal(
            typeof selfHealTriggerBody.status?.runCount,
            "number",
            `[${name}] /cxlink/compaction/self-heal/trigger status.runCount`
        );
        assert.equal(
            typeof selfHealTriggerBody.status?.consecutiveFailures,
            "number",
            `[${name}] /cxlink/compaction/self-heal/trigger status.consecutiveFailures`
        );
        assert.ok(
            Array.isArray(selfHealTriggerBody.status?.slo?.windows),
            `[${name}] /cxlink/compaction/self-heal/trigger status.slo.windows`
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
