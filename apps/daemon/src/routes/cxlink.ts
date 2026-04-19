import express from "express";
import { toBoolean, toBoundedInt, toBoundedNumber, toRecord, toTrimmedString } from "../../../../core/daemon/http";
import {
    auditMemoryResurrection,
    backfillMemoryCompaction,
    createMemoryBranch,
    diffMemoriesBetween,
    getMemoryCompactionDashboard,
    getMemoryCompactionOpportunities,
    getMemoryCompactionStats,
    listMemoryBranches,
    mergeMemoryBranch
} from "../../../../core/mempalace/memory.service";
import { retrieveTopK } from "../../../../core/retrieval/retriever";
import { buildPromptEnvelope } from "../../../../packages/core/src/cxlink/adapter";
import { toCxfText } from "../../../../packages/core/src/cxlink/cxf-format";
import { resolveContext } from "../../../../packages/core/src/cxlink/hub";
import type { ContextAtom } from "../../../../packages/core/src/types/context";
import {
    getSelfHealingStatus,
    triggerSelfHealingNow
} from "../self-healing";
import { emitDaemonStreamEvent } from "../stream/events";

export const cxlinkRouter = express.Router();

interface CxlinkBundle {
    query: string;
    memories: any[];
    memoryHealth: MemoryHealthSignal;
    atoms: ContextAtom[];
    resolved: ReturnType<typeof resolveContext>;
    cxf: string;
    envelope: ReturnType<typeof buildPromptEnvelope>;
}

interface MemoryHealthSignal {
    projectId?: string;
    totalRows: number;
    compactionRate: number;
    savedPercent: number;
    anomalyTotal: number;
    status: "healthy" | "warning" | "critical";
    recommendation: string;
}

function buildMemoryHealthSignal(projectId?: string): MemoryHealthSignal {
    const stats = getMemoryCompactionStats(projectId);

    let status: MemoryHealthSignal["status"] = "healthy";
    let recommendation = "Memory quality is healthy. Keep regular ingestion and dashboard snapshots running.";

    if (stats.integrityAnomalies.total > 0) {
        status = "critical";
        recommendation =
            "Integrity anomalies detected. Run memory audit and re-ingest affected sources before critical agent tasks.";
    } else if (stats.totalRows >= 50 && stats.compactionRate < 0.5) {
        status = "warning";
        recommendation =
            "Compaction coverage is low for this memory volume. Consider running memory backfill --apply in maintenance.";
    } else if (stats.totalRows >= 120 && stats.savedPercent < 5) {
        status = "warning";
        recommendation =
            "Compression savings are low at current scale. Review compaction thresholds and run dashboard trend analysis.";
    }

    return {
        projectId,
        totalRows: stats.totalRows,
        compactionRate: stats.compactionRate,
        savedPercent: stats.savedPercent,
        anomalyTotal: stats.integrityAnomalies.total,
        status,
        recommendation
    };
}

async function buildCxlinkBundle(params: {
    query: string;
    agent?: string;
    projectId?: string;
    branch?: string;
    topK?: number;
    minScore?: number;
    asOf?: number;
}): Promise<CxlinkBundle> {
    const memories = await retrieveTopK(params.query, {
        projectId: params.projectId,
        branch: params.branch,
        topK: params.topK,
        minScore: params.minScore,
        asOf: params.asOf
    });

    const atoms: ContextAtom[] = memories.map((memory) => {
        const snippet = toTrimmedString(memory.copilotContent, 320) ?? memory.content.slice(0, 220);
        const body = `${memory.summary}\n${snippet}`.trim();

        return {
            id: memory.id,
            kind: "memory",
            title: memory.title,
            body,
            priority: memory.importance,
            recency: memory.recency,
            relevance: memory.similarity,
            sourceRef: memory.sourceRef,
            tags: memory.tags
        };
    });

    const resolved = resolveContext({
        query: params.query,
        agent: params.agent,
        atoms
    });

    const cxf = toCxfText({
        intent: params.query,
        scope: "project + memory + retrieval",
        concepts: memories.map((memory) => memory.title).slice(0, 10),
        graph: memories
            .map((memory) => `${memory.kind} -> ${memory.title}`)
            .slice(0, 10),
        history: [],
        constraints: ["local-first", "token-bounded", "high-confidence-preferred"],
        metadata: {
            agent: resolved.agent,
            model: resolved.model,
            maxTokens: resolved.maxTokens
        }
    });

    const envelope = buildPromptEnvelope(params.query, resolved.context, {
        includeTokenStats: true
    });

    const memoryHealth = buildMemoryHealthSignal(params.projectId);

    return {
        query: params.query,
        memories,
        memoryHealth,
        atoms,
        resolved,
        cxf,
        envelope
    };
}

function buildExecutionPlan(query: string, memories: any[]): Array<{ id: number; title: string; detail: string }> {
    const anchorTitles = memories
        .map((memory) => toTrimmedString(memory.title, 160))
        .filter((title): title is string => Boolean(title))
        .slice(0, 5);

    const steps: Array<{ id: number; title: string; detail: string }> = [
        {
            id: 1,
            title: "Confirm objective and constraints",
            detail: `Clarify the primary goal for: ${query}`
        },
        {
            id: 2,
            title: "Collect relevant context",
            detail: "Review top-ranked memory/code entities and extract high-confidence facts."
        }
    ];

    for (const title of anchorTitles) {
        steps.push({
            id: steps.length + 1,
            title: `Inspect memory anchor: ${title}`,
            detail: "Validate dependencies and potential side effects before execution."
        });
    }

    steps.push(
        {
            id: steps.length + 1,
            title: "Execute change in bounded increments",
            detail: "Apply updates in small steps, validate after each change, and track regressions early."
        },
        {
            id: steps.length + 1,
            title: "Verify and summarize",
            detail: "Run validation checks, capture outcomes, and document follow-up actions."
        }
    );

    return steps;
}

cxlinkRouter.post("/compaction/stats", (req: any, res: any) => {
    const body = toRecord(req.body);
    const projectId = toTrimmedString(body.projectId, 256);

    try {
        const stats = getMemoryCompactionStats(projectId);
        res.json({
            ok: true,
            route: "cxlink/compaction/stats",
            stats
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

cxlinkRouter.post("/compaction/dashboard", (req: any, res: any) => {
    const body = toRecord(req.body);
    const projectId = toTrimmedString(body.projectId, 256);
    const lookbackDays = toBoundedInt(body.lookbackDays, 1, 3650);
    const maxTrendPoints = toBoundedInt(body.maxTrendPoints, 1, 1000);
    const maxProjects = toBoundedInt(body.maxProjects, 1, 500);
    const persistSnapshot = toBoolean(body.persistSnapshot, true);
    const perProjectSnapshotLimit = toBoundedInt(body.perProjectSnapshotLimit, 0, 500);
    const snapshotRetentionDays = toBoundedInt(body.snapshotRetentionDays, 7, 3650);

    try {
        const dashboard = getMemoryCompactionDashboard({
            projectId,
            lookbackDays,
            maxTrendPoints,
            maxProjects,
            persistSnapshot,
            perProjectSnapshotLimit,
            snapshotRetentionDays
        });

        res.json({
            ok: true,
            route: "cxlink/compaction/dashboard",
            dashboard
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

cxlinkRouter.post("/compaction/backfill", (req: any, res: any) => {
    const body = toRecord(req.body);
    const projectId = toTrimmedString(body.projectId, 256);
    const limit = toBoundedInt(body.limit, 1, 20_000);
    const dryRun = toBoolean(body.dryRun, true);

    try {
        const result = backfillMemoryCompaction({
            projectId,
            limit,
            dryRun
        });

        res.json({
            ok: true,
            route: "cxlink/compaction/backfill",
            result
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

cxlinkRouter.post("/compaction/opportunities", (req: any, res: any) => {
    const body = toRecord(req.body);
    const projectId = toTrimmedString(body.projectId, 256);
    const limit = toBoundedInt(body.limit, 1, 500);
    const scanLimit = toBoundedInt(body.scanLimit, 1, 50_000);
    const minContentChars = toBoundedInt(body.minContentChars, 64, 20_000);

    try {
        const opportunities = getMemoryCompactionOpportunities({
            projectId,
            limit,
            scanLimit,
            minContentChars
        });

        res.json({
            ok: true,
            route: "cxlink/compaction/opportunities",
            opportunities
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

cxlinkRouter.post("/compaction/audit", (req: any, res: any) => {
    const body = toRecord(req.body);
    const projectId = toTrimmedString(body.projectId, 256);
    const limit = toBoundedInt(body.limit, 1, 50_000);
    const maxIssues = toBoundedInt(body.maxIssues, 0, 100);

    try {
        const report = auditMemoryResurrection({
            projectId,
            limit,
            maxIssues
        });

        res.json({
            ok: true,
            route: "cxlink/compaction/audit",
            report
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

cxlinkRouter.post("/compaction/self-heal/status", (_req: any, res: any) => {
    try {
        const status = getSelfHealingStatus();
        res.json({
            ok: true,
            route: "cxlink/compaction/self-heal/status",
            status
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

cxlinkRouter.post("/compaction/self-heal/trigger", async (req: any, res: any) => {
    const body = toRecord(req.body);
    const reason = toTrimmedString(body.reason, 512) ?? "manual-trigger";
    const dryRunOnly = toBoolean(body.dryRunOnly, false);

    try {
        const report = await triggerSelfHealingNow({
            reason,
            dryRunOnly
        });
        res.json({
            ok: true,
            route: "cxlink/compaction/self-heal/trigger",
            report,
            status: getSelfHealingStatus()
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

cxlinkRouter.post("/context", async (req: any, res: any) => {
    const body = toRecord(req.body);
    const query = toTrimmedString(body.query, 16_384);
    const agent = toTrimmedString(body.agent, 256);
    const projectId = toTrimmedString(body.projectId, 256);
    const branch = toTrimmedString(body.branch, 128);
    const topK = toBoundedInt(body.topK, 1, 50);
    const minScore = toBoundedNumber(body.minScore, 0, 1);
    const asOf = toBoundedInt(body.asOf, 0, 32_503_680_000_000);

    if (!query) {
        res.status(400).json({ ok: false, error: "Missing required field: query" });
        return;
    }

    try {
        const bundle = await buildCxlinkBundle({
            query,
            agent,
            projectId,
            branch,
            topK: topK ?? 12,
            minScore,
            asOf
        });

        res.json({
            ok: true,
            route: "cxlink/context",
            agent: bundle.resolved.agent,
            branch: branch ?? "main",
            asOf: Number.isFinite(asOf) ? asOf : undefined,
            tokens: bundle.resolved.tokens,
            memoryHealth: bundle.memoryHealth,
            context: bundle.resolved.context.rendered,
            cxf: bundle.cxf,
            envelope: bundle.envelope
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

cxlinkRouter.post("/query", async (req: any, res: any) => {
    const body = toRecord(req.body);
    const query = toTrimmedString(body.query, 16_384);
    const agent = toTrimmedString(body.agent, 256);
    const projectId = toTrimmedString(body.projectId, 256);
    const branch = toTrimmedString(body.branch, 128);
    const topK = toBoundedInt(body.topK, 1, 50);
    const minScore = toBoundedNumber(body.minScore, 0, 1);
    const asOf = toBoundedInt(body.asOf, 0, 32_503_680_000_000);

    if (!query) {
        res.status(400).json({ ok: false, error: "Missing required field: query" });
        return;
    }

    try {
        const bundle = await buildCxlinkBundle({
            query,
            agent,
            projectId,
            branch,
            topK: topK ?? 12,
            minScore,
            asOf
        });

        res.json({
            ok: true,
            route: "cxlink/query",
            query,
            branch: branch ?? "main",
            asOf: Number.isFinite(asOf) ? asOf : undefined,
            count: bundle.memories.length,
            memoryHealth: bundle.memoryHealth,
            results: bundle.memories,
            cxf: bundle.cxf,
            envelope: bundle.envelope
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

cxlinkRouter.post("/plan", async (req: any, res: any) => {
    const body = toRecord(req.body);
    const query = toTrimmedString(body.query, 16_384);
    const agent = toTrimmedString(body.agent, 256);
    const projectId = toTrimmedString(body.projectId, 256);
    const branch = toTrimmedString(body.branch, 128);
    const topK = toBoundedInt(body.topK, 1, 50);
    const minScore = toBoundedNumber(body.minScore, 0, 1);
    const asOf = toBoundedInt(body.asOf, 0, 32_503_680_000_000);

    if (!query) {
        res.status(400).json({ ok: false, error: "Missing required field: query" });
        return;
    }

    try {
        const bundle = await buildCxlinkBundle({
            query,
            agent,
            projectId,
            branch,
            topK: topK ?? 12,
            minScore,
            asOf
        });

        const steps = buildExecutionPlan(query, bundle.memories);

        res.json({
            ok: true,
            route: "cxlink/plan",
            query,
            agent: bundle.resolved.agent,
            branch: branch ?? "main",
            asOf: Number.isFinite(asOf) ? asOf : undefined,
            tokens: bundle.resolved.tokens,
            memoryHealth: bundle.memoryHealth,
            steps,
            cxf: bundle.cxf,
            envelope: bundle.envelope
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

cxlinkRouter.post("/branch/list", (req: any, res: any) => {
    const body = toRecord(req.body);
    const projectId = toTrimmedString(body.projectId, 256);

    if (!projectId) {
        res.status(400).json({ ok: false, error: "Missing required field: projectId" });
        return;
    }

    try {
        const branches = listMemoryBranches(projectId);
        res.json({
            ok: true,
            route: "cxlink/branch/list",
            projectId,
            branches
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

cxlinkRouter.post("/branch/create", (req: any, res: any) => {
    const body = toRecord(req.body);
    const projectId = toTrimmedString(body.projectId, 256);
    const branch = toTrimmedString(body.branch, 128);
    const fromBranch = toTrimmedString(body.fromBranch, 128);
    const forkedFromCommit = toTrimmedString(body.forkedFromCommit, 256);

    if (!projectId) {
        res.status(400).json({ ok: false, error: "Missing required field: projectId" });
        return;
    }

    if (!branch) {
        res.status(400).json({ ok: false, error: "Missing required field: branch" });
        return;
    }

    try {
        const created = createMemoryBranch({
            projectId,
            branch,
            fromBranch,
            forkedFromCommit
        });

        res.json({
            ok: true,
            route: "cxlink/branch/create",
            created
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

cxlinkRouter.post("/branch/merge", async (req: any, res: any) => {
    const body = toRecord(req.body);
    const projectId = toTrimmedString(body.projectId, 256);
    const sourceBranch = toTrimmedString(body.sourceBranch, 128);
    const targetBranch = toTrimmedString(body.targetBranch, 128);
    const strategy = toTrimmedString(body.strategy, 32);

    if (!projectId) {
        res.status(400).json({ ok: false, error: "Missing required field: projectId" });
        return;
    }

    if (!sourceBranch || !targetBranch) {
        res.status(400).json({ ok: false, error: "Missing required fields: sourceBranch and targetBranch" });
        return;
    }

    try {
        const result = await mergeMemoryBranch({
            projectId,
            sourceBranch,
            targetBranch,
            strategy: strategy === "target-wins" ? "target-wins" : "source-wins"
        });

        res.json({
            ok: true,
            route: "cxlink/branch/merge",
            result
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

cxlinkRouter.post("/branch/switch", (req: any, res: any) => {
    const body = toRecord(req.body);
    const projectId = toTrimmedString(body.projectId, 256);
    const fromBranch = toTrimmedString(body.fromBranch, 128) ?? "main";
    const toBranch = toTrimmedString(body.toBranch, 128);
    const reason = toTrimmedString(body.reason, 512) ?? "manual-switch";

    if (!projectId) {
        res.status(400).json({ ok: false, error: "Missing required field: projectId" });
        return;
    }

    if (!toBranch) {
        res.status(400).json({ ok: false, error: "Missing required field: toBranch" });
        return;
    }

    try {
        const ensured = createMemoryBranch({
            projectId,
            branch: toBranch,
            fromBranch
        });

        const event = emitDaemonStreamEvent({
            projectId,
            eventType: "branchSwitched",
            payload: {
                fromBranch,
                toBranch,
                reason,
                switchedAt: Date.now()
            },
            sessionId: `branch-switch-${Date.now().toString(36)}`
        });

        res.json({
            ok: true,
            route: "cxlink/branch/switch",
            switched: {
                projectId,
                fromBranch,
                toBranch,
                reason
            },
            branch: ensured,
            streamEvent: event
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

cxlinkRouter.post("/temporal/query", async (req: any, res: any) => {
    const body = toRecord(req.body);
    const query = toTrimmedString(body.query, 16_384);
    const projectId = toTrimmedString(body.projectId, 256);
    const branch = toTrimmedString(body.branch, 128);
    const asOf = toBoundedInt(body.asOf, 0, 32_503_680_000_000);
    const topK = toBoundedInt(body.topK, 1, 50);
    const minScore = toBoundedNumber(body.minScore, 0, 1);

    if (!query) {
        res.status(400).json({ ok: false, error: "Missing required field: query" });
        return;
    }

    if (!projectId) {
        res.status(400).json({ ok: false, error: "Missing required field: projectId" });
        return;
    }

    if (!Number.isFinite(asOf)) {
        res.status(400).json({ ok: false, error: "Missing required field: asOf" });
        return;
    }

    try {
        const results = await retrieveTopK(query, {
            projectId,
            branch,
            asOf,
            topK: topK ?? 12,
            minScore
        });

        res.json({
            ok: true,
            route: "cxlink/temporal/query",
            query,
            projectId,
            branch: branch ?? "main",
            asOf,
            count: results.length,
            results
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

cxlinkRouter.post("/temporal/diff", (req: any, res: any) => {
    const body = toRecord(req.body);
    const projectId = toTrimmedString(body.projectId, 256);
    const branch = toTrimmedString(body.branch, 128);
    const from = toBoundedInt(body.from, 0, 32_503_680_000_000);
    const to = toBoundedInt(body.to, 0, 32_503_680_000_000);
    const limit = toBoundedInt(body.limit, 1, 2000);
    const fromValue = typeof from === "number" && Number.isFinite(from) ? from : undefined;
    const toValue = typeof to === "number" && Number.isFinite(to) ? to : undefined;

    if (!projectId) {
        res.status(400).json({ ok: false, error: "Missing required field: projectId" });
        return;
    }

    if (fromValue === undefined || toValue === undefined) {
        res.status(400).json({ ok: false, error: "Missing required fields: from and to" });
        return;
    }

    try {
        const diff = diffMemoriesBetween({
            projectId,
            branch,
            from: fromValue,
            to: toValue,
            limit
        });

        res.json({
            ok: true,
            route: "cxlink/temporal/diff",
            diff
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});
