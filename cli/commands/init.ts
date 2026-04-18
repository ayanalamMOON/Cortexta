import { ensureVectorCollection } from "../../core/embeddings/vector.store";
import { connectSqlite, initializeSqlite } from "../../storage/sqlite/db";
import { logger } from "../utils/logger";

export async function initCommand(): Promise<void> {
    connectSqlite();
    initializeSqlite();
    await ensureVectorCollection("cortexa_memories", 256);
    logger.info("Initialized storage schema and vector collection.");
}
