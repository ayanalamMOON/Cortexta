#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const distEntrypoint = path.resolve(__dirname, "../../../dist/apps/mcp-server/src/server.js");
if (fs.existsSync(distEntrypoint)) {
    require(distEntrypoint);
    process.exit(0);
}

const tsEntrypoint = path.resolve(__dirname, "../src/server.ts");
if (fs.existsSync(tsEntrypoint)) {
    require("ts-node/register/transpile-only");
    require(tsEntrypoint);
    process.exit(0);
}

console.error("CORTEXA MCP server entrypoint not found. Run `pnpm run build` first.");
process.exit(1);
