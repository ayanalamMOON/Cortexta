import {
    collectDefaultMetrics,
    Counter,
    Gauge,
    Histogram,
    Registry
} from "prom-client";
import type { DaemonMetricsConfig } from "./config";

interface HttpRequestMetricInput {
    method: string;
    route: string;
    statusCode: number;
    durationMs: number;
}

interface SelfHealingRunMetricInput {
    trigger: string;
    outcome: string;
    durationMs: number;
    consecutiveFailures?: number;
}

const registry = new Registry();

const httpRequestsTotal = new Counter({
    name: "cortexa_daemon_http_requests_total",
    help: "Total number of HTTP requests handled by the daemon.",
    labelNames: ["method", "route", "status_code"] as const,
    registers: [registry]
});

const httpRequestDurationSeconds = new Histogram({
    name: "cortexa_daemon_http_request_duration_seconds",
    help: "HTTP request duration in seconds.",
    labelNames: ["method", "route", "status_code"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry]
});

const httpInflightRequests = new Gauge({
    name: "cortexa_daemon_http_inflight_requests",
    help: "Current in-flight HTTP requests.",
    registers: [registry]
});

const selfHealingRunsTotal = new Counter({
    name: "cortexa_daemon_self_healing_runs_total",
    help: "Total number of self-healing runs by trigger and outcome.",
    labelNames: ["trigger", "outcome"] as const,
    registers: [registry]
});

const selfHealingRunDurationSeconds = new Histogram({
    name: "cortexa_daemon_self_healing_run_duration_seconds",
    help: "Self-healing run duration in seconds by trigger and outcome.",
    labelNames: ["trigger", "outcome"] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
    registers: [registry]
});

const selfHealingConsecutiveFailuresGauge = new Gauge({
    name: "cortexa_daemon_self_healing_consecutive_failures",
    help: "Current consecutive self-healing failures.",
    registers: [registry]
});

let metricsConfig: DaemonMetricsConfig = {
    enabled: true,
    path: "/metrics",
    requireAuth: true,
    collectDefaultMetrics: true
};

let defaultMetricsCollected = false;

export function configureDaemonMetrics(config: DaemonMetricsConfig): void {
    metricsConfig = { ...config };

    if (!metricsConfig.enabled || defaultMetricsCollected || !metricsConfig.collectDefaultMetrics) {
        return;
    }

    collectDefaultMetrics({
        register: registry,
        prefix: "cortexa_daemon_process_"
    });
    defaultMetricsCollected = true;
}

export function areMetricsEnabled(): boolean {
    return metricsConfig.enabled;
}

export function metricsRequireAuth(): boolean {
    return metricsConfig.requireAuth;
}

export function metricsPath(): string {
    return metricsConfig.path;
}

export function openInflightRequestMetric(): () => void {
    if (!metricsConfig.enabled) {
        return () => undefined;
    }

    httpInflightRequests.inc();
    let closed = false;

    return () => {
        if (closed) {
            return;
        }
        closed = true;
        httpInflightRequests.dec();
    };
}

export function normalizeRouteLabel(path: string): string {
    const sanitized = path
        .replace(/[0-9a-f]{8,}/gi, ":id")
        .replace(/\/+/g, "/")
        .slice(0, 180);

    return sanitized || "unknown";
}

export function recordHttpRequestMetric(input: HttpRequestMetricInput): void {
    if (!metricsConfig.enabled) {
        return;
    }

    const method = input.method.trim().toUpperCase() || "UNKNOWN";
    const route = normalizeRouteLabel(input.route);
    const statusCode = Number.isFinite(input.statusCode) ? String(Math.trunc(input.statusCode)) : "0";
    const durationSeconds = Math.max(0, input.durationMs) / 1000;

    httpRequestsTotal.labels(method, route, statusCode).inc();
    httpRequestDurationSeconds.labels(method, route, statusCode).observe(durationSeconds);
}

export function recordSelfHealingRunMetric(input: SelfHealingRunMetricInput): void {
    if (!metricsConfig.enabled) {
        return;
    }

    const trigger = input.trigger.trim() || "unknown";
    const outcome = input.outcome.trim() || "unknown";

    selfHealingRunsTotal.labels(trigger, outcome).inc();
    selfHealingRunDurationSeconds.labels(trigger, outcome).observe(Math.max(0, input.durationMs) / 1000);

    if (typeof input.consecutiveFailures === "number" && Number.isFinite(input.consecutiveFailures)) {
        selfHealingConsecutiveFailuresGauge.set(Math.max(0, Math.trunc(input.consecutiveFailures)));
    }
}

export function setSelfHealingConsecutiveFailures(value: number): void {
    if (!metricsConfig.enabled) {
        return;
    }

    if (!Number.isFinite(value)) {
        return;
    }

    selfHealingConsecutiveFailuresGauge.set(Math.max(0, Math.trunc(value)));
}

export async function renderMetrics(): Promise<{ contentType: string; payload: string }> {
    return {
        contentType: registry.contentType,
        payload: await registry.metrics()
    };
}

export function resetDaemonMetricsForTests(): void {
    registry.resetMetrics();
    selfHealingConsecutiveFailuresGauge.set(0);
}
