import { Router } from "express";
import { compileContext } from "../../core/context/compiler";

export const contextRouter = Router();

contextRouter.post("/", async (req: any, res: any) => {
    const {
        query,
        projectId,
        maxTokens,
        topK,
        constraints,
        scope
    } = (req.body ?? {}) as {
        query?: string;
        projectId?: string;
        maxTokens?: number;
        topK?: number;
        constraints?: string[];
        scope?: string;
    };

    if (!query || !query.trim()) {
        res.status(400).json({ ok: false, error: "Missing required field: query" });
        return;
    }

    try {
        const compiled = await compileContext(query, {
            projectId,
            maxTokens,
            topK,
            constraints,
            scope
        });

        res.json({
            ok: true,
            result: compiled
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});
