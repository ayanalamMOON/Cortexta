import { startDaemon } from "../../daemon/server";
import { logger } from "../utils/logger";

let daemonHandle: { close: (cb?: () => void) => void } | null = null;

function daemonPort(): number {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    return Number(env?.CORTEXA_DAEMON_PORT ?? 4312);
}

export async function daemonCommand(action: "start" | "stop" | "status"): Promise<void> {
    if (action === "start") {
        if (daemonHandle) {
            logger.warn("Daemon already running in this process.");
            return;
        }

        daemonHandle = startDaemon(daemonPort());
        logger.info(`Daemon started on port ${daemonPort()}.`);
        return;
    }

    if (action === "stop") {
        if (!daemonHandle) {
            logger.warn("No daemon handle in this process. Stop externally if started elsewhere.");
            return;
        }

        await new Promise<void>((resolve) => daemonHandle?.close(resolve));
        daemonHandle = null;
        logger.info("Daemon stopped.");
        return;
    }

    try {
        const response = await fetch(`http://localhost:${daemonPort()}/health`);
        if (!response.ok) {
            logger.warn(`Daemon health endpoint responded with status ${response.status}.`);
            return;
        }
        const body = await response.json();
        logger.info("Daemon status:", body);
    } catch {
        logger.warn("Daemon appears offline.");
    }
}
