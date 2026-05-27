import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIngestPolicyRuntime, resolveIngestPolicy } from "../core/ingestion/ingest.policy";

async function writePolicy(root: string, policy: unknown, fileName = "cortexa.policy.json"): Promise<string> {
    const filePath = path.join(root, fileName);
    await fs.writeFile(filePath, JSON.stringify(policy, null, 2), "utf8");
    return filePath;
}

async function main(): Promise<void> {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cortexa-policy-"));

    try {
        const policyPath = await writePolicy(tempRoot, {
            includeGlobs: ["src/**/*.ts"],
            excludeGlobs: ["**/*.spec.ts"],
            maxFileBytes: 1024,
            languages: ["typescript"],
            chat: {
                enabled: false,
                roots: ["./.vscode/workspaceStorage"],
                maxFiles: 5
            },
            redaction: {
                maskSecrets: true,
                maskPII: true,
                customPatterns: ["SENSITIVE_[A-Z]+"]
            }
        });

        const resolution = resolveIngestPolicy({ projectPath: tempRoot });
        assert.equal(resolution.errors.length, 0, "policy should validate");

        const runtime = buildIngestPolicyRuntime({ projectPath: tempRoot, resolution });
        assert.equal(runtime.policyPath, policyPath, "policy path should resolve");
        assert.equal(runtime.chatEnabled, false, "chat should be disabled by policy");
        assert.equal(runtime.maxFileBytes, 1024, "maxFileBytes should be applied");

        const includePath = path.join(tempRoot, "src", "index.ts");
        const excludePath = path.join(tempRoot, "src", "index.spec.ts");
        assert.equal(runtime.shouldIncludePath(includePath), true, "include glob should match");
        assert.equal(runtime.shouldIncludePath(excludePath), false, "exclude glob should block file");

        const redacted = runtime.redact(
            "Email test@example.com token sk-12345678901234567890 and SENSITIVE_TOKEN"
        );
        assert.equal(redacted.redacted, true, "redaction should be applied");
        assert.equal(redacted.text.includes("test@example.com"), false, "email should be redacted");
        assert.equal(
            redacted.text.includes("sk-12345678901234567890"),
            false,
            "secret token should be redacted"
        );
        assert.equal(redacted.text.includes("SENSITIVE_TOKEN"), false, "custom pattern should be redacted");
    } finally {
        await fs.rm(tempRoot, { recursive: true, force: true });
    }

    const invalidRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cortexa-policy-invalid-"));
    try {
        const badPolicyPath = await writePolicy(
            invalidRoot,
            {
                maxFileBytes: -4,
                languages: "typescript",
                redaction: { customPatterns: ["("] }
            },
            "bad.policy.json"
        );

        const invalid = resolveIngestPolicy({ projectPath: invalidRoot, policyPath: badPolicyPath });
        assert.ok(invalid.errors.length >= 1, "invalid policy should report errors");
    } finally {
        await fs.rm(invalidRoot, { recursive: true, force: true });
    }

    console.log("✅ ingest policy unit test passed");
}

main().catch((error) => {
    console.error("❌ ingest policy unit test failed");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
