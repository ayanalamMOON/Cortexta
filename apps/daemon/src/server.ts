import express from "express";
import { toPort, toTrimmedString } from "../../../core/daemon/http";
import { contextRouter } from "./routes/context";
import { cxlinkRouter } from "./routes/cxlink";
import { evolveRouter } from "./routes/evolve";
import { ingestRouter } from "./routes/ingest";
import { queryRouter } from "./routes/query";
import {
    getSelfHealingStatus,
    startSelfHealingScheduler,
    stopSelfHealingScheduler
} from "./self-healing";
import { startWsServer } from "./stream/ws-server";

function readEnv(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

function readPortEnv(name: string, fallback: number): number {
    return toPort(readEnv(name), fallback);
}

function createRequestId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function extractAuthToken(req: any): string | undefined {
    const direct = toTrimmedString(req?.headers?.["x-cortexa-token"], 512);
    if (direct) {
        return direct;
    }

    const authorization = toTrimmedString(req?.headers?.authorization, 1024);
    if (!authorization) {
        return undefined;
    }

    if (authorization.toLowerCase().startsWith("bearer ")) {
        return toTrimmedString(authorization.slice(7), 512);
    }

    return undefined;
}

function jsonSyntaxErrorHandler(error: any, _req: any, res: any, next: (error?: any) => void): void {
    if (error instanceof SyntaxError && "body" in error) {
        res.status(400).json({ ok: false, error: "Invalid JSON payload" });
        return;
    }
    next(error);
}

function authMiddleware(req: any, res: any, next: () => void): void {
    const required = toTrimmedString(readEnv("CORTEXA_DAEMON_TOKEN"), 512);
    if (!required || required === "replace-with-secure-token") {
        next();
        return;
    }

    const token = extractAuthToken(req);
    if (token !== required) {
        res.status(401).json({ ok: false, error: "unauthorized" });
        return;
    }

    next();
}

export function createDaemonApp() {
    const app = express();
    app.disable("x-powered-by");

    app.use((_req: any, res: any, next: () => void) => {
        res.setHeader("x-content-type-options", "nosniff");
        res.setHeader("x-frame-options", "DENY");
        res.setHeader("referrer-policy", "no-referrer");
        next();
    });

    app.use((req: any, res: any, next: () => void) => {
        const requestId = createRequestId();
        req.requestId = requestId;
        res.setHeader("x-request-id", requestId);
        next();
    });

    app.use(express.json({ limit: readEnv("CORTEXA_DAEMON_BODY_LIMIT") ?? "6mb" }));
    app.use(jsonSyntaxErrorHandler);

    app.get("/health", (_req: any, res: any) => {
        const selfHealing = getSelfHealingStatus();

        res.json({
            ok: true,
            service: "cortexa-daemon",
            ts: Date.now(),
            uptimeMs: Math.round(process.uptime() * 1000),
            selfHealing: {
                enabled: selfHealing.enabled,
                started: selfHealing.started,
                running: selfHealing.running,
                nextRunAt: selfHealing.nextRunAt,
                lastScheduledDelayMs: selfHealing.lastScheduledDelayMs,
                consecutiveFailures: selfHealing.consecutiveFailures,
                lastOutcome: selfHealing.lastRun?.outcome,
                runCount: selfHealing.runCount,
                slo: selfHealing.slo
            }
        });
    });

    app.use(authMiddleware);

    app.use("/ingest", ingestRouter);
    app.use("/query", queryRouter);
    app.use("/context", contextRouter);
    app.use("/cxlink", cxlinkRouter);
    app.use("/evolve", evolveRouter);

    return app;
}

export function startDaemon(port = readPortEnv("CORTEXA_DAEMON_PORT", 4312), wsPort = readPortEnv("CORTEXA_WS_PORT", 4321)) {
    const app = createDaemonApp();
    const server = app.listen(port, () => {
        console.log(`CORTEXA daemon running on port ${port}`);
    });

    startSelfHealingScheduler();

    let wss: ReturnType<typeof startWsServer> | null = null;
    try {
        wss = startWsServer(wsPort);
        console.log(`CORTEXA stream server running on port ${wsPort}`);
    } catch (error) {
        console.warn("WebSocket stream server failed to start; continuing without streaming.", error);
    }

    const close = (callback?: () => void): void => {
        let remaining = 1 + (wss ? 1 : 0);
        const done = () => {
            remaining -= 1;
            if (remaining <= 0) {
                callback?.();
            }
        };

        stopSelfHealingScheduler();

        if (wss) {
            try {
                (wss as any).close(() => done());
            } catch {
                done();
            }
        }

        server.close(() => done());
    };

    return {
        server,
        wss,
        close
    };
}

const shouldAutoStart = readEnv("CORTEXA_DAEMON_AUTOSTART") !== "0";

if (shouldAutoStart && require.main === module) {
    startDaemon();
}
