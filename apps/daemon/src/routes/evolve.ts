import express from "express";
import { toBoolean, toBoundedInt, toRecord, toTrimmedString } from "../../../../core/daemon/http";
import { consolidate } from "../../../../core/mempalace/consolidation";
import { evolveMemoryWithProgression } from "../../../../core/mempalace/evolution.service";
import { listMemories, upsertMemory } from "../../../../core/mempalace/memory.service";

export const evolveRouter = express.Router();

async function respondWithProgression(params: {
    route: "evolve" | "evolve/progression";
    projectId?: string;
    branch?: string;
    text: string;
    context?: string;
    dryRun: boolean;
    res: any;
}): Promise<void> {
    const progression = await evolveMemoryWithProgression({
        projectId: params.projectId,
        branch: params.branch,
        text: params.text,
        context: params.context,
        dryRun: params.dryRun
    });

    params.res.json({
        ok: true,
        route: params.route,
        mode: "progression",
        projectId: progression.projectId,
        dryRun: progression.dryRun,
        stored: progression.result.stored,
        persisted: progression.persisted,
        action: progression.result.action,
        reason: progression.result.reason,
        atomId: progression.result.atomId,
        progression: progression.result.progression
    });
}

evolveRouter.post("/progression", async (req: any, res: any) => {
    const body = toRecord(req.body);
    const projectId = toTrimmedString(body.projectId, 256);
    const branch = toTrimmedString(body.branch, 128);
    const text = toTrimmedString(body.text, 24_000);
    const context = toTrimmedString(body.context, 24_000);
    const dryRun = toBoolean(body.dryRun, false);

    if (!text) {
        res.status(400).json({
            ok: false,
            error: "Missing required field: text"
        });
        return;
    }

    try {
        await respondWithProgression({
            route: "evolve/progression",
            projectId,
            branch,
            text,
            context,
            dryRun,
            res
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

evolveRouter.post("/", async (req: any, res: any) => {
    const body = toRecord(req.body);
    const projectId = toTrimmedString(body.projectId, 256);
    const branch = toTrimmedString(body.branch, 128);
    const text = toTrimmedString(body.text, 24_000);
    const context = toTrimmedString(body.context, 24_000);
    const dryRun = toBoolean(body.dryRun, false);
    const limit = toBoundedInt(body.limit, 1, 5_000) ?? 500;

    try {
        if (text) {
            await respondWithProgression({
                route: "evolve",
                projectId,
                branch,
                text,
                context,
                dryRun,
                res
            });
            return;
        }

        const source = listMemories(projectId, limit);
        const evolved = consolidate(source);
        let persistedCount = 0;

        if (!dryRun) {
            for (const memory of evolved) {
                await upsertMemory({
                    id: memory.id,
                    projectId: memory.projectId,
                    kind: memory.kind,
                    sourceType: memory.sourceType,
                    title: memory.title,
                    summary: memory.summary,
                    content: memory.content,
                    tags: memory.tags,
                    importance: memory.importance,
                    confidence: memory.confidence,
                    sourceRef: memory.sourceRef,
                    embeddingRef: memory.embeddingRef
                });
                persistedCount += 1;
            }
        }

        res.json({
            ok: true,
            route: "evolve",
            mode: "consolidate",
            dryRun,
            sourceCount: source.length,
            evolvedCount: evolved.length,
            removed: Math.max(0, source.length - evolved.length),
            persistedCount
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});
