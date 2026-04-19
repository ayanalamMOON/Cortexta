import express from "express";
import { compileContext } from "../../../../core/context/compiler";
import {
    buildProactiveContextSuggestion,
    shouldEmitProactiveSuggestion
} from "../../../../core/context/proactive";
import { toBoolean, toBoundedInt, toRecord, toStringArray, toTrimmedString } from "../../../../core/daemon/http";
import { emitDaemonStreamEvent } from "../stream/events";

export const contextRouter = express.Router();

contextRouter.post("/", async (req: any, res: any) => {
    const body = toRecord(req.body);
    const query = toTrimmedString(body.query, 16_384);
    const projectId = toTrimmedString(body.projectId, 256);
    const branch = toTrimmedString(body.branch, 128);
    const maxTokens = toBoundedInt(body.maxTokens, 128, 32_768);
    const topK = toBoundedInt(body.topK, 1, 100);
    const asOf = toBoundedInt(body.asOf, 0, 32_503_680_000_000);
    const constraints = toStringArray(body.constraints, 64, 256);
    const scope = toTrimmedString(body.scope, 256);
    const proactive = toBoolean(body.proactive, true);

    if (!query) {
        res.status(400).json({ ok: false, error: "Missing required field: query" });
        return;
    }

    try {
        const result = await compileContext(query, {
            projectId,
            branch,
            maxTokens: Number.isFinite(maxTokens) ? maxTokens : undefined,
            topK: Number.isFinite(topK) ? topK : undefined,
            asOf: Number.isFinite(asOf) ? asOf : undefined,
            constraints,
            scope
        });

        const suggestion = proactive
            ? buildProactiveContextSuggestion({
                query,
                projectId,
                branch,
                asOf: Number.isFinite(asOf) ? asOf : undefined
            })
            : undefined;

        if (suggestion && shouldEmitProactiveSuggestion(suggestion)) {
            emitDaemonStreamEvent({
                projectId,
                eventType: "contextSuggested",
                payload: {
                    query,
                    suggestion
                },
                sessionId: `context-suggest-${Date.now().toString(36)}`
            });
        }

        res.json({
            ok: true,
            route: "context",
            context: result.context,
            tokens: result.tokenEstimate,
            memoriesUsed: result.memoriesUsed,
            dropped: result.dropped,
            suggestion
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

contextRouter.post("/suggest", async (req: any, res: any) => {
    const body = toRecord(req.body);
    const query = toTrimmedString(body.query, 16_384);
    const projectId = toTrimmedString(body.projectId, 256);
    const branch = toTrimmedString(body.branch, 128);
    const asOf = toBoundedInt(body.asOf, 0, 32_503_680_000_000);
    const warmup = toBoolean(body.warmup, false);

    if (!query) {
        res.status(400).json({ ok: false, error: "Missing required field: query" });
        return;
    }

    try {
        const suggestion = buildProactiveContextSuggestion({
            query,
            projectId,
            branch,
            asOf: Number.isFinite(asOf) ? asOf : undefined
        });

        const warmupTopK = toBoundedInt(body.topK, 1, 100) ?? suggestion.recommendedTopK;
        const warmupMaxTokens =
            toBoundedInt(body.maxTokens, 128, 32_768) ?? suggestion.recommendedMaxTokens;

        let warmedContext:
            | {
                context: string;
                tokens: number;
                memoriesUsed: number;
                dropped: number;
            }
            | undefined;

        if (warmup) {
            const compiled = await compileContext(query, {
                projectId,
                branch,
                asOf: Number.isFinite(asOf) ? asOf : undefined,
                topK: warmupTopK,
                maxTokens: warmupMaxTokens,
                constraints: suggestion.recommendedConstraints,
                scope: suggestion.recommendedScope
            });

            warmedContext = {
                context: compiled.context,
                tokens: compiled.tokenEstimate,
                memoriesUsed: compiled.memoriesUsed,
                dropped: compiled.dropped
            };
        }

        if (shouldEmitProactiveSuggestion(suggestion)) {
            emitDaemonStreamEvent({
                projectId,
                eventType: "contextSuggested",
                payload: {
                    query,
                    suggestion,
                    warmup,
                    warmed: Boolean(warmedContext)
                },
                sessionId: `context-suggest-${Date.now().toString(36)}`
            });
        }

        res.json({
            ok: true,
            route: "context/suggest",
            suggestion,
            warmup,
            warmedContext
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});
