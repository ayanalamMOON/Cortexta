import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function main(): Promise<void> {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortexa-ingest-scope-"));
    const tempDbPath = path.join(tempRoot, "cortexa-ingest-scope.db");
    const projectPath = path.join(tempRoot, "project");
    const workspaceStorageRoot = path.join(tempRoot, "workspaceStorage");
    const projectId = "ingestion-workspace-scope-test";

    const originalAppData = process.env.APPDATA;
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;

    process.env.CORTEXA_DB_PATH = tempDbPath;
    process.env.CORTEXA_VECTOR_PROVIDER = "memory";
    process.env.APPDATA = path.join(tempRoot, "appdata-empty");
    process.env.HOME = path.join(tempRoot, "home-empty");
    process.env.USERPROFILE = path.join(tempRoot, "home-empty");

    fs.mkdirSync(projectPath, { recursive: true });
    fs.mkdirSync(path.join(projectPath, "src"), { recursive: true });
    fs.mkdirSync(path.join(projectPath, ".venv", "lib", "site-packages"), { recursive: true });

    fs.writeFileSync(
        path.join(projectPath, "src", "main.ts"),
        [
            "export function hello(name: string): string {",
            "  return `hello ${name}`;",
            "}"
        ].join("\n"),
        "utf8"
    );

    fs.writeFileSync(
        path.join(projectPath, ".venv", "lib", "site-packages", "ignored.py"),
        "def ignored():\n    return 'ignored'\n",
        "utf8"
    );

    const matchingWorkspace = path.join(workspaceStorageRoot, "match-workspace");
    const otherWorkspace = path.join(workspaceStorageRoot, "other-workspace");

    fs.mkdirSync(path.join(matchingWorkspace, "GitHub.copilot-chat", "transcripts"), { recursive: true });
    fs.mkdirSync(path.join(otherWorkspace, "GitHub.copilot-chat", "transcripts"), { recursive: true });

    fs.writeFileSync(
        path.join(matchingWorkspace, "workspace.json"),
        JSON.stringify({ folder: pathToFileURL(projectPath).toString() }, null, 2),
        "utf8"
    );

    fs.writeFileSync(
        path.join(otherWorkspace, "workspace.json"),
        JSON.stringify({ folder: pathToFileURL(path.join(tempRoot, "another-project")).toString() }, null, 2),
        "utf8"
    );

    fs.writeFileSync(
        path.join(matchingWorkspace, "GitHub.copilot-chat", "transcripts", "matching.json"),
        JSON.stringify({
            requests: [
                {
                    prompt: "How should we implement ingest?",
                    response: "Use runIngestion with workspace-scoped chat discovery."
                }
            ]
        }),
        "utf8"
    );

    fs.writeFileSync(
        path.join(otherWorkspace, "GitHub.copilot-chat", "transcripts", "other.json"),
        JSON.stringify({
            requests: [
                {
                    prompt: "This should not be ingested",
                    response: "Different workspace"
                }
            ]
        }),
        "utf8"
    );

    const { runIngestion } = require("../core/ingestion/ingest.pipeline") as {
        runIngestion: (input: Record<string, unknown>) => Promise<{
            filesScanned: number;
            codeChunks: number;
            chatFilesScanned: number;
            chatTurns: number;
            memoriesStored: number;
            errors: string[];
        }>;
    };

    const { closeSqlite, connectSqlite } = require("../storage/sqlite/db") as {
        closeSqlite: () => void;
        connectSqlite: () => {
            prepare: (sql: string) => {
                get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
            };
        };
    };

    const result = await runIngestion({
        projectPath,
        projectId,
        includeChats: true,
        skipUnchanged: false,
        chatSearchRoots: [workspaceStorageRoot]
    });

    assert.equal(result.filesScanned, 1, "ingestion should skip .venv and scan only source files");
    assert.ok(result.codeChunks >= 1, "code ingestion should still produce chunks");
    assert.equal(result.chatFilesScanned, 1, "only matching workspace chat transcript should be scanned");
    assert.equal(result.chatTurns, 1, "matching workspace chat transcript should yield one turn");
    assert.ok(result.memoriesStored >= 2, "ingestion should store both code and chat memories");
    assert.equal(result.errors.length, 0, "ingestion should complete without parse errors");

    const sqlite = connectSqlite();

    const parseTags = (serialized: unknown): string[] => {
        if (typeof serialized !== "string" || !serialized.trim()) {
            return [];
        }

        try {
            const parsed = JSON.parse(serialized) as unknown;
            if (!Array.isArray(parsed)) {
                return [];
            }

            return parsed.map((entry) => String(entry)).filter(Boolean);
        } catch {
            return [];
        }
    };

    const codeRow = sqlite
        .prepare(
            `
            SELECT tags
            FROM memories
            WHERE projectId = ?
              AND kind = 'code_entity'
            ORDER BY lastAccessedAt DESC
            LIMIT 1
          `
        )
        .get<{ tags?: unknown }>(projectId);

    const chatRow = sqlite
        .prepare(
            `
            SELECT tags
            FROM memories
            WHERE projectId = ?
              AND kind = 'chat_turn'
            ORDER BY lastAccessedAt DESC
            LIMIT 1
          `
        )
        .get<{ tags?: unknown }>(projectId);

    const codeTags = parseTags(codeRow?.tags);
    const chatTags = parseTags(chatRow?.tags);

    assert.ok(codeTags.length > 0, "code memory should persist tags");
    assert.ok(chatTags.length > 0, "chat memory should persist tags");

    const codeBaseTags = new Set(["typescript", "code", "function", "file:src/main.ts"]);
    const hasCodeAutoTag = codeTags.some((tag) => !codeBaseTags.has(tag) && !tag.startsWith("file:"));
    assert.ok(hasCodeAutoTag, "ingestion should auto-enrich code memory tags");

    const hasChatAutoTag = chatTags.some(
        (tag) => tag !== "copilot" && tag !== "chat" && !tag.startsWith("chat-file:") && !tag.startsWith("file:")
    );
    assert.ok(hasChatAutoTag, "ingestion should auto-enrich chat memory tags");

    closeSqlite();

    if (originalAppData !== undefined) {
        process.env.APPDATA = originalAppData;
    } else {
        delete process.env.APPDATA;
    }

    if (originalHome !== undefined) {
        process.env.HOME = originalHome;
    } else {
        delete process.env.HOME;
    }

    if (originalUserProfile !== undefined) {
        process.env.USERPROFILE = originalUserProfile;
    } else {
        delete process.env.USERPROFILE;
    }

    fs.rmSync(tempRoot, { recursive: true, force: true });

    console.log("✅ ingestion workspace scope integration test passed");
}

main().catch((error) => {
    console.error("❌ ingestion workspace scope integration test failed");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
