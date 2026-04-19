import { createDaemonApp as createModernDaemonApp, startDaemon as startModernDaemon } from "../apps/daemon/src/server";
import { toPort } from "../core/daemon/http";

function readEnv(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

export const createDaemonApp = createModernDaemonApp;

export function startDaemon(
    port = toPort(readEnv("CORTEXA_DAEMON_PORT"), 4312),
    wsPort = toPort(readEnv("CORTEXA_WS_PORT"), 4321)
) {
    return startModernDaemon(port, wsPort);
}

const shouldAutoStart = readEnv("CORTEXA_DAEMON_AUTOSTART") !== "0";

if (shouldAutoStart && require.main === module) {
    startDaemon();
}
