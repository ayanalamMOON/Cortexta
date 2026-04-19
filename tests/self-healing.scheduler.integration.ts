import assert from "node:assert/strict";
import {
    createSelfHealingScheduler,
    evaluateSelfHealingApplyDecision,
    isWithinApplyWindow,
    type SelfHealingConfig
} from "../apps/daemon/src/self-healing/scheduler";
import type {
    BackfillMemoryCompactionResult,
    MemoryResurrectionAuditReport
} from "../core/mempalace/memory.types";

function uniqueProjectId(prefix: string): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${ts}-${rand}`;
}

function baseConfig(overrides: Partial<SelfHealingConfig> = {}): SelfHealingConfig {
    return {
        enabled: true,
        projectId: "self-heal-test",
        intervalMs: 60_000,
        jitterMs: 0,
        runOnStart: false,
        auditLimit: 5000,
        auditMaxIssues: 20,
        backfillLimit: 5000,
        applyEnabled: true,
        maxAllowedAnomalies: 0,
        minCompactionOpportunityRate: 0.2,
        minDryRunCompactedRows: 50,
        maxApplyRows: 100,
        applyWindowStartHour: 0,
        applyWindowEndHour: 0,
        historyLimit: 25,
        persistHistory: false,
        persistedHistoryLimit: 200,
        backoffEnabled: true,
        backoffMultiplier: 2,
        maxBackoffIntervalMs: 6 * 60 * 60 * 1000,
        sloWindowsMinutes: [60, 24 * 60, 7 * 24 * 60],
        ...overrides
    };
}

function auditReport(overrides: Partial<MemoryResurrectionAuditReport> = {}): MemoryResurrectionAuditReport {
    return {
        projectId: "self-heal-test",
        scannedRows: 500,
        compactedRows: 350,
        plainRows: 150,
        validCompactedRows: 350,
        anomalies: {
            invalidChecksum: 0,
            decodeError: 0,
            total: 0
        },
        anomalyRate: 0,
        compactionOpportunityRate: 0.3,
        issueSamples: [],
        recommendations: ["baseline"],
        ...overrides
    };
}

function backfillResult(overrides: Partial<BackfillMemoryCompactionResult> = {}): BackfillMemoryCompactionResult {
    return {
        projectId: "self-heal-test",
        dryRun: true,
        scanned: 500,
        eligible: 150,
        compacted: 120,
        skipped: 380,
        savedChars: 42_000,
        ...overrides
    };
}

function testApplyWindow(): void {
    const noon = new Date(2026, 3, 18, 12, 0, 0, 0).getTime();

    assert.equal(isWithinApplyWindow(noon, 0, 0), true, "same start/end hour means always allowed");
    assert.equal(isWithinApplyWindow(noon, 10, 13), true, "hour range should include noon");
    assert.equal(isWithinApplyWindow(noon, 1, 4), false, "hour range outside noon should block apply");
    assert.equal(isWithinApplyWindow(noon, 22, 3), false, "cross-midnight window should block noon");
}

function testDecisionGuardrails(): void {
    const now = new Date(2026, 3, 18, 12, 0, 0, 0).getTime();

    const blockedByAnomaly = evaluateSelfHealingApplyDecision({
        config: baseConfig(),
        audit: auditReport({
            anomalies: {
                invalidChecksum: 1,
                decodeError: 0,
                total: 1
            }
        }),
        dryRun: backfillResult(),
        nowMs: now
    });

    assert.equal(blockedByAnomaly.allowApply, false, "anomaly guardrail should block apply");
    assert.ok(
        blockedByAnomaly.reasons.some((reason) => reason.toLowerCase().includes("anomaly")),
        "anomaly block reason should be present"
    );

    const blockedByWindow = evaluateSelfHealingApplyDecision({
        config: baseConfig({
            applyWindowStartHour: 1,
            applyWindowEndHour: 4
        }),
        audit: auditReport(),
        dryRun: backfillResult(),
        nowMs: now
    });

    assert.equal(blockedByWindow.allowApply, false, "apply window should gate apply execution");
    assert.ok(
        blockedByWindow.reasons.some((reason) => reason.toLowerCase().includes("outside apply window")),
        "window block reason should be present"
    );

    const blockedByOpportunity = evaluateSelfHealingApplyDecision({
        config: baseConfig({
            minCompactionOpportunityRate: 0.5
        }),
        audit: auditReport({
            compactionOpportunityRate: 0.2
        }),
        dryRun: backfillResult(),
        nowMs: now
    });

    assert.equal(blockedByOpportunity.allowApply, false, "opportunity threshold should gate apply");

    const blockedByDryRunOnly = evaluateSelfHealingApplyDecision({
        config: baseConfig(),
        audit: auditReport(),
        dryRun: backfillResult(),
        nowMs: now,
        dryRunOnly: true
    });

    assert.equal(blockedByDryRunOnly.allowApply, false, "manual dry-run-only mode should block apply");
}

async function testSchedulerRunFlow(): Promise<void> {
    const now = new Date(2026, 3, 18, 12, 0, 0, 0).getTime();
    const calls: Array<{ dryRun: boolean; limit?: number }> = [];

    const scheduler = createSelfHealingScheduler(baseConfig(), {
        now: () => now,
        random: () => 0,
        audit: () => auditReport(),
        backfill: (options) => {
            calls.push({ dryRun: options.dryRun !== false, limit: options.limit });

            if (options.dryRun === false) {
                return backfillResult({
                    dryRun: false,
                    compacted: 80,
                    savedChars: 30_000
                });
            }

            return backfillResult({
                dryRun: true,
                compacted: 120,
                savedChars: 45_000
            });
        },
        log: () => {
            // mute logs in tests
        }
    });

    const report = await scheduler.triggerNow({ reason: "integration-apply-check" });

    assert.equal(report.trigger, "manual", "manual trigger should be reported");
    assert.equal(report.outcome, "applied", "apply path should execute when gates pass");
    assert.equal(calls.length, 2, "audit run should perform dry-run then apply backfill");
    assert.equal(calls[0]?.dryRun, true, "first backfill call should be dry-run");
    assert.equal(calls[1]?.dryRun, false, "second backfill call should be apply");
    assert.equal(calls[1]?.limit, 100, "apply call should be bounded by maxApplyRows gate");

    const status = scheduler.getStatus();
    assert.equal(status.runCount, 1, "run count should increase after manual trigger");
    assert.equal(status.lastRun?.outcome, "applied", "status should keep latest run outcome");

    const dryRunOnlyReport = await scheduler.triggerNow({
        reason: "integration-dry-run-only",
        dryRunOnly: true
    });

    assert.equal(dryRunOnlyReport.outcome, "dry-run-only", "dry-run-only trigger should never apply");
    assert.ok(
        dryRunOnlyReport.decision.reasons.some((reason) => reason.toLowerCase().includes("dry-run only")),
        "dry-run-only decision reason should be included"
    );

    const statusAfterSecondRun = scheduler.getStatus();
    assert.equal(statusAfterSecondRun.runCount, 2, "run count should include second trigger");
}

async function testExponentialBackoffProgression(): Promise<void> {
    let now = new Date(2026, 3, 18, 12, 0, 0, 0).getTime();
    let attempts = 0;

    const scheduler = createSelfHealingScheduler(
        baseConfig({
            intervalMs: 1000,
            jitterMs: 0,
            backoffMultiplier: 2,
            maxBackoffIntervalMs: 8000,
            runOnStart: false
        }),
        {
            now: () => now,
            random: () => 0,
            audit: () => {
                attempts += 1;
                if (attempts <= 3) {
                    throw new Error(`simulated-failure-${attempts}`);
                }

                return auditReport();
            },
            backfill: (options) => {
                if (options.dryRun === false) {
                    return backfillResult({
                        dryRun: false,
                        compacted: 10,
                        savedChars: 10_000
                    });
                }

                return backfillResult({
                    dryRun: true,
                    compacted: 100,
                    savedChars: 20_000
                });
            },
            log: () => {
                // mute logs in tests
            }
        }
    );

    scheduler.start();
    assert.equal(
        scheduler.getStatus().lastScheduledDelayMs,
        1000,
        "initial schedule should use baseline interval when there are no failures"
    );
    scheduler.stop();

    await scheduler.triggerNow({ reason: "backoff-1" });
    assert.equal(scheduler.getStatus().consecutiveFailures, 1, "first error should increment consecutive failure count");
    scheduler.start();
    assert.equal(
        scheduler.getStatus().lastScheduledDelayMs,
        1000,
        "first consecutive error should keep baseline interval before multiplier expansion"
    );
    scheduler.stop();

    now += 1000;
    await scheduler.triggerNow({ reason: "backoff-2" });
    assert.equal(scheduler.getStatus().consecutiveFailures, 2, "second error should increment consecutive failure count");
    scheduler.start();
    assert.equal(
        scheduler.getStatus().lastScheduledDelayMs,
        2000,
        "second consecutive error should double interval"
    );
    scheduler.stop();

    now += 1000;
    await scheduler.triggerNow({ reason: "backoff-3" });
    assert.equal(scheduler.getStatus().consecutiveFailures, 3, "third error should increment consecutive failure count");
    scheduler.start();
    assert.equal(
        scheduler.getStatus().lastScheduledDelayMs,
        4000,
        "third consecutive error should apply exponential backoff"
    );
    scheduler.stop();

    now += 1000;
    await scheduler.triggerNow({ reason: "backoff-recovery" });
    assert.equal(scheduler.getStatus().consecutiveFailures, 0, "successful run should reset failure streak");
    scheduler.start();
    assert.equal(
        scheduler.getStatus().lastScheduledDelayMs,
        1000,
        "post-recovery schedule should return to baseline interval"
    );
    scheduler.stop();
}

async function testSloRollingWindows(): Promise<void> {
    const anchorNow = new Date(2026, 3, 18, 12, 0, 0, 0).getTime();
    let now = anchorNow;
    let callCount = 0;

    const scheduler = createSelfHealingScheduler(
        baseConfig({
            projectId: uniqueProjectId("self-heal-slo"),
            persistHistory: false,
            sloWindowsMinutes: [60, 180]
        }),
        {
            now: () => now,
            random: () => 0,
            audit: () => {
                callCount += 1;
                if (callCount === 3) {
                    throw new Error("simulated-slo-error");
                }

                return auditReport();
            },
            backfill: (options) => {
                if (options.dryRun === false) {
                    return backfillResult({
                        dryRun: false,
                        compacted: 80,
                        savedChars: 20_000
                    });
                }

                return backfillResult({
                    dryRun: true,
                    compacted: 120,
                    savedChars: 45_000
                });
            },
            log: () => {
                // mute logs in tests
            }
        }
    );

    now = anchorNow - 170 * 60 * 1000;
    const appliedRun = await scheduler.triggerNow({ reason: "slo-applied" });
    assert.equal(appliedRun.outcome, "applied", "first run should be applied for SLO mix");

    now = anchorNow - 50 * 60 * 1000;
    const dryRunOnlyRun = await scheduler.triggerNow({
        reason: "slo-dry-run-only",
        dryRunOnly: true
    });
    assert.equal(dryRunOnlyRun.outcome, "dry-run-only", "second run should be dry-run-only for SLO mix");

    now = anchorNow - 10 * 60 * 1000;
    const errorRun = await scheduler.triggerNow({ reason: "slo-error" });
    assert.equal(errorRun.outcome, "error", "third run should be error for SLO mix");

    now = anchorNow;
    const status = scheduler.getStatus();

    const sixtyMinuteWindow = status.slo.windows.find((window) => window.windowMinutes === 60);
    assert.ok(sixtyMinuteWindow, "60-minute SLO window should be present");
    assert.equal(sixtyMinuteWindow?.total, 2, "60-minute SLO window should include dry-run-only + error runs");
    assert.equal(sixtyMinuteWindow?.applied, 0, "60-minute SLO window should exclude old applied run");
    assert.equal(sixtyMinuteWindow?.dryRunOnly, 1, "60-minute SLO window should count one dry-run-only run");
    assert.equal(sixtyMinuteWindow?.error, 1, "60-minute SLO window should count one error run");

    const oneHundredEightyMinuteWindow = status.slo.windows.find((window) => window.windowMinutes === 180);
    assert.ok(oneHundredEightyMinuteWindow, "180-minute SLO window should be present");
    assert.equal(oneHundredEightyMinuteWindow?.total, 3, "180-minute SLO window should include all three runs");
    assert.equal(oneHundredEightyMinuteWindow?.applied, 1, "180-minute SLO window should count applied run");
    assert.equal(oneHundredEightyMinuteWindow?.dryRunOnly, 1, "180-minute SLO window should count dry-run-only run");
    assert.equal(oneHundredEightyMinuteWindow?.error, 1, "180-minute SLO window should count error run");
}

async function testPersistedHistoryAcrossSchedulerInstances(): Promise<void> {
    const projectId = uniqueProjectId("self-heal-persist");
    let now = new Date(2026, 3, 18, 12, 0, 0, 0).getTime();

    const config = baseConfig({
        projectId,
        persistHistory: true,
        historyLimit: 10,
        persistedHistoryLimit: 25
    });

    const services = {
        now: () => now,
        random: () => 0,
        audit: () => auditReport({ projectId }),
        backfill: (options: { dryRun?: boolean }) => {
            if (options.dryRun === false) {
                return backfillResult({
                    projectId,
                    dryRun: false,
                    compacted: 40,
                    savedChars: 18_000
                });
            }

            return backfillResult({
                projectId,
                dryRun: true,
                compacted: 90,
                savedChars: 30_000
            });
        },
        log: () => {
            // mute logs in tests
        }
    };

    const schedulerA = createSelfHealingScheduler(config, services);
    const firstRun = await schedulerA.triggerNow({ reason: "persisted-history-1" });
    now += 1000;
    const secondRun = await schedulerA.triggerNow({
        reason: "persisted-history-2",
        dryRunOnly: true
    });

    const statusA = schedulerA.getStatus();
    assert.equal(statusA.runCount, 2, "first scheduler instance should record two runs");
    assert.equal(statusA.lastRun?.runId, secondRun.runId, "first scheduler should keep latest run as lastRun");

    const schedulerB = createSelfHealingScheduler(config, services);
    const statusB = schedulerB.getStatus();

    assert.equal(statusB.runCount, 2, "second scheduler instance should hydrate persisted run count");
    assert.equal(statusB.lastRun?.runId, secondRun.runId, "second scheduler should hydrate latest persisted run");
    assert.ok(
        statusB.recentRuns.some((run) => run.runId === firstRun.runId),
        "second scheduler should hydrate older persisted run"
    );
    assert.ok(
        statusB.recentRuns.some((run) => run.runId === secondRun.runId),
        "second scheduler should hydrate newest persisted run"
    );
}

async function main(): Promise<void> {
    testApplyWindow();
    testDecisionGuardrails();
    await testSchedulerRunFlow();
    await testExponentialBackoffProgression();
    await testSloRollingWindows();
    await testPersistedHistoryAcrossSchedulerInstances();
    console.log("✅ self-healing scheduler integration test passed");
}

main().catch((error) => {
    console.error("❌ self-healing scheduler integration test failed");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
