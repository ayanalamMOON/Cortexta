import express from "express";
import rateLimit from "express-rate-limit";
import { toPort, toTrimmedString } from "../../../core/daemon/http";
import { readDaemonObservabilityConfigFromEnv } from "./observability/config";
import {
    configureDaemonLogger,
    daemonChildLogger
} from "./observability/logger";
import {
    areMetricsEnabled,
    configureDaemonMetrics,
    metricsPath,
    metricsRequireAuth,
    renderMetrics,
    setSelfHealingConsecutiveFailures
} from "./observability/metrics";
import { daemonRequestObservabilityMiddleware } from "./observability/middleware";
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

const observabilityConfig = readDaemonObservabilityConfigFromEnv();
configureDaemonLogger(observabilityConfig);
configureDaemonMetrics(observabilityConfig.metrics);
const daemonLogger = daemonChildLogger({ component: "server" });

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

function requiredDaemonToken(): string | undefined {
    return toTrimmedString(readEnv("CORTEXA_DAEMON_TOKEN"), 512);
}

function isAuthorizedRequest(req: any): boolean {
    const required = requiredDaemonToken();
    if (!required || required === "replace-with-secure-token") {
        return true;
    }

    const token = extractAuthToken(req);
    return token === required;
}

function jsonSyntaxErrorHandler(error: any, _req: any, res: any, next: (error?: any) => void): void {
    if (error instanceof SyntaxError && "body" in error) {
        res.status(400).json({ ok: false, error: "Invalid JSON payload" });
        return;
    }
    next(error);
}

function authMiddleware(req: any, res: any, next: () => void): void {
    if (!isAuthorizedRequest(req)) {
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

    app.use(daemonRequestObservabilityMiddleware);

    if (observabilityConfig.rateLimit.enabled) {
        app.use(
            rateLimit({
                windowMs: observabilityConfig.rateLimit.windowMs,
                limit: observabilityConfig.rateLimit.maxRequests,
                standardHeaders: true,
                legacyHeaders: false,
                skip: (req: any) => {
                    const path = typeof req?.path === "string" ? req.path : "";
                    return path === "/health" || path === metricsPath();
                },
                handler: (req: any, res: any) => {
                    daemonLogger.warn(
                        {
                            requestId: req?.requestId,
                            ip: req?.ip,
                            method: req?.method,
                            path: req?.path
                        },
                        "rate.limit.exceeded"
                    );

                    res.status(429).json({
                        ok: false,
                        error: "rate_limit_exceeded",
                        requestId: req?.requestId
                    });
                }
            })
        );
    }

    app.use(express.json({ limit: readEnv("CORTEXA_DAEMON_BODY_LIMIT") ?? "6mb" }));
    app.use(jsonSyntaxErrorHandler);

    if (areMetricsEnabled()) {
        app.get(metricsPath(), async (req: any, res: any) => {
            if (metricsRequireAuth() && !isAuthorizedRequest(req)) {
                res.status(401).json({ ok: false, error: "unauthorized" });
                return;
            }

            try {
                const metrics = await renderMetrics();
                res.setHeader("content-type", metrics.contentType);
                res.status(200).send(metrics.payload);
            } catch (error) {
                daemonLogger.error(
                    {
                        error: error instanceof Error ? error.message : String(error)
                    },
                    "metrics.render.failed"
                );
                res.status(500).send("metrics_unavailable");
            }
        });
    }

    app.get("/health", (_req: any, res: any) => {
        const selfHealing = getSelfHealingStatus();
        setSelfHealingConsecutiveFailures(selfHealing.consecutiveFailures);

        res.json({
            ok: true,
            service: "cortexa-daemon",
            ts: Date.now(),
            uptimeMs: Math.round(process.uptime() * 1000),
            observability: {
                logging: {
                    enabled: observabilityConfig.logging.enabled,
                    level: observabilityConfig.logging.level,
                    format: observabilityConfig.logging.format
                },
                metrics: {
                    enabled: areMetricsEnabled(),
                    path: metricsPath(),
                    requireAuth: metricsRequireAuth()
                },
                rateLimit: {
                    enabled: observabilityConfig.rateLimit.enabled,
                    windowMs: observabilityConfig.rateLimit.windowMs,
                    maxRequests: observabilityConfig.rateLimit.maxRequests
                }
            },
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

    app.use((error: any, req: any, res: any, _next: (error?: any) => void) => {
        daemonLogger.error(
            {
                requestId: req?.requestId,
                method: req?.method,
                path: req?.path,
                error: error instanceof Error ? error.message : String(error)
            },
            "request.unhandled.error"
        );

        if (res.headersSent) {
            return;
        }

        res.status(500).json({
            ok: false,
            error: "internal_server_error",
            requestId: req?.requestId
        });
    });

    return app;
}

export function startDaemon(port = readPortEnv("CORTEXA_DAEMON_PORT", 4312), wsPort = readPortEnv("CORTEXA_WS_PORT", 4321)) {
    const app = createDaemonApp();
    const server = app.listen(port, () => {
        daemonLogger.info(
            {
                port,
                metricsEnabled: areMetricsEnabled(),
                metricsPath: metricsPath(),
                rateLimitEnabled: observabilityConfig.rateLimit.enabled
            },
            "daemon.http.started"
        );
    });

    startSelfHealingScheduler();
    setSelfHealingConsecutiveFailures(getSelfHealingStatus().consecutiveFailures);

    let wss: ReturnType<typeof startWsServer> | null = null;
    try {
        wss = startWsServer(wsPort);
        daemonLogger.info({ wsPort }, "daemon.ws.started");
    } catch (error) {
        daemonLogger.warn(
            {
                error: error instanceof Error ? error.message : String(error)
            },
            "daemon.ws.start.failed"
        );
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
        setSelfHealingConsecutiveFailures(getSelfHealingStatus().consecutiveFailures);

        if (wss) {
            try {
                (wss as any).close(() => done());
            } catch {
                done();
            }
        }

        server.close(() => {
            daemonLogger.info("daemon.http.stopped");
            done();
        });
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
