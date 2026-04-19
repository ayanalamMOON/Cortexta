import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main(): Promise<void> {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortexa-ingest-incremental-"));
    const tempDbPath = path.join(tempRoot, "cortexa-ingestion.db");
    const projectPath = path.join(tempRoot, "project");
    const sourceFile = path.join(projectPath, "sample.ts");

    process.env.CORTEXA_DB_PATH = tempDbPath;
    process.env.CORTEXA_VECTOR_PROVIDER = "memory";

    fs.mkdirSync(projectPath, { recursive: true });
    fs.writeFileSync(
        sourceFile,
        [
            "export function sum(a: number, b: number): number {",
            "  return a + b;",
            "}",
            "",
            "export const featureFlag = 'incremental-ingest';"
        ].join("\n"),
        "utf8"
    );

    const { runIngestion } = require("../core/ingestion/ingest.pipeline") as {
        runIngestion: (input: Record<string, unknown>) => Promise<{
            filesScanned: number;
            codeFilesSkippedUnchanged: number;
            codeChunks: number;
            memoriesStored: number;
            staleMemoriesRemoved: number;
            staleCodeMemoriesRemoved: number;
        }>;
    };

    const { closeSqlite, connectSqlite } = require("../storage/sqlite/db") as {
        closeSqlite: () => void;
        connectSqlite: () => {
            prepare: (sql: string) => {
                get: <T = unknown>(...params: unknown[]) => T;
                all: <T = unknown>(...params: unknown[]) => T[];
            };
        };
    };

    function listSourceMemoryIds(db: ReturnType<typeof connectSqlite>): string[] {
        const rows = db
            .prepare(
                `
                SELECT id
                FROM memories
                WHERE projectId = ?
                  AND sourceRef = ?
                  AND kind = 'code_entity'
                ORDER BY id ASC
                `
            )
            .all<{ id?: string }>(baseInput.projectId, "sample.ts");

        return rows.map((row) => String(row.id ?? "")).filter(Boolean);
    }

    const baseInput = {
        projectPath,
        projectId: "ingestion-incremental-test",
        includeChats: false
    };

    const first = await runIngestion({
        ...baseInput,
        skipUnchanged: true
    });

    assert.equal(first.filesScanned, 1, "first ingest should scan source file");
    assert.equal(first.codeFilesSkippedUnchanged, 0, "first ingest should not skip file as unchanged");
    assert.ok(first.codeChunks >= 1, "first ingest should parse code chunks");
    assert.ok(first.memoriesStored >= 1, "first ingest should persist at least one memory");

    const db = connectSqlite();
    const firstIds = listSourceMemoryIds(db);
    assert.ok(firstIds.length >= 1, "first ingest should create source-scoped memories");

    const second = await runIngestion({
        ...baseInput,
        skipUnchanged: true
    });

    assert.equal(second.filesScanned, 1, "second ingest should still scan source file");
    assert.equal(second.codeFilesSkippedUnchanged, 1, "second ingest should skip unchanged file");
    assert.equal(second.codeChunks, 0, "second ingest should avoid parsing chunks for unchanged file");
    assert.equal(second.memoriesStored, 0, "second ingest should avoid memory writes for unchanged file");

    const third = await runIngestion({
        ...baseInput,
        skipUnchanged: false
    });

    assert.equal(third.codeFilesSkippedUnchanged, 0, "skipUnchanged=false should force ingest");
    assert.ok(third.codeChunks >= 1, "forced ingest should parse chunks");
    assert.ok(third.memoriesStored >= 1, "forced ingest should write memories");
    assert.equal(
        third.staleMemoriesRemoved,
        0,
        "forced ingest with unchanged source should not remove any source memories"
    );

    fs.writeFileSync(
        sourceFile,
        [
            "export function diff(a: number, b: number): number {",
            "  return a - b;",
            "}",
            "",
            "export const featureFlag = 'incremental-ingest-updated';"
        ].join("\n"),
        "utf8"
    );

    const fourth = await runIngestion({
        ...baseInput,
        skipUnchanged: true
    });

    assert.equal(fourth.codeFilesSkippedUnchanged, 0, "changed file should not be skipped");
    assert.ok(fourth.codeChunks >= 1, "changed file should be re-parsed");
    assert.ok(fourth.memoriesStored >= 1, "changed file should produce memory writes");

    assert.ok(
        fourth.staleMemoriesRemoved >= 1,
        "changed source ingestion should remove stale memories from previous source version"
    );
    assert.ok(
        fourth.staleCodeMemoriesRemoved >= 1,
        "changed source ingestion should report stale code memory cleanup"
    );

    const fourthIds = listSourceMemoryIds(db);
    const removedIds = firstIds.filter((id) => !fourthIds.includes(id));
    assert.ok(
        removedIds.length >= 1,
        "at least one previously generated source memory id should be removed after source rewrite"
    );

    closeSqlite();
    fs.rmSync(tempRoot, { recursive: true, force: true });

    console.log("✅ incremental ingestion integration test passed");
}

main().catch((error) => {
    console.error("❌ incremental ingestion integration test failed");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
