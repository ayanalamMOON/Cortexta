import { Command } from "commander";
import { retrieveTopK } from "../../../../core/retrieval/retriever";
import { logger } from "../utils/logger";

export const queryCommand = new Command("query")
    .argument("<text>", "Semantic query")
    .description("Run semantic memory search")
    .option("--project-id <projectId>", "Limit to a project")
    .option("--top-k <topK>", "Max results", (value: string) => Number(value), 10)
    .option("--min-score <minScore>", "Minimum score", (value: string) => Number(value), 0)
    .action(async (text: string, options: { projectId?: string; topK?: number; minScore?: number }) => {
        const results = await retrieveTopK(text, {
            projectId: options.projectId,
            topK: Number.isFinite(options.topK) ? options.topK : 10,
            minScore: Number.isFinite(options.minScore) ? options.minScore : 0
        });

        logger.info(`Found ${results.length} result(s) for query: ${text}`);
        if (results.length === 0) {
            logger.info("No relevant memory found. Try broader terms or ingest additional files.");
            return;
        }

        results.forEach((result, index) => {
            logger.info(
                `${index + 1}. [${result.kind}] ${result.title} score=${result.score.toFixed(4)} sim=${result.similarity.toFixed(4)} recency=${result.recency.toFixed(4)}`
            );
            logger.info(`   ${result.summary}`);
            if (result.sourceRef) {
                logger.debug(`   source: ${result.sourceRef}`);
            }
        });
    });
