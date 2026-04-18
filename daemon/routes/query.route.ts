import { Router } from "express";
import { retrieveTopK } from "../../core/retrieval/retriever";

export const queryRouter = Router();

queryRouter.post("/", async (req: any, res: any) => {
    const { query, projectId, topK, minScore } = (req.body ?? {}) as {
        query?: string;
        projectId?: string;
        topK?: number;
        minScore?: number;
    };

    if (!query || !query.trim()) {
        res.status(400).json({ ok: false, error: "Missing required field: query" });
        return;
    }

    try {
        const results = await retrieveTopK(query, {
            projectId,
            topK,
            minScore
        });

        res.json({
            ok: true,
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
