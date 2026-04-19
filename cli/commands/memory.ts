import fs from "node:fs";
import path from "node:path";
import {
    auditMemoryResurrection,
    backfillMemoryCompaction,
    createMemoryBranch,
    deleteMemory,
    diffMemoriesBetween,
    getMemoryById,
    getMemoryCompactionDashboard,
    getMemoryCompactionOpportunities,
    getMemoryCompactionStats,
    listMemories,
    listMemoryBranches,
    mergeMemoryBranch,
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
        "Unknown memory action. Use: list [projectId] [--limit] [--branch] [--as-of] | search <query> [--top-k] [--min-score] [--project-id] [--branch] [--as-of] | get <id> [--project-id] [--branch] [--as-of] [--full] | resurrect <id> [--project-id] [--branch] [--as-of] [--full] | delete <id> [--project-id] [--branch] | branch list [--project-id] | branch create <branch> [--project-id] [--from-branch] [--forked-from-commit] | branch merge <source> <target> [--project-id] [--strategy] | temporal diff [--project-id] [--branch] --from <ms> --to <ms> [--limit] | stats [--project-id] | opportunities [--project-id] [--limit] [--scan-limit] [--min-content-chars] [--json] | audit [--project-id] [--limit] [--max-issues] [--json] | backfill [--apply] [--project-id] [--limit] | dashboard [--json] [--project-id]"
    );
}

export async function memoryCommand(action: string, cliArgs: string[] = []): Promise<void> {
    const parsed = parseCliArgs(cliArgs);
    const positionals = parsed.positionals;

    if (action === "list") {
        const positionalProjectId = positionals[0]?.trim() || undefined;
        const projectId = readStringOption(parsed, ["project-id", "projectId"]) ?? positionalProjectId;
        const branch = readStringOption(parsed, ["branch"]);
        const asOfRaw = readNumberOption(parsed, ["as-of", "asOf"]);
        const asOf =
            typeof asOfRaw === "number" && Number.isFinite(asOfRaw)
                ? Math.max(0, Math.trunc(asOfRaw))
                : undefined;
        const limit = clampInteger(readNumberOption(parsed, ["limit"]), 30, 1, 5_000);

        const rows = listMemories(projectId, limit, {
            branch,
            asOf
        });
        logger.info(
            `Listing ${rows.length} memories project=${projectId ?? "all"} branch=${branch ?? "main"} asOf=${asOf ?? "now"} limit=${limit}`
        );
        rows.forEach((row, index) => {
            logger.info(
                `${index + 1}. ${row.id} [${row.kind}] ${row.title} branch=${row.branch ?? "main"} importance=${row.importance.toFixed(2)} confidence=${row.confidence.toFixed(2)}`
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
        const branch = readStringOption(parsed, ["branch"]);
        const asOfRaw = readNumberOption(parsed, ["as-of", "asOf"]);
        const asOf =
            typeof asOfRaw === "number" && Number.isFinite(asOfRaw)
                ? Math.max(0, Math.trunc(asOfRaw))
                : undefined;
        const topK = clampInteger(readNumberOption(parsed, ["top-k", "topK"]), 10, 1, 200);
        const minScoreRaw = readNumberOption(parsed, ["min-score", "minScore"]);
        const minScore =
            typeof minScoreRaw === "number" && Number.isFinite(minScoreRaw)
                ? Math.min(1, Math.max(0, minScoreRaw))
                : 0;

        const rows = await searchMemories(query, {
            projectId,
            branch,
            topK,
            minScore,
            asOf
        });
        logger.info(
            `Search returned ${rows.length} memories for query="${query}" project=${projectId ?? "all"} branch=${branch ?? "main"} asOf=${asOf ?? "now"}`
        );
        rows.forEach((row, index) =>
            logger.info(
                `${index + 1}. ${row.id} [${row.kind}] branch=${row.branch ?? "main"} score=${row.score.toFixed(4)} sim=${row.similarity.toFixed(4)} recency=${row.recency.toFixed(4)} ${row.title}`
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

        const projectId = readStringOption(parsed, ["project-id", "projectId"]);
        const branch = readStringOption(parsed, ["branch"]);
        const asOfRaw = readNumberOption(parsed, ["as-of", "asOf"]);
        const asOf =
            typeof asOfRaw === "number" && Number.isFinite(asOfRaw)
                ? Math.max(0, Math.trunc(asOfRaw))
                : undefined;

        const row = getMemoryById(id, {
            projectId,
            branch,
            asOf
        });
        if (!row) {
            logger.warn("Memory not found");
            return;
        }

        const full = hasFlag(parsed, ["full"]);
        const content = summarizeContent(row.content, full);
        const copilot = summarizeContent(row.copilotContent ?? "", full);

        logger.info(
            `Memory ${action === "resurrect" ? "resurrection" : "record"} id=${row.id} logicalId=${row.logicalId ?? row.id} project=${row.projectId} branch=${row.branch ?? "main"} kind=${row.kind} source=${row.sourceType}`
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
        const projectId = readStringOption(parsed, ["project-id", "projectId"]);
        const branch = readStringOption(parsed, ["branch"]);

        await deleteMemory(id, {
            projectId,
            branch
        });
        logger.info(`Deleted memory ${id} project=${projectId ?? "auto"} branch=${branch ?? "main"}`);
        return;
    }

    if (action === "branch") {
        const subAction = (positionals[0] ?? "list").toLowerCase();
        const projectId = readStringOption(parsed, ["project-id", "projectId"]);

        if (!projectId) {
            logger.warn("Usage: memory branch <list|create|merge|switch> --project-id=<id> [...]");
            return;
        }

        if (subAction === "list") {
            const branches = listMemoryBranches(projectId);
            logger.info(`Branches for project=${projectId}`);
            branches.forEach((branch, index) => {
                logger.info(
                    `${index + 1}. ${branch.branch} parent=${branch.parentBranch ?? "n/a"} forkedFromCommit=${branch.forkedFromCommit ?? "n/a"}`
                );
            });
            return;
        }

        if (subAction === "create") {
            const branch = (positionals[1] ?? "").trim() || readStringOption(parsed, ["branch"]);
            if (!branch) {
                logger.warn("Usage: memory branch create <branch> --project-id=<id> [--from-branch=<name>] [--forked-from-commit=<id>]");
                return;
            }

            const fromBranch = readStringOption(parsed, ["from-branch", "fromBranch"]);
            const forkedFromCommit = readStringOption(parsed, ["forked-from-commit", "forkedFromCommit"]);

            const created = createMemoryBranch({
                projectId,
                branch,
                fromBranch,
                forkedFromCommit
            });

            logger.info(
                `Created branch ${created.branch} project=${created.projectId} parent=${created.parentBranch ?? "main"} forkedFromCommit=${created.forkedFromCommit ?? "n/a"}`
            );
            return;
        }

        if (subAction === "merge") {
            const sourceBranch = (positionals[1] ?? "").trim();
            const targetBranch = (positionals[2] ?? "").trim();
            if (!sourceBranch || !targetBranch) {
                logger.warn("Usage: memory branch merge <sourceBranch> <targetBranch> --project-id=<id> [--strategy=<source-wins|target-wins>]");
                return;
            }

            const strategyRaw = readStringOption(parsed, ["strategy"]);
            const strategy = strategyRaw === "target-wins" ? "target-wins" : "source-wins";

            const result = await mergeMemoryBranch({
                projectId,
                sourceBranch,
                targetBranch,
                strategy
            });

            logger.info(
                `Merged branch source=${result.sourceBranch} target=${result.targetBranch} strategy=${result.strategy} upserts=${result.appliedUpserts} deletes=${result.appliedDeletes} skipped=${result.skipped}`
            );
            return;
        }

        if (subAction === "switch") {
            const toBranch = (positionals[1] ?? "").trim() || readStringOption(parsed, ["branch"]);
            if (!toBranch) {
                logger.warn("Usage: memory branch switch <toBranch> --project-id=<id> [--from-branch=<name>]");
                return;
            }

            const fromBranch = readStringOption(parsed, ["from-branch", "fromBranch"]);
            const ensured = createMemoryBranch({
                projectId,
                branch: toBranch,
                fromBranch
            });

            logger.info(
                `Switched branch context project=${projectId} from=${fromBranch ?? "main"} to=${ensured.branch}`
            );
            return;
        }

        logger.warn("Unknown memory branch action. Use: list | create | merge | switch");
        return;
    }

    if (action === "temporal") {
        const subAction = (positionals[0] ?? "diff").toLowerCase();
        if (subAction !== "diff") {
            logger.warn("Unknown memory temporal action. Use: diff");
            return;
        }

        const projectId = readStringOption(parsed, ["project-id", "projectId"]);
        if (!projectId) {
            logger.warn("Usage: memory temporal diff --project-id=<id> [--branch=<name>] --from=<unix-ms> --to=<unix-ms> [--limit=<n>]");
            return;
        }

        const branch = readStringOption(parsed, ["branch"]);
        const from = readNumberOption(parsed, ["from"]);
        const to = readNumberOption(parsed, ["to"]);
        if (typeof from !== "number" || !Number.isFinite(from) || typeof to !== "number" || !Number.isFinite(to)) {
            logger.warn("Both --from and --to must be finite unix timestamps (ms).");
            return;
        }

        const limit = clampInteger(readNumberOption(parsed, ["limit"]), 50, 1, 2000);
        const diff = diffMemoriesBetween({
            projectId,
            branch,
            from: Math.max(0, Math.trunc(from)),
            to: Math.max(0, Math.trunc(to)),
            limit
        });

        logger.info(
            `Temporal diff project=${diff.projectId} branch=${diff.branch} from=${diff.from} to=${diff.to} added=${diff.totals.added} removed=${diff.totals.removed} modified=${diff.totals.modified}`
        );
        diff.items.forEach((item, index) => {
            logger.info(
                `${index + 1}. [${item.changeType}] ${item.logicalId} ${item.title} kind=${item.kind} source=${item.sourceType}`
            );
        });
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

    if (action === "audit") {
        const positionalProjectId = positionals[0]?.trim() || undefined;
        const projectId = readStringOption(parsed, ["project-id", "projectId"]) ?? positionalProjectId;
        const limit = clampInteger(readNumberOption(parsed, ["limit"]), 5000, 1, 50_000);
        const maxIssues = clampInteger(readNumberOption(parsed, ["max-issues", "maxIssues"]), 10, 0, 100);
        const jsonMode = hasFlag(parsed, ["json"]) || readStringOption(parsed, ["format"]) === "json";

        const report = auditMemoryResurrection({
            projectId,
            limit,
            maxIssues
        });

        if (jsonMode) {
            logger.info(JSON.stringify(report, null, 2));
            return;
        }

        logger.info(`Resurrection audit project=${projectId ?? "all"} scanned=${formatNumber(report.scannedRows)} limit=${limit}`);
        logger.info(
            `rows compacted=${formatNumber(report.compactedRows)} validCompacted=${formatNumber(report.validCompactedRows)} plain=${formatNumber(report.plainRows)} compactionOpportunity=${formatPercent(report.compactionOpportunityRate * 100)}`
        );
        logger.info(
            `integrity anomalies total=${formatNumber(report.anomalies.total)} invalidChecksum=${formatNumber(report.anomalies.invalidChecksum)} decodeError=${formatNumber(report.anomalies.decodeError)} anomalyRate=${formatPercent(report.anomalyRate * 100)}`
        );

        if (report.issueSamples.length > 0) {
            logger.info(`issue-samples (${report.issueSamples.length}):`);
            report.issueSamples.forEach((issue, index) => {
                logger.info(
                    `${index + 1}. ${issue.id} [${issue.integrity}] project=${issue.projectId} source=${issue.sourceType} kind=${issue.kind} title=${issue.title}`
                );
                logger.info(`   preview: ${issue.preview}`);
            });
        }

        if (report.recommendations.length > 0) {
            logger.info("recommendations:");
            report.recommendations.forEach((recommendation, index) => {
                logger.info(`  ${index + 1}. ${recommendation}`);
            });
        }

        return;
    }

    if (action === "opportunities") {
        const positionalProjectId = positionals[0]?.trim() || undefined;
        const projectId = readStringOption(parsed, ["project-id", "projectId"]) ?? positionalProjectId;
        const limit = clampInteger(readNumberOption(parsed, ["limit"]), 20, 1, 500);
        const scanLimit = clampInteger(readNumberOption(parsed, ["scan-limit", "scanLimit"]), 2000, 1, 50_000);
        const minContentChars = clampInteger(
            readNumberOption(parsed, ["min-content-chars", "minContentChars"]),
            220,
            64,
            20_000
        );
        const jsonMode = hasFlag(parsed, ["json"]) || readStringOption(parsed, ["format"]) === "json";

        const report = getMemoryCompactionOpportunities({
            projectId,
            limit,
            scanLimit,
            minContentChars
        });

        if (jsonMode) {
            logger.info(JSON.stringify(report, null, 2));
            return;
        }

        logger.info(
            `Compaction opportunities project=${projectId ?? "all"} scanned=${formatNumber(report.scannedRows)} plainRows=${formatNumber(report.plainRows)} candidates=${formatNumber(report.candidates)} totalEstimatedSavedChars=${formatNumber(report.totalEstimatedSavedChars)}`
        );

        if (report.items.length === 0) {
            logger.info("No compaction opportunities found for current thresholds.");
            return;
        }

        report.items.forEach((item, index) => {
            logger.info(
                `${index + 1}. ${item.id} [${item.kind}] saved=${formatNumber(item.estimatedSavedChars)} (${formatPercent(item.estimatedSavedPercent)}) ratio=${item.estimatedCompressionRatio.toFixed(4)} chars=${formatNumber(item.contentChars)}->${formatNumber(item.estimatedStoredChars)}`
            );
            logger.info(`   project=${item.projectId} source=${item.sourceType} ref=${item.sourceRef ?? "n/a"}`);
            logger.info(`   title: ${item.title}`);
        });

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
