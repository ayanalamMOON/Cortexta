function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return typeof error === "string" ? error : String(error);
}

export function sendJson(
    res: any,
    status: number,
    body: Record<string, unknown>
): void {
    res.status(status).json(body);
}

export function sendOk(res: any, body: Record<string, unknown>): void {
    sendJson(res, 200, { ok: true, ...body });
}

export function sendBadRequest(res: any, error: string, extra?: Record<string, unknown>): void {
    sendJson(res, 400, { ok: false, error, ...extra });
}

export function sendUnauthorized(res: any, extra?: Record<string, unknown>): void {
    sendJson(res, 401, { ok: false, error: "unauthorized", ...extra });
}

export function sendInternalError(res: any, error: unknown, extra?: Record<string, unknown>): void {
    sendJson(res, 500, { ok: false, error: getErrorMessage(error), ...extra });
}

export function getDaemonErrorMessage(error: unknown): string {
    return getErrorMessage(error);
}
