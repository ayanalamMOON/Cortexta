import express from "express";
import { toBoolean, toBoundedInt, toRecord, toTrimmedString } from "../../../../core/daemon/http";
import { runIngestion } from "../../../../core/ingestion/ingest.pipeline";

export const ingestRouter = express.Router();

ingestRouter.post("/", async (req: any, res: any) => {
    const body = toRecord(req.body);
    const projectPath = toTrimmedString(body.path, 4096);
    const projectId = toTrimmedString(body.projectId, 256);
    const includeChats = toBoolean(body.includeChats, false);
    const skipUnchanged = toBoolean(body.skipUnchanged, true);
    const maxFiles = toBoundedInt(body.maxFiles, 0, 200_000);
    const maxChatFiles = toBoundedInt(body.maxChatFiles, 1, 50_000);
    const chatRoot = toTrimmedString(body.chatRoot, 4096);

    if (!projectPath) {
        res.status(400).json({ ok: false, error: "Missing required field: path" });
        return;
    }

    try {
        const result = await runIngestion({
            projectPath,
            projectId,
            includeChats,
            skipUnchanged,
            maxFiles,
            maxChatFiles,
            chatSearchRoots: chatRoot ? [chatRoot] : undefined
        });

        res.json({ ok: true, route: "ingest", result });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});
