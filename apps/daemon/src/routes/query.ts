import express from "express";
import { toBoundedInt, toBoundedNumber, toRecord, toTrimmedString } from "../../../../core/daemon/http";
import { retrieveTopK } from "../../../../core/retrieval/retriever";

export const queryRouter = express.Router();

queryRouter.post("/", async (req: any, res: any) => {
    const body = toRecord(req.body);
    const query = toTrimmedString(body.query, 16_384);
    const projectId = toTrimmedString(body.projectId, 256);
    const topK = toBoundedInt(body.topK, 1, 100);
    const minScore = toBoundedNumber(body.minScore, 0, 1);

    if (!query) {
        res.status(400).json({ ok: false, error: "Missing required field: query" });
        return;
    }

    try {
        const results = await retrieveTopK(query, {
            projectId,
            topK: Number.isFinite(topK) ? topK : undefined,
            minScore: Number.isFinite(minScore) ? minScore : undefined
        });

        res.json({ ok: true, route: "query", count: results.length, results });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});
