type Level = "debug" | "info" | "warn" | "error";

function readEnv(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

function shouldLog(level: Level): boolean {
    const configured = (readEnv("CORTEXA_LOG_LEVEL") ?? "info").toLowerCase();
    const order: Level[] = ["debug", "info", "warn", "error"];
    return order.indexOf(level) >= order.indexOf(configured as Level);
}

function emit(level: Level, args: unknown[]): void {
    if (!shouldLog(level)) return;
    const ts = new Date().toISOString();
    const prefix = `[cortexa:cli][${level.toUpperCase()}][${ts}]`;

    if (level === "error") {
        console.error(prefix, ...args);
        return;
    }

    if (level === "warn") {
        console.warn(prefix, ...args);
        return;
    }

    console.log(prefix, ...args);
}

export const logger = {
    debug: (...args: unknown[]) => emit("debug", args),
    info: (...args: unknown[]) => emit("info", args),
    warn: (...args: unknown[]) => emit("warn", args),
    error: (...args: unknown[]) => emit("error", args)
};
