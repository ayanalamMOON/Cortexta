import { daemonChildLogger } from "./logger";
import {
    openInflightRequestMetric,
    recordHttpRequestMetric
} from "./metrics";

const requestLogger = daemonChildLogger({ component: "http" });

function routeLabelFromRequest(req: any): string {
    const routePath = typeof req?.route?.path === "string" ? req.route.path : "";
    const baseUrl = typeof req?.baseUrl === "string" ? req.baseUrl : "";

    if (routePath) {
        return `${baseUrl}${routePath}`;
    }

    const originalUrl = typeof req?.originalUrl === "string" ? req.originalUrl : "";
    const withoutQuery = originalUrl.split("?")[0] ?? originalUrl;
    return withoutQuery || "unknown";
}

export function daemonRequestObservabilityMiddleware(req: any, res: any, next: () => void): void {
    const startedAt = Date.now();
    const method = typeof req?.method === "string" ? req.method : "UNKNOWN";
    const requestId = typeof req?.requestId === "string" ? req.requestId : undefined;
    const closeInflightMetric = openInflightRequestMetric();

    let finalized = false;

    const finalize = (event: "finish" | "close"): void => {
        if (finalized) {
            return;
        }
        finalized = true;

        closeInflightMetric();

        const durationMs = Math.max(0, Date.now() - startedAt);
        const statusCode = Number.isFinite(res?.statusCode) ? Number(res.statusCode) : 0;
        const route = routeLabelFromRequest(req);

        recordHttpRequestMetric({
            method,
            route,
            statusCode,
            durationMs
        });

        requestLogger.info(
            {
                event,
                requestId,
                method,
                route,
                statusCode,
                durationMs,
                ip: req?.ip,
                userAgent: req?.headers?.["user-agent"]
            },
            "http.request.completed"
        );
    };

    res.on("finish", () => finalize("finish"));
    res.on("close", () => {
        if (!res.writableEnded) {
            finalize("close");
        }
    });

    next();
}
