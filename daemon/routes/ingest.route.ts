import { Router } from "express";
import { runIngestion } from "../../core/ingestion/ingest.pipeline";

export const ingestRouter = Router();

ingestRouter.post("/", async (req: any, res: any) => {
    const {
        path: projectPath,
        projectId,
        includeChats,
        skipUnchanged,
        maxFiles,
        maxChatFiles,
        chatRoot
    } = (req.body ?? {}) as {
        path?: string;
        projectId?: string;
        includeChats?: boolean;
        skipUnchanged?: boolean;
        maxFiles?: number;
        maxChatFiles?: number;
        chatRoot?: string;
    };

    if (!projectPath) {
        res.status(400).json({ ok: false, error: "Missing required field: path" });
        return;
    }

    try {
        const result = await runIngestion({
            projectPath,
            projectId,
            includeChats: Boolean(includeChats),
            skipUnchanged: skipUnchanged !== false,
            maxFiles,
            maxChatFiles,
            chatSearchRoots: chatRoot ? [String(chatRoot)] : undefined
        });

        res.json({ ok: true, result });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});
