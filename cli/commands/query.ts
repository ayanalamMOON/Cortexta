import { retrieveTopK } from "../../core/retrieval/retriever";
import {
    clampInteger,
    parseCliArgs,
    readNumberOption,
    readStringOption
} from "../utils/args";
import { logger } from "../utils/logger";

export async function queryCommand(cliArgs: string[] = []): Promise<void> {
    const parsed = parseCliArgs(cliArgs);
    const text = parsed.positionals.join(" ").trim();

    if (!text) {
        logger.warn("Usage: cortexa query <text> [--project-id=<id>] [--branch=<name>] [--top-k=<n>] [--min-score=<0-1>] [--as-of=<unix-ms>]");
        return;
    }

    const projectId = readStringOption(parsed, ["project-id", "projectId"]);
    const branch = readStringOption(parsed, ["branch"]);
    const topK = clampInteger(readNumberOption(parsed, ["top-k", "topK"]), 10, 1, 100);

    const minScoreRaw = readNumberOption(parsed, ["min-score", "minScore"]);
    const minScore =
        typeof minScoreRaw === "number" && Number.isFinite(minScoreRaw)
            ? Math.min(1, Math.max(0, minScoreRaw))
            : undefined;

    const asOfRaw = readNumberOption(parsed, ["as-of", "asOf"]);
    const asOf =
        typeof asOfRaw === "number" && Number.isFinite(asOfRaw)
            ? Math.max(0, Math.trunc(asOfRaw))
            : undefined;

    const results = await retrieveTopK(text, {
        projectId,
        branch,
        topK,
        minScore,
        asOf
    });

    logger.info(`Top ${results.length} results for query: ${text}`);
    for (const result of results) {
        logger.info(`- [${result.kind}] ${result.title} (branch=${result.branch ?? "main"} score=${result.score.toFixed(4)})`);
        logger.info(`  ${result.summary}`);
    }
}
