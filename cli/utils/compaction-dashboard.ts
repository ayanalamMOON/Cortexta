import type {
    MemoryCompactionDashboardPayload,
    MemoryCompactionProjectBreakdownItem,
    MemoryCompactionTrendSnapshot
} from "../../core/mempalace/memory.types";

export interface DashboardRenderOptions {
    topProjects?: number;
    trendRows?: number;
    persistSnapshot?: boolean;
}

function formatNumber(value: number): string {
    return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(value: number, decimals = 2): string {
    return `${value.toFixed(decimals)}%`;
}

function formatRate(value: number, decimals = 2): string {
    return `${(value * 100).toFixed(decimals)}%`;
}

function formatDelta(value: number, decimals = 2): string {
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(decimals)}`;
}

function formatDateTime(timestamp: number | undefined): string {
    if (!timestamp || !Number.isFinite(timestamp) || timestamp <= 0) {
        return "-";
    }

    return new Date(timestamp).toISOString().replace("T", " ").replace(".000Z", "Z");
}

function takeLatestTrendRows(rows: MemoryCompactionTrendSnapshot[], limit: number): MemoryCompactionTrendSnapshot[] {
    if (rows.length <= limit) {
        return rows;
    }

    return rows.slice(rows.length - limit);
}

function renderTable(headers: string[], rows: string[][]): string[] {
    if (headers.length === 0) {
        return [];
    }

    const widths = headers.map((header) => header.length);

    for (const row of rows) {
        for (let index = 0; index < headers.length; index += 1) {
            const value = row[index] ?? "";
            widths[index] = Math.max(widths[index], value.length);
        }
    }

    const padRow = (row: string[]): string =>
        row
            .map((cell, index) => (cell ?? "").padEnd(widths[index]))
            .join(" | ");

    const separator = widths.map((width) => "-".repeat(width)).join("-+-");

    return [padRow(headers), separator, ...rows.map((row) => padRow(row))];
}

function riskTag(project: MemoryCompactionProjectBreakdownItem): string {
    switch (project.riskLevel) {
        case "critical":
            return "CRITICAL";
        case "warning":
            return "WARNING";
        default:
            return "HEALTHY";
    }
}

function renderTrendSection(
    title: string,
    snapshots: MemoryCompactionTrendSnapshot[],
    trendRows: number
): string[] {
    const lines: string[] = [];
    lines.push(title);

    if (snapshots.length === 0) {
        lines.push("  (no snapshots)");
        return lines;
    }

    const oldest = snapshots[0];
    const newest = snapshots[snapshots.length - 1];
    const deltaSaved = newest.savedPercent - oldest.savedPercent;
    const deltaCompaction = (newest.compactionRate - oldest.compactionRate) * 100;
    const deltaAnomalies = newest.integrityAnomalyTotal - oldest.integrityAnomalyTotal;

    lines.push(
        `  window: ${formatDateTime(oldest.createdAt)} -> ${formatDateTime(newest.createdAt)} (${snapshots.length} points)`
    );
    lines.push(
        `  delta: saved=${formatDelta(deltaSaved)}pp compaction=${formatDelta(deltaCompaction)}pp anomalies=${deltaAnomalies >= 0 ? "+" : ""}${deltaAnomalies}`
    );

    const latestRows = takeLatestTrendRows(snapshots, trendRows).map((snapshot) => [
        formatDateTime(snapshot.createdAt),
        formatNumber(snapshot.totalRows),
        formatRate(snapshot.compactionRate),
        formatPercent(snapshot.savedPercent),
        formatNumber(snapshot.integrityAnomalyTotal)
    ]);

    const table = renderTable(["timestamp", "rows", "compaction", "saved", "anomalies"], latestRows);
    for (const row of table) {
        lines.push(`  ${row}`);
    }

    return lines;
}

function renderProjectSection(projects: MemoryCompactionProjectBreakdownItem[], topProjects: number): string[] {
    const lines: string[] = [];
    lines.push("Per-project breakdown");

    if (projects.length === 0) {
        lines.push("  (no project rows)");
        return lines;
    }

    const selected = projects.slice(0, topProjects);
    const rows = selected.map((project, index) => [
        String(index + 1),
        project.projectId,
        riskTag(project),
        formatNumber(project.stats.totalRows),
        formatRate(project.stats.compactionRate),
        formatPercent(project.stats.savedPercent),
        formatNumber(project.stats.integrityAnomalies.total),
        formatDateTime(project.lastAccessedAt)
    ]);

    const table = renderTable(
        ["#", "project", "risk", "rows", "compaction", "saved", "anomalies", "lastAccess"],
        rows
    );

    for (const row of table) {
        lines.push(`  ${row}`);
    }

    return lines;
}

export function renderCompactionDashboardHuman(
    dashboard: MemoryCompactionDashboardPayload,
    options: DashboardRenderOptions = {}
): string {
    const topProjects = Math.min(500, Math.max(1, Math.trunc(options.topProjects ?? 12)));
    const trendRows = Math.min(250, Math.max(1, Math.trunc(options.trendRows ?? 8)));
    const persistSnapshot = options.persistSnapshot !== false;

    const lines: string[] = [];

    lines.push("CORTEXA COMPACTION DASHBOARD");
    lines.push("================================");
    lines.push(`generated: ${formatDateTime(dashboard.generatedAt)}`);
    lines.push(`scope: ${dashboard.scopedProjectId ?? "all projects"}`);
    lines.push(`lookback: ${dashboard.lookbackDays} days`);
    lines.push(`persistSnapshot: ${persistSnapshot ? "enabled" : "disabled"}`);
    lines.push("");

    lines.push("Current totals");
    lines.push(
        `  rows: total=${formatNumber(dashboard.current.totalRows)} compacted=${formatNumber(dashboard.current.compactedRows)} plain=${formatNumber(dashboard.current.plainRows)} (${formatRate(dashboard.current.compactionRate)} compacted)`
    );
    lines.push(
        `  chars: original=${formatNumber(dashboard.current.originalChars)} stored=${formatNumber(dashboard.current.storedChars)} saved=${formatNumber(dashboard.current.savedChars)} (${formatPercent(dashboard.current.savedPercent)})`
    );
    lines.push(
        `  compression: avgRatio=${dashboard.current.averageCompressionRatio.toFixed(4)} (stored/original)`
    );
    lines.push(
        `  integrity: total=${formatNumber(dashboard.integrityAnomalies.total)} invalidChecksum=${formatNumber(dashboard.integrityAnomalies.invalidChecksum)} decodeError=${formatNumber(dashboard.integrityAnomalies.decodeError)}`
    );
    lines.push("");

    lines.push(
        `Portfolio totals: projects=${formatNumber(dashboard.totals.projectCount)} anomalies=${formatNumber(dashboard.totals.projectsWithAnomalies)} mostlyCompacted=${formatNumber(dashboard.totals.projectsMostlyCompacted)}`
    );
    lines.push("");

    for (const row of renderTrendSection("Global trend", dashboard.trend.global, trendRows)) {
        lines.push(row);
    }

    lines.push("");

    const scopedTrendTitle = dashboard.scopedProjectId
        ? `Scoped trend (${dashboard.scopedProjectId})`
        : "Scoped trend";
    for (const row of renderTrendSection(scopedTrendTitle, dashboard.trend.scopedProject, trendRows)) {
        lines.push(row);
    }

    lines.push("");

    for (const row of renderProjectSection(dashboard.perProject, topProjects)) {
        lines.push(row);
    }

    return lines.join("\n");
}
