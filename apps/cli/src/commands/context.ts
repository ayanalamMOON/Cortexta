import { Command } from "commander";
import { compileContext } from "../../../../core/context/compiler";
import { logger } from "../utils/logger";

export const contextCommand = new Command("context")
    .argument("<query>", "Context query")
    .description("Compile token-bounded context payload")
    .option("--project-id <projectId>", "Limit context to project")
    .option("--max-tokens <maxTokens>", "Maximum token budget", (value: string) => Number(value), 4000)
    .option("--top-k <topK>", "Maximum retrieved memories", (value: string) => Number(value), 12)
    .option("--scope <scope>", "Scope descriptor")
    .action(async (query: string, options: { projectId?: string; maxTokens?: number; topK?: number; scope?: string }) => {
        const compiled = await compileContext(query, {
            projectId: options.projectId,
            maxTokens: Number.isFinite(options.maxTokens) ? options.maxTokens : 4000,
            topK: Number.isFinite(options.topK) ? options.topK : 12,
            scope: options.scope
        });

        logger.info(`Context compiled: tokens≈${compiled.tokenEstimate} memories=${compiled.memoriesUsed} dropped=${compiled.dropped}`);
        logger.info("\n" + compiled.context);
    });
