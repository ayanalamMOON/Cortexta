import pino from "pino";
import type { DaemonObservabilityConfig } from "./config";

let daemonLogger: pino.Logger | null = null;

function createFallbackLogger(): pino.Logger {
    return pino({
        level: "info",
        enabled: true,
        base: {
            service: "cortexa-daemon"
        },
        timestamp: pino.stdTimeFunctions.isoTime
    });
}

export function configureDaemonLogger(config: DaemonObservabilityConfig): pino.Logger {
    daemonLogger = pino({
        level: config.logging.level,
        enabled: config.logging.enabled,
        base: {
            service: "cortexa-daemon"
        },
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: {
            level(label) {
                return { level: label };
            }
        }
    });

    return daemonLogger;
}

export function getDaemonLogger(): pino.Logger {
    if (!daemonLogger) {
        daemonLogger = createFallbackLogger();
    }

    return daemonLogger;
}

export function daemonChildLogger(bindings: Record<string, unknown>): pino.Logger {
    return getDaemonLogger().child(bindings);
}
