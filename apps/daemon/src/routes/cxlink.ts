import express from "express";
import { toBoolean, toBoundedInt, toBoundedNumber, toRecord, toTrimmedString } from "../../../../core/daemon/http";
import {
    backfillMemoryCompaction,
    getMemoryCompactionDashboard,
    getMemoryCompactionStats
} from "../../../../core/mempalace/memory.service";
import { retrieveTopK } from "../../../../core/retrieval/retriever";
import { buildPromptEnvelope } from "../../../../packages/core/src/cxlink/adapter";
import { toCxfText } from "../../../../packages/core/src/cxlink/cxf-format";
import { resolveContext } from "../../../../packages/core/src/cxlink/hub";
import type { ContextAtom } from "../../../../packages/core/src/types/context";

export const cxlinkRouter = express.Router();

interface CxlinkBundle {
    query: string;
    memories: any[];
    atoms: ContextAtom[];
    resolved: ReturnType<typeof resolveContext>;
    cxf: string;
    envelope: ReturnType<typeof buildPromptEnvelope>;
}

async function buildCxlinkBundle(params: {
    query: string;
    agent?: string;
    projectId?: string;
    topK?: number;
    minScore?: number;
}): Promise<CxlinkBundle> {
    const memories = await retrieveTopK(params.query, {
        projectId: params.projectId,
        topK: params.topK,
        minScore: params.minScore
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

    return {
        query: params.query,
        memories,
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

cxlinkRouter.post("/context", async (req: any, res: any) => {
    const body = toRecord(req.body);
    const query = toTrimmedString(body.query, 16_384);
    const agent = toTrimmedString(body.agent, 256);
    const projectId = toTrimmedString(body.projectId, 256);
    const topK = toBoundedInt(body.topK, 1, 50);
    const minScore = toBoundedNumber(body.minScore, 0, 1);

    if (!query) {
        res.status(400).json({ ok: false, error: "Missing required field: query" });
        return;
    }

    try {
        const bundle = await buildCxlinkBundle({
            query,
            agent,
            projectId,
            topK: topK ?? 12,
            minScore
        });

        res.json({
            ok: true,
            route: "cxlink/context",
            agent: bundle.resolved.agent,
            tokens: bundle.resolved.tokens,
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
    const topK = toBoundedInt(body.topK, 1, 50);
    const minScore = toBoundedNumber(body.minScore, 0, 1);

    if (!query) {
        res.status(400).json({ ok: false, error: "Missing required field: query" });
        return;
    }

    try {
        const bundle = await buildCxlinkBundle({
            query,
            agent,
            projectId,
            topK: topK ?? 12,
            minScore
        });

        res.json({
            ok: true,
            route: "cxlink/query",
            query,
            count: bundle.memories.length,
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
    const topK = toBoundedInt(body.topK, 1, 50);
    const minScore = toBoundedNumber(body.minScore, 0, 1);

    if (!query) {
        res.status(400).json({ ok: false, error: "Missing required field: query" });
        return;
    }

    try {
        const bundle = await buildCxlinkBundle({
            query,
            agent,
            projectId,
            topK: topK ?? 12,
            minScore
        });

        const steps = buildExecutionPlan(query, bundle.memories);

        res.json({
            ok: true,
            route: "cxlink/plan",
            query,
            agent: bundle.resolved.agent,
            tokens: bundle.resolved.tokens,
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
