import { Command } from "commander";
import { ensureVectorCollection } from "../../../../core/embeddings/vector.store";
import { connectSqlite, initializeSqlite } from "../../../../storage/sqlite/db";
import { logger } from "../utils/logger";

export const initCommand = new Command("init")
    .description("Initialize Cortexa in current workspace")
    .option("--skip-vector", "Skip vector backend probing")
    .action(async (options: { skipVector?: boolean }) => {
        const db = connectSqlite();
        initializeSqlite(db);

        logger.info("SQLite schema is ready.");

        if (options.skipVector) {
            logger.info("Vector initialization skipped (--skip-vector).");
            return;
        }

        try {
            await ensureVectorCollection("cortexa_memories", 256);
            logger.info("Vector collection is ready.");
        } catch (error) {
            logger.warn(
                "Vector backend is unreachable right now; Cortexa will continue in lexical mode.",
                error instanceof Error ? error.message : String(error)
            );
        }
    });
