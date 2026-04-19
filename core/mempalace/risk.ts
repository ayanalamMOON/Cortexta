import type { MemoryCompactionStats } from "./memory.types";

export type ProjectRiskLevel = "healthy" | "warning" | "critical";

export function resolveProjectRisk(stats: MemoryCompactionStats): ProjectRiskLevel {
    if (stats.integrityAnomalies.total > 0) {
        return "critical";
    }

    if (stats.totalRows >= 25 && stats.compactionRate < 0.5) {
        return "warning";
    }

    if (stats.totalRows >= 100 && stats.savedPercent < 5) {
        return "warning";
    }

    return "healthy";
}
