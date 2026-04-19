import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo, Server } from "node:net";
import os from "node:os";
import path from "node:path";

function authHeaders(token: string): Record<string, string> {
    return {
        "content-type": "application/json",
        "x-cortexa-token": token
    };
}

async function postJson(baseUrl: string, route: string, body: unknown, token: string): Promise<Response> {
    return fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify(body)
    });
}

async function expectStatus(response: Response, expected: number, context: string): Promise<void> {
    if (response.status === expected) {
        return;
    }

    const text = await response.text();
    throw new Error(`${context} expected status ${expected}, got ${response.status}. body=${text}`);
}

async function waitForNextTick(after: number): Promise<number> {
    let now = Date.now();
    while (now <= after) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        now = Date.now();
    }
    return now;
}

async function main(): Promise<void> {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortexa-branch-temporal-"));
    const tempDbPath = path.join(tempRoot, "cortexa-branch-temporal.db");
    const token = "branch-temporal-token";

    process.env.CORTEXA_DB_PATH = tempDbPath;
    process.env.CORTEXA_DAEMON_TOKEN = token;
    process.env.CORTEXA_DAEMON_AUTOSTART = "0";

    const { createDaemonApp } = require("../apps/daemon/src/server") as {
        createDaemonApp: () => {
            listen: (port: number, host: string) => Server;
        };
    };

    const { buildProactiveContextSuggestion } = require("../core/context/proactive") as {
        buildProactiveContextSuggestion: (params: {
            query: string;
            projectId?: string;
            branch?: string;
            asOf?: number;
        }) => {
            intent: {
                confidence: number;
            };
            recommendedTopK: number;
        };
    };

    const {
        createMemoryBranch,
        deleteMemory,
        diffMemoriesBetween,
        getMemoryById,
        listMemoryBranches,
        mergeMemoryBranch,
        searchMemories,
        upsertMemory
    } = require("../core/mempalace/memory.service") as {
        createMemoryBranch: (input: {
            projectId: string;
            branch: string;
            fromBranch?: string;
            forkedFromCommit?: string;
        }) => {
            branch: string;
        };
        deleteMemory: (id: string, options?: { projectId?: string; branch?: string }) => Promise<void>;
        diffMemoriesBetween: (options: {
            projectId: string;
            branch?: string;
            from: number;
            to: number;
            limit?: number;
        }) => {
            totals: {
                modified: number;
                added: number;
                removed: number;
            };
        };
        getMemoryById: (id: string, options?: { projectId?: string; branch?: string }) => Record<string, unknown> | null;
        listMemoryBranches: (projectId: string) => Array<{ branch: string }>;
        mergeMemoryBranch: (input: {
            projectId: string;
            sourceBranch: string;
            targetBranch: string;
            strategy?: "source-wins" | "target-wins";
        }) => Promise<{ appliedUpserts: number }>;
        searchMemories: (query: string, options?: Record<string, unknown>) => Promise<Array<{ id?: string; logicalId?: string }>>;
        upsertMemory: (input: Record<string, unknown>) => Promise<{ createdAt: number }>;
    };

    const { closeSqlite } = require("../storage/sqlite/db") as {
        closeSqlite: () => void;
    };

    const projectId = "branch-temporal-integration";
    const logicalId = "memory.feature.auth.guard";

    await upsertMemory({
        id: logicalId,
        projectId,
        branch: "main",
        kind: "code_entity",
        sourceType: "manual",
        title: "Auth guard baseline",
        summary: "Main branch baseline auth guard behavior.",
        content: "main branch baseline behavior",
        tags: ["auth", "baseline"],
        embedding: []
    });

    const afterMain = Date.now();

    const featureBranch = createMemoryBranch({
        projectId,
        branch: "feature/auth-refactor",
        fromBranch: "main",
        forkedFromCommit: "commit-main-001"
    });
    assert.equal(featureBranch.branch, "feature/auth-refactor", "feature branch should be created");

    await waitForNextTick(afterMain);
    const featureUpsert = await upsertMemory({
        id: logicalId,
        projectId,
        branch: "feature/auth-refactor",
        kind: "code_entity",
        sourceType: "manual",
        title: "Auth guard feature branch",
        summary: "Feature branch auth guard behavior.",
        content: "feature branch auth behavior with stricter checks",
        tags: ["auth", "feature"],
        embedding: []
    });

    const afterFeature = Date.now();

    const featureSearch = await searchMemories("stricter checks", {
        projectId,
        branch: "feature/auth-refactor",
        topK: 10,
        minScore: 0
    });
    assert.ok(featureSearch.some((row) => (row.logicalId ?? row.id) === logicalId), "feature branch search should resolve branch override");

    const mainSearch = await searchMemories("stricter checks", {
        projectId,
        branch: "main",
        topK: 10,
        minScore: 0
    });
    assert.ok(
        !mainSearch.some((row) => (row.logicalId ?? row.id) === logicalId),
        "main branch search should not include feature override"
    );

    const releaseBranchMemoryId = "memory.feature.release.only";
    await upsertMemory({
        id: releaseBranchMemoryId,
        projectId,
        branch: "feature/auth-refactor",
        kind: "semantic",
        sourceType: "manual",
        title: "Release candidate note",
        summary: "Feature-only release candidate details.",
        content: "feature-only candidate should merge into release",
        tags: ["release", "feature"],
        embedding: []
    });

    await waitForNextTick(afterFeature);
    await deleteMemory(logicalId, {
        projectId,
        branch: "feature/auth-refactor"
    });

    const afterDelete = Date.now();

    const timeTravelBeforeDelete = await searchMemories("stricter checks", {
        projectId,
        branch: "feature/auth-refactor",
        asOf: featureUpsert.createdAt,
        topK: 10,
        minScore: 0
    });
    assert.ok(
        timeTravelBeforeDelete.some((row) => (row.logicalId ?? row.id) === logicalId),
        "as-of search should return pre-delete branch override"
    );

    const timeTravelAfterDelete = await searchMemories("stricter checks", {
        projectId,
        branch: "feature/auth-refactor",
        asOf: afterDelete + 1,
        topK: 10,
        minScore: 0
    });
    assert.ok(
        !timeTravelAfterDelete.some((row) => (row.logicalId ?? row.id) === logicalId),
        "as-of search after delete should hide deleted branch override"
    );

    const diff = diffMemoriesBetween({
        projectId,
        branch: "feature/auth-refactor",
        from: afterMain,
        to: afterDelete + 1,
        limit: 100
    });
    assert.ok(
        diff.totals.modified + diff.totals.removed + diff.totals.added >= 1,
        "temporal diff should detect branch changes"
    );

    const merge = await mergeMemoryBranch({
        projectId,
        sourceBranch: "feature/auth-refactor",
        targetBranch: "release/next",
        strategy: "source-wins"
    });
    assert.ok(merge.appliedUpserts >= 1, "merge should apply at least one upsert into target branch");

    const mergedMemory = getMemoryById(releaseBranchMemoryId, {
        projectId,
        branch: "release/next"
    });
    assert.ok(mergedMemory, "merged branch should expose source branch additions");

    const suggestion = buildProactiveContextSuggestion({
        query: "fix failing integration test timeout in auth module",
        projectId,
        branch: "release/next"
    });
    assert.ok(suggestion.intent.confidence > 0, "proactive suggestion should infer non-zero confidence");
    assert.ok(suggestion.recommendedTopK >= 10, "proactive suggestion should provide tuned topK");

    const branches = listMemoryBranches(projectId).map((branchRow) => branchRow.branch);
    assert.ok(branches.includes("main"), "branch list should always include main");
    assert.ok(branches.includes("feature/auth-refactor"), "branch list should include created feature branch");

    const app = createDaemonApp();
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address() as AddressInfo | null;
    if (!address?.port) {
        throw new Error("failed to bind daemon test server");
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
        const branchListResponse = await postJson(baseUrl, "/cxlink/branch/list", { projectId }, token);
        await expectStatus(branchListResponse, 200, "cxlink/branch/list");
        const branchListBody = (await branchListResponse.json()) as {
            branches?: Array<{ branch?: string }>;
        };
        assert.ok(
            branchListBody.branches?.some((row) => row.branch === "release/next"),
            "cxlink branch list should include merged target branch"
        );

        const switchResponse = await postJson(
            baseUrl,
            "/cxlink/branch/switch",
            {
                projectId,
                fromBranch: "release/next",
                toBranch: "ops/hotfix",
                reason: "integration-switch"
            },
            token
        );
        await expectStatus(switchResponse, 200, "cxlink/branch/switch");
        const switchBody = (await switchResponse.json()) as {
            switched?: { toBranch?: string };
            streamEvent?: { payload?: { eventType?: string } };
        };
        assert.equal(switchBody.switched?.toBranch, "ops/hotfix", "switch endpoint should acknowledge target branch");
        assert.equal(
            switchBody.streamEvent?.payload?.eventType,
            "branchSwitched",
            "switch endpoint should emit branchSwitched stream event payload"
        );

        const suggestResponse = await postJson(
            baseUrl,
            "/context/suggest",
            {
                query: "investigate failing auth integration test",
                projectId,
                branch: "ops/hotfix",
                warmup: true
            },
            token
        );
        await expectStatus(suggestResponse, 200, "context/suggest");
        const suggestBody = (await suggestResponse.json()) as {
            suggestion?: { intent?: { category?: string } };
            warmedContext?: { context?: string };
        };
        assert.equal(typeof suggestBody.suggestion?.intent?.category, "string", "suggest route should return intent category");
        assert.equal(typeof suggestBody.warmedContext?.context, "string", "suggest warmup should include compiled context");

        const temporalDiffResponse = await postJson(
            baseUrl,
            "/cxlink/temporal/diff",
            {
                projectId,
                branch: "feature/auth-refactor",
                from: afterMain,
                to: afterDelete + 1,
                limit: 50
            },
            token
        );
        await expectStatus(temporalDiffResponse, 200, "cxlink/temporal/diff");
        const temporalDiffBody = (await temporalDiffResponse.json()) as {
            diff?: { totals?: { modified?: number; added?: number; removed?: number } };
        };
        const totalChanges =
            Number(temporalDiffBody.diff?.totals?.modified ?? 0) +
            Number(temporalDiffBody.diff?.totals?.added ?? 0) +
            Number(temporalDiffBody.diff?.totals?.removed ?? 0);
        assert.ok(totalChanges >= 1, "cxlink temporal diff should report at least one change");
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    closeSqlite();
    for (const candidate of [tempDbPath, `${tempDbPath}-wal`, `${tempDbPath}-shm`]) {
        if (fs.existsSync(candidate)) {
            fs.unlinkSync(candidate);
        }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });

    console.log("✅ branch + temporal + proactive integration test passed");
}

main().catch((error) => {
    console.error("❌ branch + temporal + proactive integration test failed");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
