#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const distEntrypoint = path.resolve(__dirname, "../../../dist/apps/cli/src/index.js");
if (fs.existsSync(distEntrypoint)) {
    require(distEntrypoint);
    process.exit(0);
}

const srcEntrypoint = path.resolve(__dirname, "../src/index.ts");
try {
    require("ts-node/register/transpile-only");
    require(srcEntrypoint);
} catch (error) {
    console.error("[cortexa] CLI entrypoint not available. Run: pnpm -r build");
    if (error) {
        console.error(error);
    }
    process.exit(1);
}
