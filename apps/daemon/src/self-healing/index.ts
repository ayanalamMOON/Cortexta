import { daemonChildLogger } from "../observability/logger";
import {
    recordSelfHealingRunMetric,
    setSelfHealingConsecutiveFailures
} from "../observability/metrics";
import {
    createSelfHealingScheduler,
    readSelfHealingConfigFromEnv,
    type SelfHealingRunOptions,
    type SelfHealingRunReport,
    type SelfHealingStatus
} from "./scheduler";

const selfHealingLogger = daemonChildLogger({ component: "self-healing" });

function createScheduler() {
    return createSelfHealingScheduler(readSelfHealingConfigFromEnv(), {
        log: (level, message, payload) => {
            selfHealingLogger[level](payload ?? {}, message);
        },
        onRunCompleted: (run, state) => {
            recordSelfHealingRunMetric({
                trigger: run.trigger,
                outcome: run.outcome,
                durationMs: run.durationMs,
                consecutiveFailures: state.consecutiveFailures
            });

            setSelfHealingConsecutiveFailures(state.consecutiveFailures);

            selfHealingLogger.info(
                {
                    runId: run.runId,
                    trigger: run.trigger,
                    outcome: run.outcome,
                    durationMs: run.durationMs,
                    runCount: state.runCount,
                    consecutiveFailures: state.consecutiveFailures
                },
                "self-healing.run.completed"
            );
        }
    });
}

let scheduler = createScheduler();

export function startSelfHealingScheduler(): void {
    scheduler.start();
}

export function stopSelfHealingScheduler(): void {
    scheduler.stop();
}

export function getSelfHealingStatus(): SelfHealingStatus {
    return scheduler.getStatus();
}

export async function triggerSelfHealingNow(options: SelfHealingRunOptions = {}): Promise<SelfHealingRunReport> {
    return scheduler.triggerNow(options);
}

export function resetSelfHealingSchedulerForTests(): void {
    scheduler.stop();
    scheduler = createScheduler();
}
