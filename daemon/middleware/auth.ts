export function checkAuth(token?: string): boolean {
    const required =
        (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CORTEXA_DAEMON_TOKEN;
    return !required || token === required;
}

function extractToken(req: { headers?: Record<string, unknown> }): string | undefined {
    const headers = req.headers ?? {};
    const direct = headers["x-cortexa-token"];
    if (typeof direct === "string" && direct.trim()) {
        return direct.trim();
    }

    const authHeader = headers.authorization;
    if (typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")) {
        return authHeader.slice(7).trim();
    }

    return undefined;
}

export function authMiddleware(req: any, res: any, next: () => void): void {
    const required =
        (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CORTEXA_DAEMON_TOKEN;

    if (!required || required === "replace-with-secure-token") {
        next();
        return;
    }

    const token = extractToken(req);
    if (!checkAuth(token)) {
        res.status(401).json({ ok: false, error: "unauthorized" });
        return;
    }

    next();
}
