import assert from "node:assert/strict";
import {
    COMPACT_PREFIX,
    analyzeStoredContent,
    compactContentForStorage,
    resurrectContentFromStorage
} from "../core/mempalace/content.compaction";
import type { MemoryCompactionStats } from "../core/mempalace/memory.types";
import { resolveProjectRisk } from "../core/mempalace/risk";
import { hybridScore } from "../core/scoring/hybrid.score";
import { decodeMcpCtx } from "../formats/mcp-ctx/decoder";
import { encodeMcpCtx } from "../formats/mcp-ctx/encoder";

function nearlyEqual(actual: number, expected: number, epsilon = 1e-9): void {
    assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${expected}, got ${actual}`);
}

function makeStats(overrides: Partial<MemoryCompactionStats> = {}): MemoryCompactionStats {
    return {
        projectId: "unit",
        totalRows: 10,
        compactedRows: 8,
        plainRows: 2,
        storedChars: 100,
        originalChars: 200,
        savedChars: 100,
        savedPercent: 50,
        compactionRate: 0.8,
        averageCompressionRatio: 0.5,
        integrityAnomalies: {
            invalidChecksum: 0,
            decodeError: 0,
            total: 0
        },
        ...overrides
    };
}

function testHybridScore(): void {
    const score = hybridScore(0.8, 0.6, 0);
    nearlyEqual(score, 0.8 * 0.5 + 0.6 * 0.3 + 1 * 0.2);

    const clampedLow = hybridScore(1, -10, 0);
    nearlyEqual(clampedLow, 1 * 0.5 + 0 * 0.3 + 1 * 0.2);

    const clampedHigh = hybridScore(1, 10, 0);
    nearlyEqual(clampedHigh, 1 * 0.5 + 1 * 0.3 + 1 * 0.2);

    const aged = hybridScore(0.8, 0.6, 7 * 24 * 60 * 60 * 1000);
    assert.ok(aged < score, "aged score should decay via temporal component");
}

function testResolveProjectRisk(): void {
    const critical = resolveProjectRisk(
        makeStats({
            integrityAnomalies: {
                invalidChecksum: 1,
                decodeError: 0,
                total: 1
            }
        })
    );
    assert.equal(critical, "critical");

    const lowCompaction = resolveProjectRisk(
        makeStats({
            totalRows: 100,
            compactionRate: 0.2,
            plainRows: 80,
            compactedRows: 20
        })
    );
    assert.equal(lowCompaction, "warning");

    const lowSavings = resolveProjectRisk(
        makeStats({
            totalRows: 200,
            savedPercent: 2
        })
    );
    assert.equal(lowSavings, "warning");

    const healthy = resolveProjectRisk(makeStats());
    assert.equal(healthy, "healthy");
}

function testCompactionEnvelopeCodec(): void {
    const source = "This is a highly repetitive payload for compaction testing. ".repeat(80);
    const compacted = compactContentForStorage(source);
    assert.ok(compacted.startsWith(COMPACT_PREFIX), "expected compacted envelope prefix");

    const restored = resurrectContentFromStorage(compacted);
    assert.equal(restored, source, "restored payload must match original payload");

    const analysis = analyzeStoredContent(compacted);
    assert.equal(analysis.isCompacted, true);
    assert.equal(analysis.integrity, "valid");
    assert.ok(analysis.savedChars > 0, "compacted payload should save characters");

    const encodedEnvelope = compacted.slice(COMPACT_PREFIX.length);
    const envelope = JSON.parse(Buffer.from(encodedEnvelope, "base64url").toString("utf8")) as {
        checksum?: string;
        preview: string;
    };

    envelope.checksum = "ffffffffffffffffffffffff";
    const tampered = `${COMPACT_PREFIX}${Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url")}`;

    const tamperedAnalysis = analyzeStoredContent(tampered);
    assert.equal(tamperedAnalysis.isCompacted, true);
    assert.equal(tamperedAnalysis.integrity, "invalid_checksum");

    const tamperedRestored = resurrectContentFromStorage(tampered);
    assert.equal(tamperedRestored, envelope.preview, "checksum tampering should fall back to preview");
}

function testMcpEnvelopeCodec(): void {
    const encoded = encodeMcpCtx(
        {
            intent: " explain cx-link ",
            scope: " daemon routing ",
            concepts: ["cxlink", "cxlink", "context"],
            entities: ["route:/cxlink/context", "route:/cxlink/context"],
            constraints: ["keep contracts", "keep contracts"],
            metadata: { source: "unit-test" }
        },
        { pretty: false }
    );

    const decoded = decodeMcpCtx(encoded);
    assert.equal(decoded.version, "1.0");
    assert.equal(decoded.intent, "explain cx-link");
    assert.equal(decoded.scope, "daemon routing");
    assert.deepEqual(decoded.concepts, ["cxlink", "context"]);
    assert.deepEqual(decoded.entities, ["route:/cxlink/context"]);
    assert.deepEqual(decoded.constraints, ["keep contracts"]);
    assert.equal(decoded.metadata?.source, "unit-test");
}

function main(): void {
    testHybridScore();
    testResolveProjectRisk();
    testCompactionEnvelopeCodec();
    testMcpEnvelopeCodec();
    console.log("✅ core algorithm unit tests passed");
}

main();
