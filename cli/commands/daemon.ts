import { startDaemon } from "../../daemon/server";
import { logger } from "../utils/logger";

let daemonHandle: { close: (cb?: () => void) => void } | null = null;

export function hasInProcessDaemon(): boolean {
    return daemonHandle !== null;
}

function daemonPort(): number {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    return Number(env?.CORTEXA_DAEMON_PORT ?? 4312);
}

async function isDaemonOnline(port: number): Promise<boolean> {
    try {
        const response = await fetch(`http://localhost:${port}/health`);
        return response.ok;
    } catch {
        return false;
    }
}

export async function daemonCommand(action: "start" | "stop" | "status"): Promise<void> {
    if (action === "start") {
        if (daemonHandle) {
            logger.warn("Daemon already running in this process.");
            return;
        }

        const port = daemonPort();

        if (await isDaemonOnline(port)) {
            logger.warn(`Daemon already responding on port ${port}.`);
            logger.info("Use `cortexa daemon status` to inspect it.");
            return;
        }

        try {
            daemonHandle = startDaemon(port);
            logger.info(`Daemon started on port ${port}.`);
        } catch (error) {
            daemonHandle = null;
            const message = error instanceof Error ? error.message : String(error);

            if (message.includes("EADDRINUSE")) {
                logger.error(`Failed to start daemon on port ${port}: address is already in use.`);
                logger.info("If another daemon instance is running, use `cortexa daemon status`.");
                return;
            }

            logger.error(`Failed to start daemon on port ${port}: ${message}`);
        }

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
