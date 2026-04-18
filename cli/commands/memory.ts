import fs from "node:fs";
import path from "node:path";
import {
    backfillMemoryCompaction,
    deleteMemory,
    getMemoryById,
    getMemoryCompactionDashboard,
    getMemoryCompactionStats,
    listMemories,
    searchMemories
} from "../../core/mempalace/memory.service";
import { clampInteger, hasFlag, parseCliArgs, readNumberOption, readStringOption } from "../utils/args";
import { renderCompactionDashboardHuman } from "../utils/compaction-dashboard";
import { logger } from "../utils/logger";

function formatNumber(value: number): string {
    return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(value: number, digits = 2): string {
    return `${value.toFixed(digits)}%`;
}

function resolveOutputPath(filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function writeTextFile(filePath: string, content: string): string {
    const resolved = resolveOutputPath(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf8");
    return resolved;
}

function summarizeContent(content: string, full: boolean): string {
    if (full) {
        return content;
    }

    const maxChars = 1200;
    if (content.length <= maxChars) {
        return content;
    }

    return `${content.slice(0, maxChars)}\n... [truncated; rerun with --full to show all content]`;
}

function printMemoryUsage(): void {
    logger.warn(
        "Unknown memory action. Use: list [projectId] [--limit] | search <query> [--top-k] [--min-score] [--project-id] | get <id> [--full] | resurrect <id> [--full] | delete <id> | stats [--project-id] | backfill [--apply] [--project-id] [--limit] | dashboard [--json] [--project-id]"
    );
}

export async function memoryCommand(action: string, cliArgs: string[] = []): Promise<void> {
    const parsed = parseCliArgs(cliArgs);
    const positionals = parsed.positionals;

    if (action === "list") {
        const positionalProjectId = positionals[0]?.trim() || undefined;
        const projectId = readStringOption(parsed, ["project-id", "projectId"]) ?? positionalProjectId;
        const limit = clampInteger(readNumberOption(parsed, ["limit"]), 30, 1, 5_000);

        const rows = listMemories(projectId, limit);
        logger.info(`Listing ${rows.length} memories project=${projectId ?? "all"} limit=${limit}`);
        rows.forEach((row, index) => {
            logger.info(
                `${index + 1}. ${row.id} [${row.kind}] ${row.title} importance=${row.importance.toFixed(2)} confidence=${row.confidence.toFixed(2)}`
            );
        });
        return;
    }

    if (action === "search") {
        const query = positionals.join(" ").trim();
        if (!query) {
            logger.warn("Usage: memory search <query> [--project-id=<id>] [--top-k=<n>] [--min-score=<n>]");
            return;
        }

        const projectId = readStringOption(parsed, ["project-id", "projectId"]);
        const topK = clampInteger(readNumberOption(parsed, ["top-k", "topK"]), 10, 1, 200);
        const minScoreRaw = readNumberOption(parsed, ["min-score", "minScore"]);
        const minScore =
            typeof minScoreRaw === "number" && Number.isFinite(minScoreRaw)
                ? Math.min(1, Math.max(0, minScoreRaw))
                : 0;

        const rows = await searchMemories(query, {
            projectId,
            topK,
            minScore
        });
        logger.info(`Search returned ${rows.length} memories for query="${query}" project=${projectId ?? "all"}`);
        rows.forEach((row, index) =>
            logger.info(
                `${index + 1}. ${row.id} [${row.kind}] score=${row.score.toFixed(4)} sim=${row.similarity.toFixed(4)} recency=${row.recency.toFixed(4)} ${row.title}`
            )
        );
        return;
    }

    if (action === "get" || action === "resurrect") {
        const id = positionals[0];
        if (!id) {
            logger.warn(`Usage: memory ${action} <id> [--full]`);
            return;
        }

        const row = getMemoryById(id);
        if (!row) {
            logger.warn("Memory not found");
            return;
        }

        const full = hasFlag(parsed, ["full"]);
        const content = summarizeContent(row.content, full);
        const copilot = summarizeContent(row.copilotContent ?? "", full);

        logger.info(
            `Memory ${action === "resurrect" ? "resurrection" : "record"} id=${row.id} project=${row.projectId} kind=${row.kind} source=${row.sourceType}`
        );
        logger.info(`title: ${row.title}`);
        logger.info(`summary: ${row.summary}`);
        logger.info("resurrected-content:\n" + content);
        if (copilot.trim()) {
            logger.info("copilot-content:\n" + copilot);
        }
        return;
    }

    if (action === "delete") {
        const id = positionals[0];
        if (!id) {
            logger.warn("Usage: memory delete <id>");
            return;
        }
        await deleteMemory(id);
        logger.info(`Deleted memory ${id}`);
        return;
    }

    if (action === "stats") {
        const positionalProjectId = positionals[0]?.trim() || undefined;
        const projectId = readStringOption(parsed, ["project-id", "projectId"]) ?? positionalProjectId;
        const stats = getMemoryCompactionStats(projectId);

        logger.info(`Compaction stats project=${projectId ?? "all"}`);
        logger.info(
            `rows total=${formatNumber(stats.totalRows)} compacted=${formatNumber(stats.compactedRows)} plain=${formatNumber(stats.plainRows)} compactionRate=${formatPercent(stats.compactionRate * 100)}`
        );
        logger.info(
            `chars original=${formatNumber(stats.originalChars)} stored=${formatNumber(stats.storedChars)} saved=${formatNumber(stats.savedChars)} (${formatPercent(stats.savedPercent)}) avgRatio=${stats.averageCompressionRatio.toFixed(4)}`
        );
        logger.info(
            `integrity anomalies total=${formatNumber(stats.integrityAnomalies.total)} invalidChecksum=${formatNumber(stats.integrityAnomalies.invalidChecksum)} decodeError=${formatNumber(stats.integrityAnomalies.decodeError)}`
        );
        return;
    }

    if (action === "backfill") {
        const projectId = readStringOption(parsed, ["project-id", "projectId"]);
        const limit = clampInteger(readNumberOption(parsed, ["limit"]), 1000, 1, 20_000);
        const apply = hasFlag(parsed, ["apply"]);

        const result = backfillMemoryCompaction({
            projectId,
            limit,
            dryRun: !apply
        });

        logger.info(`Compaction backfill project=${projectId ?? "all"} mode=${result.dryRun ? "dry-run" : "apply"}`);
        logger.info(
            `scanned=${formatNumber(result.scanned)} eligible=${formatNumber(result.eligible)} compacted=${formatNumber(result.compacted)} skipped=${formatNumber(result.skipped)} savedChars=${formatNumber(result.savedChars)}`
        );

        if (result.dryRun) {
            logger.info("Dry-run complete. Re-run with --apply to persist compaction updates.");
        }
        return;
    }

    if (action === "dashboard") {
        const projectId = readStringOption(parsed, ["project-id", "projectId"]);
        const lookbackDays = clampInteger(readNumberOption(parsed, ["lookback-days", "lookbackDays"]), 30, 1, 3650);
        const maxTrendPoints = clampInteger(
            readNumberOption(parsed, ["max-trend-points", "maxTrendPoints"]),
            120,
            1,
            1000
        );
        const maxProjects = clampInteger(readNumberOption(parsed, ["max-projects", "maxProjects"]), 50, 1, 500);
        const perProjectSnapshotLimit = clampInteger(
            readNumberOption(parsed, ["per-project-snapshot-limit", "perProjectSnapshotLimit"]),
            25,
            0,
            500
        );
        const snapshotRetentionDays = clampInteger(
            readNumberOption(parsed, ["snapshot-retention-days", "snapshotRetentionDays"]),
            180,
            7,
            3650
        );
        const topProjects = clampInteger(readNumberOption(parsed, ["top-projects", "topProjects"]), 12, 1, 500);
        const trendRows = clampInteger(readNumberOption(parsed, ["trend-rows", "trendRows"]), 8, 1, 250);
        const persistSnapshot = !hasFlag(parsed, ["no-persist-snapshot", "noPersistSnapshot"]);
        const jsonMode = hasFlag(parsed, ["json"]) || readStringOption(parsed, ["format"]) === "json";

        const outJson = readStringOption(parsed, ["out-json", "outJson"]);
        const outHuman = readStringOption(parsed, ["out-human", "outHuman"]);

        const dashboard = getMemoryCompactionDashboard({
            projectId,
            lookbackDays,
            maxTrendPoints,
            maxProjects,
            persistSnapshot,
            perProjectSnapshotLimit,
            snapshotRetentionDays
        });

        const jsonPayload = JSON.stringify(dashboard, null, 2);
        const humanPayload = renderCompactionDashboardHuman(dashboard, {
            topProjects,
            trendRows,
            persistSnapshot
        });

        if (outJson) {
            const filePath = writeTextFile(outJson, jsonPayload);
            logger.info(`Wrote dashboard JSON to ${filePath}`);
        }

        if (outHuman) {
            const filePath = writeTextFile(outHuman, humanPayload);
            logger.info(`Wrote dashboard report to ${filePath}`);
        }

        logger.info(jsonMode ? jsonPayload : humanPayload);
        return;
    }

    printMemoryUsage();
}
