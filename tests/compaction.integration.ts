import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main(): Promise<void> {
    const tempDbPath = path.join(os.tmpdir(), `cortexa-compaction-${Date.now()}.db`);
    process.env.CORTEXA_DB_PATH = tempDbPath;

    if (fs.existsSync(tempDbPath)) {
        fs.unlinkSync(tempDbPath);
    }

    const { closeSqlite, connectSqlite } = require("../storage/sqlite/db") as {
        closeSqlite: () => void;
        connectSqlite: () => {
            prepare: (sql: string) => {
                run: (...params: unknown[]) => unknown;
                get: <T = unknown>(...params: unknown[]) => T;
            };
        };
    };

    const {
        upsertMemory,
        getMemoryById,
        searchMemories,
        getMemoryCompactionStats,
        getMemoryCompactionDashboard,
        backfillMemoryCompaction,
        auditMemoryResurrection
    } = require("../core/mempalace/memory.service") as {
        upsertMemory: (input: Record<string, unknown>) => Promise<any>;
        getMemoryById: (id: string) => any;
        searchMemories: (query: string, options?: Record<string, unknown>) => Promise<any[]>;
        getMemoryCompactionStats: (projectId?: string) => {
            totalRows: number;
            compactedRows: number;
            plainRows: number;
            savedChars: number;
            integrityAnomalies: { invalidChecksum: number; decodeError: number; total: number };
        };
        getMemoryCompactionDashboard: (options?: Record<string, unknown>) => {
            generatedAt: number;
            scopedProjectId?: string;
            current: {
                totalRows: number;
                compactedRows: number;
                plainRows: number;
                savedChars: number;
                integrityAnomalies: { invalidChecksum: number; decodeError: number; total: number };
            };
            trend: {
                global: unknown[];
                scopedProject: unknown[];
            };
            perProject: Array<{
                projectId: string;
                riskLevel: string;
                stats: {
                    totalRows: number;
                    integrityAnomalies: { total: number };
                };
            }>;
            integrityAnomalies: { invalidChecksum: number; decodeError: number; total: number };
            totals: { projectCount: number; projectsWithAnomalies: number; projectsMostlyCompacted: number };
        };
        backfillMemoryCompaction: (options?: Record<string, unknown>) => {
            dryRun: boolean;
            scanned: number;
            eligible: number;
            compacted: number;
            skipped: number;
            savedChars: number;
        };
        auditMemoryResurrection: (options?: Record<string, unknown>) => {
            scannedRows: number;
            compactedRows: number;
            plainRows: number;
            validCompactedRows: number;
            anomalies: { invalidChecksum: number; decodeError: number; total: number };
            anomalyRate: number;
            compactionOpportunityRate: number;
            issueSamples: Array<{ id: string; integrity: string; preview: string }>;
            recommendations: string[];
        };
    };

    const id = "cmp_test_memory_1";
    const projectId = "compaction-test";
    const uniqueTailToken = "TAIL_MAGIC_QRY_9012";
    const repeatedParagraph = "repeatable context block repeatable context block repeatable context block repeatable context block.";
    const content = [
        "function calc() { return true; }",
        ...Array.from({ length: 80 }, () => repeatedParagraph),
        `tail marker: ${uniqueTailToken}`
    ].join("\n");

    await upsertMemory({
        id,
        projectId,
        kind: "code_entity",
        sourceType: "code",
        title: "Compaction memory",
        summary: "Validates compact storage + resurrection for ingest memory records.",
        content,
        embedding: [],
        tags: ["integration", "compaction"]
    });

    const db = connectSqlite();
    const rawRow = db.prepare("SELECT content FROM memories WHERE id = ?").get<{ content?: unknown }>(id);
    assert.equal(typeof rawRow?.content, "string", "raw stored content should be a string");
    assert.ok(
        String(rawRow?.content ?? "").startsWith("cortexa://mem/compact/v1/"),
        "stored content should use compact custom format"
    );

    const restored = getMemoryById(id);
    assert.ok(restored, "restored memory should exist");
    assert.equal(restored.content, content, "resurrection should restore original content losslessly");
    assert.equal(typeof restored.copilotContent, "string", "copilotContent should be present");
    assert.ok((restored.copilotContent?.length ?? 0) <= 280, "copilotContent should stay token-bounded");

    const search = await searchMemories(uniqueTailToken, { projectId, topK: 5, minScore: 0 });
    assert.ok(search.some((item) => item.id === id), "search should still find matches present only in resurrected content");

    const rawPlainId = "cmp_plain_backfill_1";
    const backfillToken = "BACKFILL_ONLY_TOKEN_7788";
    const plainContent = [
        "// plain content inserted to validate backfill migration",
        ...Array.from({ length: 80 }, () => repeatedParagraph),
        `tail marker: ${backfillToken}`
    ].join("\n");
    const now = Date.now();

    db.prepare(
        `
        INSERT INTO memories (
            id, projectId, kind, sourceType, title, summary, content, tags,
            importance, confidence, createdAt, lastAccessedAt, embeddingRef, sourceRef
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
        rawPlainId,
        projectId,
        "code_entity",
        "manual",
        "Backfill candidate",
        "Inserted as plain row to validate compaction migration workflow.",
        plainContent,
        JSON.stringify(["integration", "compaction", "backfill"]),
        0.5,
        0.7,
        now,
        now,
        null,
        null
    );

    const beforeStats = getMemoryCompactionStats(projectId);
    assert.equal(beforeStats.totalRows, 2, "stats should include compacted and plain rows");
    assert.equal(beforeStats.compactedRows, 1, "exactly one row should be compacted before backfill");
    assert.equal(beforeStats.plainRows, 1, "exactly one row should remain plain before backfill");

    const dryRunBackfill = backfillMemoryCompaction({ projectId, limit: 100, dryRun: true });
    assert.equal(dryRunBackfill.dryRun, true, "dry-run should be reported");
    assert.ok(dryRunBackfill.scanned >= 1, "dry-run should scan at least one row");
    assert.ok(dryRunBackfill.eligible >= 1, "dry-run should detect eligible plain rows");
    assert.ok(dryRunBackfill.compacted >= 1, "dry-run should report compactable rows");

    const preApplyRawPlain = db.prepare("SELECT content FROM memories WHERE id = ?").get<{ content?: unknown }>(rawPlainId);
    assert.equal(
        typeof preApplyRawPlain?.content,
        "string",
        "plain row content should be readable before backfill apply"
    );
    assert.equal(
        String(preApplyRawPlain?.content ?? "").startsWith("cortexa://mem/compact/v1/"),
        false,
        "plain row should remain un-compacted after dry-run"
    );

    const applyBackfill = backfillMemoryCompaction({ projectId, limit: 100, dryRun: false });
    assert.equal(applyBackfill.dryRun, false, "apply mode should be reported");
    assert.ok(applyBackfill.compacted >= 1, "apply backfill should compact at least one row");

    const postApplyRawPlain = db.prepare("SELECT content FROM memories WHERE id = ?").get<{ content?: unknown }>(rawPlainId);
    assert.equal(typeof postApplyRawPlain?.content, "string", "plain row content should remain readable after apply");
    assert.equal(
        String(postApplyRawPlain?.content ?? "").startsWith("cortexa://mem/compact/v1/"),
        true,
        "plain row should be compacted after apply"
    );

    const postBackfillSearch = await searchMemories(backfillToken, { projectId, topK: 5, minScore: 0 });
    assert.ok(
        postBackfillSearch.some((item) => item.id === rawPlainId),
        "search should still find tokens that existed in a row compacted via backfill"
    );

    const afterStats = getMemoryCompactionStats(projectId);
    assert.equal(afterStats.compactedRows, 2, "both rows should be compacted after backfill apply");
    assert.equal(afterStats.plainRows, 0, "no plain rows should remain after backfill apply");
    assert.ok(afterStats.savedChars > beforeStats.savedChars, "saved chars should improve after backfill apply");
    assert.equal(afterStats.integrityAnomalies.total, 0, "no integrity anomalies should exist before tampering");

    const { COMPACT_PREFIX, compactContentForStorage } = require("../core/mempalace/content.compaction") as {
        COMPACT_PREFIX: string;
        compactContentForStorage: (content: string) => string;
    };

    const anomalySource = [
        "// tampered compact payload for integrity anomaly validation",
        ...Array.from({ length: 80 }, () => repeatedParagraph),
        "tail marker: ANOMALY_MARKER_5511"
    ].join("\n");
    const compactedAnomalySource = compactContentForStorage(anomalySource);
    assert.ok(
        compactedAnomalySource.startsWith(COMPACT_PREFIX),
        "anomaly source should compact before tampering"
    );

    const encodedEnvelope = compactedAnomalySource.slice(COMPACT_PREFIX.length);
    const envelope = JSON.parse(Buffer.from(encodedEnvelope, "base64url").toString("utf8")) as {
        checksum?: string;
    };
    envelope.checksum = "ffffffffffffffffffffffff";
    const tamperedCompactedPayload = `${COMPACT_PREFIX}${Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url")}`;

    const anomalyRowId = "cmp_integrity_anomaly_1";
    db.prepare(
        `
        INSERT INTO memories (
            id, projectId, kind, sourceType, title, summary, content, tags,
            importance, confidence, createdAt, lastAccessedAt, embeddingRef, sourceRef
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
        anomalyRowId,
        projectId,
        "code_entity",
        "manual",
        "Integrity anomaly sample",
        "Tampered compact row for anomaly accounting.",
        tamperedCompactedPayload,
        JSON.stringify(["integration", "compaction", "integrity"]),
        0.4,
        0.6,
        Date.now(),
        Date.now(),
        null,
        null
    );

    const audit = auditMemoryResurrection({
        projectId,
        limit: 200,
        maxIssues: 5
    });

    assert.ok(audit.scannedRows >= 3, "audit should scan project rows");
    assert.ok(audit.compactedRows >= 3, "audit should classify compact rows");
    assert.ok(audit.anomalies.total >= 1, "audit should report integrity anomalies");
    assert.ok(audit.anomalyRate > 0, "audit should expose non-zero anomaly rate");
    assert.ok(audit.issueSamples.length >= 1, "audit should include issue samples");
    assert.equal(audit.issueSamples[0]?.id, anomalyRowId, "audit should include inserted anomaly row");
    assert.ok(audit.recommendations.length >= 1, "audit should include recommendations");

    const dashboard = getMemoryCompactionDashboard({
        projectId,
        lookbackDays: 7,
        maxTrendPoints: 50,
        maxProjects: 10,
        persistSnapshot: true,
        perProjectSnapshotLimit: 10,
        snapshotRetentionDays: 365
    });

    assert.equal(dashboard.scopedProjectId, projectId, "dashboard should scope to requested project");
    assert.ok(dashboard.generatedAt > 0, "dashboard should include generation timestamp");
    assert.ok(dashboard.current.totalRows >= 3, "dashboard should include all project rows");
    assert.ok(dashboard.current.compactedRows >= 3, "dashboard should classify tampered row as compacted");
    assert.ok(dashboard.current.integrityAnomalies.total >= 1, "dashboard should count integrity anomalies");
    assert.ok(
        dashboard.current.integrityAnomalies.invalidChecksum >= 1,
        "dashboard should count checksum mismatch anomalies"
    );
    assert.ok(dashboard.trend.global.length >= 1, "global trend snapshots should exist");
    assert.ok(dashboard.trend.scopedProject.length >= 1, "scoped project trend snapshots should exist");
    assert.ok(dashboard.perProject.length >= 1, "per-project breakdown should be present");
    assert.ok(
        dashboard.perProject.some((item) => item.projectId === projectId && item.stats.integrityAnomalies.total >= 1),
        "per-project breakdown should include scoped project anomaly counts"
    );
    assert.ok(
        dashboard.perProject.some((item) => item.projectId === projectId && item.riskLevel === "critical"),
        "anomaly project should be flagged with critical risk level"
    );
    assert.ok(dashboard.integrityAnomalies.total >= 1, "top-level integrity anomaly summary should be populated");
    assert.ok(dashboard.totals.projectCount >= 1, "dashboard totals should include project count");
    assert.ok(dashboard.totals.projectsWithAnomalies >= 1, "dashboard totals should track anomaly projects");

    closeSqlite();
    for (const candidate of [tempDbPath, `${tempDbPath}-wal`, `${tempDbPath}-shm`]) {
        if (fs.existsSync(candidate)) {
            fs.unlinkSync(candidate);
        }
    }

    console.log("✅ compaction integration test passed");
}

main().catch((error) => {
    console.error("❌ compaction integration test failed");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
