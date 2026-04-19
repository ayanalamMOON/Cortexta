import express from "express";
import {
    buildProactiveContextSuggestion,
    shouldEmitProactiveSuggestion
} from "../../../../core/context/proactive";
import { toBoundedInt, toBoundedNumber, toRecord, toTrimmedString } from "../../../../core/daemon/http";
import { retrieveTopK } from "../../../../core/retrieval/retriever";
import { emitDaemonStreamEvent } from "../stream/events";

export const queryRouter = express.Router();

queryRouter.post("/", async (req: any, res: any) => {
    const body = toRecord(req.body);
    const query = toTrimmedString(body.query, 16_384);
    const projectId = toTrimmedString(body.projectId, 256);
    const branch = toTrimmedString(body.branch, 128);
    const topK = toBoundedInt(body.topK, 1, 100);
    const minScore = toBoundedNumber(body.minScore, 0, 1);
    const asOf = toBoundedInt(body.asOf, 0, 32_503_680_000_000);

    if (!query) {
        res.status(400).json({ ok: false, error: "Missing required field: query" });
        return;
    }

    try {
        const results = await retrieveTopK(query, {
            projectId,
            branch,
            topK: Number.isFinite(topK) ? topK : undefined,
            minScore: Number.isFinite(minScore) ? minScore : undefined,
            asOf: Number.isFinite(asOf) ? asOf : undefined
        });

        const suggestion = buildProactiveContextSuggestion({
            query,
            projectId,
            branch,
            asOf: Number.isFinite(asOf) ? asOf : undefined
        });

        if (shouldEmitProactiveSuggestion(suggestion)) {
            emitDaemonStreamEvent({
                projectId,
                eventType: "contextSuggested",
                payload: {
                    query,
                    suggestion,
                    source: "query"
                },
                sessionId: `query-suggest-${Date.now().toString(36)}`
            });
        }

        res.json({ ok: true, route: "query", count: results.length, results, suggestion });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});
