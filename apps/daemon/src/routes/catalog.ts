export interface DaemonRouteDescriptor {
    method: "GET" | "POST";
    path: string;
    public: boolean;
}

export const DAEMON_ROUTE_CATALOG: DaemonRouteDescriptor[] = [
    { method: "GET", path: "/health", public: true },
    { method: "GET", path: "/ready", public: true },
    { method: "GET", path: "/info", public: true },
    { method: "GET", path: "/version", public: true },
    { method: "GET", path: "/routes", public: true },
    { method: "GET", path: "/routes/docs", public: true },
    { method: "POST", path: "/ingest", public: false },
    { method: "POST", path: "/query", public: false },
    { method: "POST", path: "/context", public: false },
    { method: "POST", path: "/context/suggest", public: false },
    { method: "POST", path: "/context/stream/start", public: false },
    { method: "POST", path: "/context/stream/stop", public: false },
    { method: "POST", path: "/context/stream/status", public: false },
    { method: "POST", path: "/context/stream/ack", public: false },
    { method: "POST", path: "/cxlink/*", public: false },
    { method: "POST", path: "/evolve", public: false },
    { method: "POST", path: "/evolve/progression", public: false }
];

export function listDaemonRoutes(): DaemonRouteDescriptor[] {
    return DAEMON_ROUTE_CATALOG.map((route) => ({ ...route }));
}
