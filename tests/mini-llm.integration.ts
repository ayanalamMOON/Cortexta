import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    generateMiniLlmText,
    getCortexaLlmClient,
    getMiniLlmStatus,
    resetMiniLlmRuntimeCacheForTests,
    suggestMiniLlmTags,
    trainMiniLlm
} from "../core/llm/mini-llm.service";

async function seedProject(rootPath: string): Promise<void> {
    await fs.mkdir(path.join(rootPath, "src"), { recursive: true });
    await fs.mkdir(path.join(rootPath, "docs"), { recursive: true });

    await fs.writeFile(
        path.join(rootPath, "src", "memory.ts"),
        [
            "export function evolveMemory(query: string): string {",
            "  const normalized = query.trim().toLowerCase();",
            "  if (!normalized) return 'no-op';",
            "  return `progression:${normalized}`;",
            "}",
            "",
            "export function evaluateSignal(score: number): 'reject' | 'compress' | 'store' | 'merge' {",
            "  if (score >= 0.8) return 'merge';",
            "  if (score >= 0.6) return 'store';",
            "  if (score >= 0.4) return 'compress';",
            "  return 'reject';",
            "}"
        ].join("\n"),
        "utf8"
    );

    await fs.writeFile(
        path.join(rootPath, "docs", "notes.md"),
        [
            "# Cortexa evolution notes",
            "",
            "Progression telemetry should include proposed candidate count and selected score.",
            "Model-guided consolidation should preserve high-signal memory and merge related entries.",
            "When novelty is low, compressor action reduces token overhead before storage."
        ].join("\n"),
        "utf8"
    );
}

function hasImmediateRepeatedTriplet(text: string): boolean {
    const tokens = (text.toLowerCase().match(/[a-z0-9_]+|[^\s]/g) ?? []).filter(Boolean);
    if (tokens.length < 6) {
        return false;
    }

    for (let index = 6; index <= tokens.length; index += 1) {
        const previousTriplet = tokens.slice(index - 6, index - 3).join(" ");
        const currentTriplet = tokens.slice(index - 3, index).join(" ");
        if (previousTriplet && previousTriplet === currentTriplet) {
            return true;
        }
    }

    return false;
}

function containsAnyDomainToken(text: string, domainTokens: string[]): boolean {
    const tokens = new Set((text.toLowerCase().match(/[a-z0-9_]+|[^\s]/g) ?? []).filter(Boolean));
    return domainTokens.some((token) => tokens.has(token.toLowerCase()));
}

async function main(): Promise<void> {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cortexa-mini-llm-"));
    const modelPath = path.join(tempRoot, "model", "mini.q8.json");

    const previousMode = process.env.CORTEXA_LLM_MODE;
    const previousModelPath = process.env.CORTEXA_LLM_MODEL_PATH;

    try {
        process.env.CORTEXA_LLM_MODE = "mini-local";
        process.env.CORTEXA_LLM_MODEL_PATH = modelPath;
        resetMiniLlmRuntimeCacheForTests();

        await seedProject(tempRoot);

        const trained = await trainMiniLlm({
            projectPath: tempRoot,
            includeMemoryStore: false,
            modelPath,
            maxFiles: 200,
            maxCorpusChars: 300_000,
            maxVocab: 512,
            maxTransitionsPerToken: 24
        });

        assert.ok(trained.vocabSize > 20, "vocab size should be populated");
        assert.ok(trained.transitionRows > 0, "transition rows should exist");
        assert.equal(trained.modelPath, modelPath, "model path should match requested output path");

        const status = getMiniLlmStatus();
        assert.equal(status.modelExists, true, "model should exist after training");

        const preview = await generateMiniLlmText("improve progression telemetry and merge memory anchors", {
            maxTokens: 32
        });
        assert.ok(preview.trim().length > 0, "generated preview should not be empty");
        assert.equal(/^[^a-z0-9_]/i.test(preview.trim()), false, "generated preview should start with lexical token");
        assert.equal(
            hasImmediateRepeatedTriplet(preview),
            false,
            "generated preview should not contain immediate repeated triplets"
        );
        assert.equal(
            containsAnyDomainToken(preview, ["progression", "telemetry", "merge", "memory"]),
            true,
            "generated preview should preserve at least one domain token"
        );

        const suggestedTags = await suggestMiniLlmTags(
            "improve progression telemetry and merge memory anchors for ingestion memory storage",
            { maxTags: 6 }
        );
        assert.ok(suggestedTags.length > 0, "suggested tags should be produced");
        assert.equal(
            suggestedTags.some((tag) => ["progression", "telemetry", "merge", "memory", "ingestion"].includes(tag)),
            true,
            "suggested tags should preserve domain-relevant terms"
        );

        const llm = getCortexaLlmClient();

        const writer = await llm.completeJson<{
            candidates: Array<{ title: string; summary: string; content: string; tags: string[] }>;
            confidence: number;
        }>({
            system: "Generate candidate memory atoms.",
            user: JSON.stringify({
                text: "Upgrade progression telemetry to track selected candidate score",
                projectId: "mini-llm-test"
            }),
            schemaHint: "{ candidates: [{ kind, title, summary, content, tags, sourceRef }], confidence }"
        });

        assert.ok(Array.isArray(writer.candidates), "writer output should include candidates array");
        assert.ok(writer.candidates.length >= 1, "writer should emit at least one candidate");
        assert.ok(writer.candidates[0]!.content.length > 0, "writer candidate should include content");

        const critic = await llm.completeJson<{
            accepted: boolean;
            score: number;
            novelty: number;
            clarity: number;
            action: string;
            reason: string;
        }>({
            system: "Evaluate memory candidate quality.",
            user: JSON.stringify({
                title: "Progression telemetry update",
                summary: "Track selected score, merge action, and stage traces for memory evolution.",
                existingSnippets: ["Track selected score"]
            }),
            schemaHint: "{ accepted, score, novelty, redundancy, clarity, action, reason, mergeKey? }"
        });

        assert.equal(typeof critic.accepted, "boolean", "critic output should include accepted boolean");
        assert.ok(critic.score >= 0 && critic.score <= 1, "critic score should be normalized");

        const merged = await llm.completeJson<{
            title: string;
            summary: string;
            content: string;
            tags: string[];
            confidence: number;
        }>({
            system: "Merge overlapping memory atoms.",
            user: JSON.stringify({
                candidate: {
                    title: "Progression telemetry update",
                    summary: "Track selected score and merge path",
                    content: "Track selected score and merge path with stage telemetry",
                    tags: ["progression", "telemetry"],
                    confidence: 0.64
                },
                neighbors: [
                    {
                        title: "Telemetry history",
                        summary: "Persist progression run history and branch telemetry",
                        tags: ["telemetry", "history"]
                    }
                ]
            }),
            schemaHint: "{ title, summary, content, tags, confidence }"
        });

        assert.ok(merged.summary.length > 0, "consolidator summary should be populated");
        assert.ok(Array.isArray(merged.tags), "consolidator tags should be array");
        assert.ok(merged.confidence >= 0 && merged.confidence <= 1, "consolidator confidence should be normalized");

        console.log("✅ mini LLM integration test passed");
    } finally {
        if (previousMode === undefined) {
            delete process.env.CORTEXA_LLM_MODE;
        } else {
            process.env.CORTEXA_LLM_MODE = previousMode;
        }

        if (previousModelPath === undefined) {
            delete process.env.CORTEXA_LLM_MODEL_PATH;
        } else {
            process.env.CORTEXA_LLM_MODEL_PATH = previousModelPath;
        }

        resetMiniLlmRuntimeCacheForTests();
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error("❌ mini LLM integration test failed");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
