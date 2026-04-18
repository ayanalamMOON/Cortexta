export const logger = {
    info: (...args: unknown[]) => console.log("[cortexa]", ...args),
    warn: (...args: unknown[]) => console.warn("[cortexa]", ...args),
    error: (...args: unknown[]) => console.error("[cortexa]", ...args)
};
