import { toBoolean, toBoundedInt, toTrimmedString } from "../../../../core/daemon/http";

export type DaemonLogFormat = "json";

export interface DaemonLoggingConfig {
    enabled: boolean;
    level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
    format: DaemonLogFormat;
}

export interface DaemonMetricsConfig {
    enabled: boolean;
    path: string;
    requireAuth: boolean;
    collectDefaultMetrics: boolean;
}

export interface DaemonRateLimitConfig {
    enabled: boolean;
    windowMs: number;
    maxRequests: number;
}

export interface DaemonObservabilityConfig {
    logging: DaemonLoggingConfig;
    metrics: DaemonMetricsConfig;
    rateLimit: DaemonRateLimitConfig;
}

const DEFAULT_OBSERVABILITY_CONFIG: DaemonObservabilityConfig = {
    logging: {
        enabled: true,
        level: "info",
        format: "json"
    },
    metrics: {
        enabled: true,
        path: "/metrics",
        requireAuth: true,
        collectDefaultMetrics: true
    },
    rateLimit: {
        enabled: true,
        windowMs: 60_000,
        maxRequests: 240
    }
};

function readEnv(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

function normalizeLogLevel(value: string | undefined): DaemonLoggingConfig["level"] {
    const normalized = value?.trim().toLowerCase();
    if (
        normalized === "trace" ||
        normalized === "debug" ||
        normalized === "info" ||
        normalized === "warn" ||
        normalized === "error" ||
        normalized === "fatal"
    ) {
        return normalized;
    }

    return DEFAULT_OBSERVABILITY_CONFIG.logging.level;
}

function normalizeMetricsPath(value: string | undefined): string {
    const trimmed = toTrimmedString(value, 128);
    if (!trimmed) {
        return DEFAULT_OBSERVABILITY_CONFIG.metrics.path;
    }

    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function readDaemonObservabilityConfigFromEnv(): DaemonObservabilityConfig {
    return {
        logging: {
            enabled: toBoolean(readEnv("CORTEXA_LOG_ENABLED"), DEFAULT_OBSERVABILITY_CONFIG.logging.enabled),
            level: normalizeLogLevel(readEnv("CORTEXA_LOG_LEVEL")),
            format: "json"
        },
        metrics: {
            enabled: toBoolean(readEnv("CORTEXA_METRICS_ENABLED"), DEFAULT_OBSERVABILITY_CONFIG.metrics.enabled),
            path: normalizeMetricsPath(readEnv("CORTEXA_METRICS_PATH")),
            requireAuth: toBoolean(
                readEnv("CORTEXA_METRICS_REQUIRE_AUTH"),
                DEFAULT_OBSERVABILITY_CONFIG.metrics.requireAuth
            ),
            collectDefaultMetrics: toBoolean(
                readEnv("CORTEXA_METRICS_COLLECT_DEFAULTS"),
                DEFAULT_OBSERVABILITY_CONFIG.metrics.collectDefaultMetrics
            )
        },
        rateLimit: {
            enabled: toBoolean(
                readEnv("CORTEXA_DAEMON_RATE_LIMIT_ENABLED"),
                DEFAULT_OBSERVABILITY_CONFIG.rateLimit.enabled
            ),
            windowMs:
                toBoundedInt(
                    readEnv("CORTEXA_DAEMON_RATE_LIMIT_WINDOW_MS"),
                    1_000,
                    24 * 60 * 60 * 1000
                ) ?? DEFAULT_OBSERVABILITY_CONFIG.rateLimit.windowMs,
            maxRequests:
                toBoundedInt(readEnv("CORTEXA_DAEMON_RATE_LIMIT_MAX"), 1, 1_000_000) ??
                DEFAULT_OBSERVABILITY_CONFIG.rateLimit.maxRequests
        }
    };
}
