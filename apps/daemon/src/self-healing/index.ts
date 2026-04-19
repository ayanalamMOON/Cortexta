import {
    createSelfHealingScheduler,
    readSelfHealingConfigFromEnv,
    type SelfHealingRunOptions,
    type SelfHealingRunReport,
    type SelfHealingStatus
} from "./scheduler";

let scheduler = createSelfHealingScheduler(readSelfHealingConfigFromEnv());

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
    scheduler = createSelfHealingScheduler(readSelfHealingConfigFromEnv());
}
