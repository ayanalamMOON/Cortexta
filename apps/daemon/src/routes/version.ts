import express from "express";
import { getDaemonRuntimeInfo } from "../daemon-info";

export const versionRouter = express.Router();

versionRouter.get("/version", (_req: any, res: any) => {
    const runtime = getDaemonRuntimeInfo();
    res.json({
        ok: true,
        service: runtime.service,
        packageName: runtime.packageName,
        version: runtime.version,
        nodeVersion: runtime.nodeVersion
    });
});
