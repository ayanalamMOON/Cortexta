import express from "express";
import { getContextStreamController } from "../context-stream/service";
import { getDaemonRuntimeInfo } from "../daemon-info";
import { readDaemonObservabilityConfigFromEnv } from "../observability/config";
import {
    areMetricsEnabled,
    metricsPath,
    metricsRequireAuth
} from "../observability/metrics";
import { getSessionResurrectionStatus } from "../session-resurrection";
import { getSelfHealingStatus } from "../self-healing";
import { listDaemonRoutes } from "./catalog";
import { listDaemonRouteDocs } from "./route-docs";

export const metaRouter = express.Router();

metaRouter.get("/ready", (_req: any, res: any) => {
    res.json({
        ok: true,
        ready: true,
        ...getDaemonRuntimeInfo(),
        subsystems: {
            selfHealing: getSelfHealingStatus(),
            sessionResurrection: getSessionResurrectionStatus(),
            contextStream: getContextStreamController().status()
        }
    });
});

metaRouter.get("/info", (_req: any, res: any) => {
    res.json({
        ok: true,
        info: getDaemonRuntimeInfo(),
        observability: readDaemonObservabilityConfigFromEnv(),
        metrics: {
            enabled: areMetricsEnabled(),
            path: metricsPath(),
            requireAuth: metricsRequireAuth()
        }
    });
});

metaRouter.get("/routes", (_req: any, res: any) => {
    res.json({
        ok: true,
        routes: listDaemonRoutes()
    });
});

metaRouter.get("/routes/docs", (_req: any, res: any) => {
    res.json({
        ok: true,
        docs: listDaemonRouteDocs()
    });
});
