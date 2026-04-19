import { compileContext } from "../../core/context/compiler";
import { buildProactiveContextSuggestion } from "../../core/context/proactive";
import {
    clampInteger,
    parseCliArgs,
    readNumberOption,
    readStringOption
} from "../utils/args";
import { logger } from "../utils/logger";

export async function contextCommand(cliArgs: string[] = []): Promise<void> {
    const parsed = parseCliArgs(cliArgs);
    const query = parsed.positionals.join(" ").trim();

    if (!query) {
        logger.warn("Usage: cortexa context <query> [--project-id=<id>] [--branch=<name>] [--as-of=<unix-ms>] [--top-k=<n>] [--max-tokens=<n>]");
        return;
    }

    const projectId = readStringOption(parsed, ["project-id", "projectId"]);
    const branch = readStringOption(parsed, ["branch"]);
    const topK = clampInteger(readNumberOption(parsed, ["top-k", "topK"]), 12, 1, 100);
    const maxTokens = clampInteger(readNumberOption(parsed, ["max-tokens", "maxTokens"]), 4000, 128, 32768);
    const asOfRaw = readNumberOption(parsed, ["as-of", "asOf"]);
    const asOf =
        typeof asOfRaw === "number" && Number.isFinite(asOfRaw)
            ? Math.max(0, Math.trunc(asOfRaw))
            : undefined;

    const suggestion = buildProactiveContextSuggestion({
        query,
        projectId,
        branch,
        asOf
    });

    const result = await compileContext(query, {
        projectId,
        branch,
        asOf,
        maxTokens,
        topK,
        constraints: suggestion.recommendedConstraints,
        scope: suggestion.recommendedScope
    });

    logger.info(
        `Intent suggestion: ${suggestion.intent.category} confidence=${suggestion.intent.confidence.toFixed(2)} topK=${suggestion.recommendedTopK} maxTokens=${suggestion.recommendedMaxTokens}`
    );
    logger.info(`Context compiled. tokens≈${result.tokenEstimate}, memories=${result.memoriesUsed}, dropped=${result.dropped}`);
    logger.info("\n" + result.context);
}
