import fs from "node:fs";
import path from "node:path";
import { getMemoryCompactionDashboard } from "../core/mempalace/memory.service";
import type {
    MemoryCompactionDashboardPayload,
    MemoryCompactionProjectBreakdownItem,
    MemoryCompactionTrendSnapshot
} from "../core/mempalace/memory.types";

type CliFormat = "human" | "json";

interface CliOptions {
    projectId?: string;
    lookbackDays?: number;
    maxTrendPoints?: number;
    maxProjects?: number;
    persistSnapshot?: boolean;
    perProjectSnapshotLimit?: number;
    snapshotRetentionDays?: number;
    format: CliFormat;
    outFile?: string;
    outJsonFile?: string;
    outHumanFile?: string;
    topProjects?: number;
    trendRows?: number;
    help?: boolean;
}

const DEFAULT_TOP_PROJECTS = 12;
const DEFAULT_TREND_ROWS = 8;

function printHelp(): void {
    const lines = [
        "CORTEXA Compaction Dashboard CLI",
        "",
        "Usage:",
        "  pnpm run dashboard:compaction -- [options]",
        "",
        "Display format:",
        "  --format=human|json          Set stdout format (default: human)",
        "  --json                       Alias for --format=json",
        "",
        "Scope and dashboard options:",
        "  --projectId=<id>             Scope dashboard to one project",
        "  --lookbackDays=<n>           Trend window in days",
        "  --maxTrendPoints=<n>         Max trend points loaded from snapshots",
        "  --maxProjects=<n>            Max projects in dashboard payload",
        "  --no-persist-snapshot        Do not persist current snapshot",
        "  --perProjectSnapshotLimit=<n> Number of projects to snapshot per run",
        "  --snapshotRetentionDays=<n>  Snapshot retention period",
        "",
        "Human report controls:",
        "  --topProjects=<n>            Number of projects to render in table",
        "  --trendRows=<n>              Number of trend rows to render",
        "",
        "Output files:",
        "  --out=<file>                 Legacy alias: write JSON payload to file",
        "  --out-json=<file>            Write JSON payload to file",
        "  --out-human=<file>           Write human report to file",
        "",
        "Help:",
        "  --help                       Show this help text"
    ];

    console.log(lines.join("\n"));
}

function parseIntArg(value: string): number | undefined {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return undefined;
    }

    return Math.trunc(parsed);
}

function parseArgs(argv: string[]): CliOptions {
    const options: CliOptions = {
        format: "human"
    };

    for (const arg of argv) {
        if (arg === "--help") {
            options.help = true;
            continue;
        }

        if (arg === "--json") {
            options.format = "json";
            continue;
        }

        if (arg.startsWith("--format=")) {
            const value = arg.slice("--format=".length).trim().toLowerCase();
            if (value === "json" || value === "human") {
                options.format = value;
            }
            continue;
        }

        if (arg.startsWith("--projectId=")) {
            const value = arg.slice("--projectId=".length).trim();
            if (value) {
                options.projectId = value;
            }
            continue;
        }

        if (arg.startsWith("--lookbackDays=")) {
            options.lookbackDays = parseIntArg(arg.slice("--lookbackDays=".length));
            continue;
        }

        if (arg.startsWith("--maxTrendPoints=")) {
            options.maxTrendPoints = parseIntArg(arg.slice("--maxTrendPoints=".length));
            continue;
        }

        if (arg.startsWith("--maxProjects=")) {
            options.maxProjects = parseIntArg(arg.slice("--maxProjects=".length));
            continue;
        }

        if (arg.startsWith("--topProjects=")) {
            options.topProjects = parseIntArg(arg.slice("--topProjects=".length));
            continue;
        }

        if (arg.startsWith("--trendRows=")) {
            options.trendRows = parseIntArg(arg.slice("--trendRows=".length));
            continue;
        }

        if (arg === "--no-persist-snapshot") {
            options.persistSnapshot = false;
            continue;
        }

        if (arg.startsWith("--perProjectSnapshotLimit=")) {
            options.perProjectSnapshotLimit = parseIntArg(arg.slice("--perProjectSnapshotLimit=".length));
            continue;
        }

        if (arg.startsWith("--snapshotRetentionDays=")) {
            options.snapshotRetentionDays = parseIntArg(arg.slice("--snapshotRetentionDays=".length));
            continue;
        }

        if (arg.startsWith("--out=")) {
            const value = arg.slice("--out=".length).trim();
            if (value) {
                options.outFile = value;
            }
            continue;
        }

        if (arg.startsWith("--out-json=")) {
            const value = arg.slice("--out-json=".length).trim();
            if (value) {
                options.outJsonFile = value;
            }
            continue;
        }

        if (arg.startsWith("--out-human=")) {
            const value = arg.slice("--out-human=".length).trim();
            if (value) {
                options.outHumanFile = value;
            }
        }
    }

    return options;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, Math.trunc(value)));
}

function resolveOutputPath(filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function writeText(filePath: string, content: string): string {
    const resolved = resolveOutputPath(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf8");
    return resolved;
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

function renderHumanDashboard(
    dashboard: MemoryCompactionDashboardPayload,
    options: {
        topProjects: number;
        trendRows: number;
        persistSnapshot: boolean;
    }
): string {
    const lines: string[] = [];

    lines.push("CORTEXA COMPACTION DASHBOARD");
    lines.push("================================");
    lines.push(`generated: ${formatDateTime(dashboard.generatedAt)}`);
    lines.push(`scope: ${dashboard.scopedProjectId ?? "all projects"}`);
    lines.push(`lookback: ${dashboard.lookbackDays} days`);
    lines.push(`persistSnapshot: ${options.persistSnapshot ? "enabled" : "disabled"}`);
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

    for (const row of renderTrendSection("Global trend", dashboard.trend.global, options.trendRows)) {
        lines.push(row);
    }

    lines.push("");

    const scopedTrendTitle = dashboard.scopedProjectId
        ? `Scoped trend (${dashboard.scopedProjectId})`
        : "Scoped trend";
    for (const row of renderTrendSection(scopedTrendTitle, dashboard.trend.scopedProject, options.trendRows)) {
        lines.push(row);
    }

    lines.push("");

    for (const row of renderProjectSection(dashboard.perProject, options.topProjects)) {
        lines.push(row);
    }

    return lines.join("\n");
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
        printHelp();
        return;
    }

    const topProjects = clamp(options.topProjects, DEFAULT_TOP_PROJECTS, 1, 500);
    const trendRows = clamp(options.trendRows, DEFAULT_TREND_ROWS, 1, 250);
    const persistSnapshot = options.persistSnapshot !== false;

    const dashboard = getMemoryCompactionDashboard({
        projectId: options.projectId,
        lookbackDays: options.lookbackDays,
        maxTrendPoints: options.maxTrendPoints,
        maxProjects: options.maxProjects,
        persistSnapshot,
        perProjectSnapshotLimit: options.perProjectSnapshotLimit,
        snapshotRetentionDays: options.snapshotRetentionDays
    });

    const payload = JSON.stringify(dashboard, null, 2);
    const human = renderHumanDashboard(dashboard, {
        topProjects,
        trendRows,
        persistSnapshot
    });

    const stdout = options.format === "json" ? payload : human;

    if (options.outFile) {
        const outPath = writeText(options.outFile, payload);
        console.log(`[cortexa] wrote compaction dashboard payload to ${outPath}`);
    }

    if (options.outJsonFile) {
        const outPath = writeText(options.outJsonFile, payload);
        console.log(`[cortexa] wrote compaction dashboard JSON to ${outPath}`);
    }

    if (options.outHumanFile) {
        const outPath = writeText(options.outHumanFile, human);
        console.log(`[cortexa] wrote compaction dashboard report to ${outPath}`);
    }

    console.log(stdout);
}

main().catch((error) => {
    console.error("[cortexa] compaction dashboard script failed");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
