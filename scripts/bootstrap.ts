import { ensureVectorCollection } from "../core/embeddings/vector.store";
import { connectSqlite, initializeSqlite } from "../storage/sqlite/db";

export async function bootstrap(): Promise<void> {
    const db = connectSqlite();
    initializeSqlite(db);
    console.log("[cortexa] sqlite initialized");

    try {
        await ensureVectorCollection("cortexa_memories", 256);
        console.log("[cortexa] vector collection ready");
    } catch (error) {
        console.warn("[cortexa] vector backend unavailable, continuing in degraded mode", error);
    }
}

if (require.main === module) {
    void bootstrap();
}
