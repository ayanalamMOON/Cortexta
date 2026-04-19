import assert from "node:assert/strict";
import {
    configureDaemonMetrics,
    openInflightRequestMetric,
    recordHttpRequestMetric,
    recordSelfHealingRunMetric,
    renderMetrics,
    resetDaemonMetricsForTests
} from "../apps/daemon/src/observability/metrics";

async function main(): Promise<void> {
    configureDaemonMetrics({
        enabled: true,
        path: "/metrics",
        requireAuth: true,
        collectDefaultMetrics: false
    });

    resetDaemonMetricsForTests();

    const closeInflight = openInflightRequestMetric();
    recordHttpRequestMetric({
        method: "POST",
        route: "/cxlink/context",
        statusCode: 200,
        durationMs: 42
    });
    closeInflight();

    recordSelfHealingRunMetric({
        trigger: "manual",
        outcome: "dry-run-only",
        durationMs: 81,
        consecutiveFailures: 0
    });

    const metrics = await renderMetrics();

    assert.equal(typeof metrics.contentType, "string", "metrics content type should be provided");
    assert.ok(metrics.payload.includes("cortexa_daemon_http_requests_total"), "http request counter should be exported");
    assert.ok(
        metrics.payload.includes("cortexa_daemon_http_request_duration_seconds"),
        "http latency histogram should be exported"
    );
    assert.ok(
        metrics.payload.includes("cortexa_daemon_self_healing_runs_total"),
        "self-healing counter should be exported"
    );
    assert.ok(
        metrics.payload.includes("trigger=\"manual\",outcome=\"dry-run-only\""),
        "self-healing labels should include trigger/outcome dimensions"
    );

    console.log("✅ observability metrics unit tests passed");
}

main().catch((error) => {
    console.error("❌ observability metrics unit tests failed");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
