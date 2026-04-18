import { connectSqlite, initializeSqlite } from "../storage/sqlite/db";

export async function migrate(): Promise<void> {
    const db = connectSqlite();
    initializeSqlite(db);
    console.log("[cortexa] storage migrations applied");
}

if (require.main === module) {
    void migrate();
}
