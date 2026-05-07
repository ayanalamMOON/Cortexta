import express from "express";
import { toBoolean, toBoundedInt, toBoundedNumber, toRecord, toTrimmedString } from "../../../../core/daemon/http";
import { getContextStreamController } from "../context-stream/service";

export const contextStreamRouter = express.Router();

const controller = getContextStreamController();

contextStreamRouter.post("/start", async (req: any, res: any) => {
    const body = toRecord(req.body);
    const rootPath = toTrimmedString(body.rootPath, 4096);
    const projectId = toTrimmedString(body.projectId, 256);
    const branch = toTrimmedString(body.branch, 128);

    if (!rootPath) {
        res.status(400).json({ ok: false, error: "Missing required field: rootPath" });
        return;
    }

    try {
        const started = await controller.start({
            rootPath,
            projectId: projectId ?? "default",
            branch: branch ?? "main",
            config: {
                debounceMs: toBoundedInt(body.debounceMs, 250, 20_000),
                minConfidence: toBoundedNumber(body.minConfidence, 0.1, 1),
                maxSuggestionsPerMinute: toBoundedInt(body.maxSuggestionsPerMinute, 1, 120),
                topK: toBoundedInt(body.topK, 1, 40),
                maxTokens: toBoundedInt(body.maxTokens, 256, 12_000),
                previewChars: toBoundedInt(body.previewChars, 240, 8_000),
                suggestionTtlMs: toBoundedInt(body.suggestionTtlMs, 5_000, 300_000),
                dedupeWindowMs: toBoundedInt(body.dedupeWindowMs, 2_000, 120_000),
                includeUnknownLanguages: toBoolean(body.includeUnknownLanguages, false),
                suppressOnCriticalRisk: toBoolean(body.suppressOnCriticalRisk, true)
            }
        });

        res.json({
            ok: true,
            route: "context/stream/start",
            started
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

contextStreamRouter.post("/stop", async (req: any, res: any) => {
    const body = toRecord(req.body);
    const projectId = toTrimmedString(body.projectId, 256);
    const branch = toTrimmedString(body.branch, 128);

    if (!projectId) {
        res.status(400).json({ ok: false, error: "Missing required field: projectId" });
        return;
    }

    try {
        const stopped = await controller.stop(projectId, branch);
        res.json({
            ok: true,
            route: "context/stream/stop",
            stopped
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

contextStreamRouter.post("/status", (_req: any, res: any) => {
    try {
        res.json({
            ok: true,
            route: "context/stream/status",
            status: controller.status()
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

contextStreamRouter.post("/ack", async (req: any, res: any) => {
    const body = toRecord(req.body);
    const projectId = toTrimmedString(body.projectId, 256);
    const branch = toTrimmedString(body.branch, 128);
    const suggestionHash = toTrimmedString(body.suggestionHash, 128);
    const action = toTrimmedString(body.action, 32);
    const reason = toTrimmedString(body.reason, 256);

    if (!projectId) {
        res.status(400).json({ ok: false, error: "Missing required field: projectId" });
        return;
    }

    if (!suggestionHash) {
        res.status(400).json({ ok: false, error: "Missing required field: suggestionHash" });
        return;
    }

    if (action !== "ack" && action !== "applied" && action !== "suppressed") {
        res.status(400).json({ ok: false, error: "Missing or invalid required field: action" });
        return;
    }

    try {
        const acknowledged = await controller.ack({
            projectId,
            branch,
            suggestionHash,
            action,
            reason
        });

        if (!acknowledged) {
            res.status(404).json({ ok: false, error: "Suggestion not found" });
            return;
        }

        res.json({
            ok: true,
            route: "context/stream/ack",
            suggestion: acknowledged
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});
