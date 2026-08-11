function readEnv(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

export interface DaemonRuntimeInfo {
    service: string;
    packageName: string;
    version: string;
    nodeVersion: string;
    pid: number;
}

export function getDaemonRuntimeInfo(): DaemonRuntimeInfo {
    return {
        service: "cortexa-daemon",
        packageName: readEnv("npm_package_name") ?? "@cortexa/daemon",
        version: readEnv("npm_package_version") ?? "dev",
        nodeVersion: process.version,
        pid: process.pid
    };
}
