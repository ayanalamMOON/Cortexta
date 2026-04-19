import { daemonChildLogger } from "../observability/logger";
import {
    recordSessionResurrectionRunMetric,
    setSessionResurrectionConsecutiveFailures
} from "../observability/metrics";
import { emitDaemonStreamEvent } from "../stream/events";
import {
    createSessionResurrectionScheduler,
    readSessionResurrectionConfigFromEnv,
    type SessionResurrectionRunOptions,
    type SessionResurrectionRunReport,
    type SessionResurrectionStatus
} from "./scheduler";

const schedulerLogger = daemonChildLogger({ component: "session-resurrection" });

function createScheduler() {
    return createSessionResurrectionScheduler(readSessionResurrectionConfigFromEnv(), {
        log: (level, message, payload) => {
            schedulerLogger[level](payload ?? {}, message);
        },
        onRunCompleted: (run, state) => {
            recordSessionResurrectionRunMetric({
                trigger: run.trigger,
                outcome: run.outcome,
                durationMs: run.durationMs,
                consecutiveFailures: state.consecutiveFailures
            });

            setSessionResurrectionConsecutiveFailures(state.consecutiveFailures);

            emitDaemonStreamEvent({
                projectId: run.projectId,
                eventType: "sessionResurrectionStatus",
                payload: {
                    runId: run.runId,
                    trigger: run.trigger,
                    status: run.outcome,
                    durationMs: run.durationMs,
                    dryRunOnly: run.dryRunOnly,
                    branch: run.branch,
                    filesScanned: run.ingestion?.filesScanned,
                    chatFilesScanned: run.ingestion?.chatFilesScanned,
                    graphNodesUpserted: run.graphIndex?.nodesUpserted,
                    graphEdgesUpserted: run.graphIndex?.edgesUpserted,
                    anomalies: run.audit?.anomalies?.total,
                    applyCompacted: run.applyBackfill?.compacted,
                    consecutiveFailures: state.consecutiveFailures
                },
                sessionId: `session-resurrection-${run.runId}`
            });

            schedulerLogger.info(
                {
                    runId: run.runId,
                    trigger: run.trigger,
                    outcome: run.outcome,
                    durationMs: run.durationMs,
                    runCount: state.runCount,
                    consecutiveFailures: state.consecutiveFailures
                },
                "session-resurrection.run.completed"
            );
        }
    });
}

let scheduler = createScheduler();

export function startSessionResurrectionScheduler(): void {
    scheduler.start();
}

export function stopSessionResurrectionScheduler(): void {
    scheduler.stop();
}

export function getSessionResurrectionStatus(): SessionResurrectionStatus {
    return scheduler.getStatus();
}

export async function triggerSessionResurrectionNow(
    options: SessionResurrectionRunOptions = {}
): Promise<SessionResurrectionRunReport> {
    return scheduler.triggerNow(options);
}

export function resetSessionResurrectionSchedulerForTests(): void {
    scheduler.stop();
    scheduler = createScheduler();
}
