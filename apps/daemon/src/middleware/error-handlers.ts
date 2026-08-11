import { getDaemonErrorMessage } from "../http/respond";
import { isDaemonHttpError } from "../errors/http-error";

export function daemonNotFoundMiddleware(req: any, res: any): void {
    if (res.headersSent) {
        return;
    }

    res.status(404).json({
        ok: false,
        error: "not_found",
        message: `No daemon route for ${req?.method ?? "UNKNOWN"} ${req?.path ?? "unknown"}`,
        requestId: req?.requestId
    });
}

export function daemonErrorMiddleware(error: unknown, req: any, res: any, _next: (error?: unknown) => void): void {
    if (res.headersSent) {
        return;
    }

    if (isDaemonHttpError(error)) {
        res.status(error.status).json({
            ok: false,
            error: error.code,
            message: error.message,
            details: error.details,
            requestId: req?.requestId
        });
        return;
    }

    res.status(500).json({
        ok: false,
        error: "internal_server_error",
        message: getDaemonErrorMessage(error),
        requestId: req?.requestId
    });
}
