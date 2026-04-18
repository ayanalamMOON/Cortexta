import express from "express";
import { compileContext } from "../../../../core/context/compiler";
import { toBoundedInt, toRecord, toStringArray, toTrimmedString } from "../../../../core/daemon/http";

export const contextRouter = express.Router();

contextRouter.post("/", async (req: any, res: any) => {
    const body = toRecord(req.body);
    const query = toTrimmedString(body.query, 16_384);
    const projectId = toTrimmedString(body.projectId, 256);
    const maxTokens = toBoundedInt(body.maxTokens, 128, 32_768);
    const topK = toBoundedInt(body.topK, 1, 100);
    const constraints = toStringArray(body.constraints, 64, 256);
    const scope = toTrimmedString(body.scope, 256);

    if (!query) {
        res.status(400).json({ ok: false, error: "Missing required field: query" });
        return;
    }

    try {
        const result = await compileContext(query, {
            projectId,
            maxTokens: Number.isFinite(maxTokens) ? maxTokens : undefined,
            topK: Number.isFinite(topK) ? topK : undefined,
            constraints,
            scope
        });

        res.json({
            ok: true,
            route: "context",
            context: result.context,
            tokens: result.tokenEstimate,
            memoriesUsed: result.memoriesUsed,
            dropped: result.dropped
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});
