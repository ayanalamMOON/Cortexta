import { compileContext } from "../../core/context/compiler";
import { logger } from "../utils/logger";

export async function contextCommand(query: string): Promise<void> {
    const result = await compileContext(query, {
        maxTokens: 4000,
        topK: 12
    });

    logger.info(`Context compiled. tokens≈${result.tokenEstimate}, memories=${result.memoriesUsed}, dropped=${result.dropped}`);
    logger.info("\n" + result.context);
}
