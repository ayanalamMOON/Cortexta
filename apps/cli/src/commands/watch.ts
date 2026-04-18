import { Command } from "commander";
import path from "node:path";
import { extractEntitiesFromFile } from "../../../../packages/core/src/ast/extractor";
import { createIncrementalRegistry, shouldReparse } from "../../../../packages/core/src/ast/incremental";
import { startWatcher } from "../../../../packages/core/src/ast/watcher";
import { logger } from "../utils/logger";

export const watchCommand = new Command("watch")
    .argument("<dir>", "Directory to watch")
    .description("Start live incremental ingestion watcher")
    .option("--project-id <projectId>", "Project identifier override")
    .action(async (dir: string, options: { projectId?: string }) => {
        const target = path.resolve(dir);
        const projectId = options.projectId ?? path.basename(target) ?? "default";
        const incremental = createIncrementalRegistry();

        logger.info(`Watching ${target} (projectId=${projectId})`);

        const watcher = startWatcher(target, (event) => {
            try {
                if (event.type === "unlink") {
                    logger.info(`removed: ${event.filePath}`);
                    return;
                }

                const extracted = extractEntitiesFromFile(event.filePath, projectId);
                const sourceHash = extracted.entities.map((entity) => entity.sourceHash).join(":");
                const delta = incremental.computeDelta(event.filePath, sourceHash);

                if (!shouldReparse(delta)) {
                    logger.debug(`skip unchanged: ${event.filePath}`);
                    return;
                }

                logger.info(`${event.type}: ${event.filePath} -> entities=${extracted.entities.length} lang=${extracted.language}`);
            } catch (error) {
                logger.warn(`watch processing failed for ${event.filePath}`, error instanceof Error ? error.message : String(error));
            }
        });

        const onExit = async () => {
            logger.info("Shutting down watcher...");
            await watcher.close();
            process.exit(0);
        };

        process.on("SIGINT", () => {
            void onExit();
        });
        process.on("SIGTERM", () => {
            void onExit();
        });
    });
