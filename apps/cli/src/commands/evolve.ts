import { Command } from "commander";
import { consolidate } from "../../../../core/mempalace/consolidation";
import { listMemories, upsertMemory } from "../../../../core/mempalace/memory.service";
import { logger } from "../utils/logger";

export const evolveCommand = new Command("evolve")
    .description("Run memory evolution cycle")
    .option("--project-id <projectId>", "Limit evolution to one project")
    .option("--dry-run", "Only preview changes without saving", false)
    .option("--limit <limit>", "Maximum source memories to evaluate", (value: string) => Number(value), 500)
    .action(async (options: { projectId?: string; dryRun?: boolean; limit?: number }) => {
        const source = listMemories(options.projectId, Number.isFinite(options.limit) ? options.limit : 500);
        if (source.length === 0) {
            logger.info("No memories available to evolve.");
            return;
        }

        const consolidated = consolidate(source);
        const removed = source.length - consolidated.length;

        logger.info(`Evolution preview: source=${source.length} consolidated=${consolidated.length} removed=${removed}`);

        if (options.dryRun) {
            logger.info("Dry run enabled; no persistence performed.");
            return;
        }

        for (const memory of consolidated) {
            await upsertMemory({
                id: memory.id,
                projectId: memory.projectId,
                kind: memory.kind,
                sourceType: memory.sourceType,
                title: memory.title,
                summary: memory.summary,
                content: memory.content,
                tags: memory.tags,
                importance: memory.importance,
                confidence: memory.confidence,
                embeddingRef: memory.embeddingRef,
                sourceRef: memory.sourceRef
            });
        }

        logger.info(`Evolution persisted ${consolidated.length} memory records.`);
    });
