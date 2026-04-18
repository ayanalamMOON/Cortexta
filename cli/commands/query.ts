import { retrieveTopK } from "../../core/retrieval/retriever";
import { logger } from "../utils/logger";

export async function queryCommand(text: string): Promise<void> {
    const results = await retrieveTopK(text, { topK: 10 });

    logger.info(`Top ${results.length} results for query: ${text}`);
    for (const result of results) {
        logger.info(`- [${result.kind}] ${result.title} (score=${result.score.toFixed(4)})`);
        logger.info(`  ${result.summary}`);
    }
}
