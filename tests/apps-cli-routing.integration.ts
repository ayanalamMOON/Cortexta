import assert from "node:assert/strict";
import { normalizeArgv, shouldRouteToPrimaryCli } from "../apps/cli/src/index";

function argv(...tokens: string[]): string[] {
    return ["node", "cortexa", ...tokens];
}

function assertPrimaryRoute(tokens: string[], message: string): void {
    assert.equal(shouldRouteToPrimaryCli(argv(...tokens)), true, message);
}

function assertLegacyRoute(tokens: string[], message: string): void {
    assert.equal(shouldRouteToPrimaryCli(argv(...tokens)), false, message);
}

function main(): void {
    assertPrimaryRoute([], "default command should route to primary CLI home");
    assertPrimaryRoute(["--help"], "--help should route to primary CLI help");
    assertPrimaryRoute(["memory", "stats"], "memory commands should route to primary CLI");
    assertPrimaryRoute(["doctor"], "doctor should route to primary CLI");
    assertPrimaryRoute(["dashboard", "--json"], "dashboard alias should route to primary CLI");
    assertPrimaryRoute(["daemon", "status"], "daemon commands should route to primary CLI");
    assertPrimaryRoute(["ingest", "."], "ingest should route to primary CLI");
    assertPrimaryRoute(["evolve", "upgrade", "progression"], "evolve should route to primary CLI");
    assertPrimaryRoute(["agents", "list"], "agents should route to primary CLI");
    assertPrimaryRoute(["--", "memory", "stats"], "single delimiter should still route to primary CLI");
    assertPrimaryRoute(["--", "--", "memory", "stats"], "repeated delimiters should still route to primary CLI");

    assertLegacyRoute(["watch", "."], "watch should remain in legacy CLI surface");
    assertLegacyRoute(["refactor", "entity-123"], "refactor should remain in legacy CLI surface");

    const normalized = normalizeArgv(argv("--", "--", "memory", "stats"));
    assert.deepEqual(normalized.slice(2), ["memory", "stats"], "normalizeArgv should drop repeated delimiters");

    console.log("✅ apps CLI routing integration test passed");
}

main();
