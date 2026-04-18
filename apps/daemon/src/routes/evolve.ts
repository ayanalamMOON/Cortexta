import express from "express";
import { toBoolean, toBoundedInt, toRecord, toTrimmedString } from "../../../../core/daemon/http";
import { consolidate } from "../../../../core/mempalace/consolidation";
import { listMemories, upsertMemory } from "../../../../core/mempalace/memory.service";

export const evolveRouter = express.Router();

evolveRouter.post("/", async (req: any, res: any) => {
    const body = toRecord(req.body);
    const projectId = toTrimmedString(body.projectId, 256);
    const dryRun = toBoolean(body.dryRun, false);
    const limit = toBoundedInt(body.limit, 1, 5_000) ?? 500;

    try {
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
