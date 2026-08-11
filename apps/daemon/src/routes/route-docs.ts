export interface DaemonRouteDoc {
    method: "GET" | "POST";
    path: string;
    summary: string;
    auth: "public" | "token";
}

export const DAEMON_ROUTE_DOCS: DaemonRouteDoc[] = [
    { method: "GET", path: "/health", summary: "Liveness and subsystem health payload.", auth: "public" },
    { method: "GET", path: "/ready", summary: "Readiness probe with scheduler/stream state.", auth: "public" },
    { method: "GET", path: "/info", summary: "Daemon runtime and observability configuration.", auth: "public" },
    { method: "GET", path: "/version", summary: "Daemon version and runtime fingerprint.", auth: "public" },
    { method: "GET", path: "/routes", summary: "Compact route catalog (method/path/public).", auth: "public" },
    { method: "GET", path: "/routes/docs", summary: "Human-oriented route documentation.", auth: "public" },
    { method: "POST", path: "/ingest", summary: "Run ingestion pipeline for a workspace path.", auth: "token" },
    { method: "POST", path: "/query", summary: "Retrieve relevant memories for a query.", auth: "token" },
    { method: "POST", path: "/context", summary: "Compile bounded context for a query.", auth: "token" },
    { method: "POST", path: "/context/suggest", summary: "Generate proactive context suggestions.", auth: "token" },
    { method: "POST", path: "/context/stream/start", summary: "Start live context stream watcher.", auth: "token" },
    { method: "POST", path: "/context/stream/stop", summary: "Stop live context stream watcher.", auth: "token" },
    { method: "POST", path: "/context/stream/status", summary: "Read live context stream status.", auth: "token" },
    { method: "POST", path: "/context/stream/ack", summary: "Acknowledge stream suggestion lifecycle.", auth: "token" },
    { method: "POST", path: "/cxlink/*", summary: "CxLink orchestration, diagnostics, and control routes.", auth: "token" },
    { method: "POST", path: "/evolve", summary: "Memory evolution and consolidation entrypoint.", auth: "token" },
    { method: "POST", path: "/evolve/progression", summary: "Progression-mode memory evolution endpoint.", auth: "token" }
];

export function listDaemonRouteDocs(): DaemonRouteDoc[] {
    return DAEMON_ROUTE_DOCS.map((route) => ({ ...route }));
}
