#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

function runCliEntrypoint(entrypoint) {
    const loaded = require(entrypoint);
    const runner = loaded?.runAppsCli ?? loaded?.runCli;

    if (typeof runner !== "function") {
        throw new Error(`No CLI runner export found in ${entrypoint}`);
    }

    return Promise.resolve(runner(process.argv));
}

const distEntrypoint = path.resolve(__dirname, "../../../dist/apps/cli/src/index.js");
const srcEntrypoint = path.resolve(__dirname, "../src/index.ts");

async function main() {
    if (fs.existsSync(distEntrypoint)) {
        await runCliEntrypoint(distEntrypoint);
        return;
    }

    try {
        require("ts-node/register/transpile-only");
        await runCliEntrypoint(srcEntrypoint);
        return;
    } catch (error) {
        console.error("[cortexa] CLI entrypoint not available. Run: pnpm -r build");
        if (error) {
            console.error(error);
        }
        process.exit(1);
    }
}

void main().catch((error) => {
    console.error("[cortexa] CLI failed to start.");
    if (error) {
        console.error(error);
    }
    process.exit(1);
});
