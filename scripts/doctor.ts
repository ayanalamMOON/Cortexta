import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface DoctorResult {
    ok: boolean;
    errors: string[];
    warnings: string[];
}

function parseVersion(text: string): { major: number; minor: number; patch: number } {
    const [major = "0", minor = "0", patch = "0"] = text.trim().replace(/^v/, "").split(".");
    return {
        major: Number(major),
        minor: Number(minor),
        patch: Number(patch)
    };
}

function getRequiredPnpmVersion(): string {
    const pkgPath = path.resolve(process.cwd(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { packageManager?: string };
    const pm = pkg.packageManager ?? "pnpm@9.15.0";
    return pm.startsWith("pnpm@") ? pm.slice("pnpm@".length) : "9.15.0";
}

function checkNode(result: DoctorResult): void {
    const node = parseVersion(process.versions.node);
    const ok = node.major === 22 && node.minor >= 16;

    if (!ok) {
        result.errors.push(
            `Node runtime mismatch: found ${process.versions.node}, expected >=22.16.0 and <23. Use: nvm use 22.16.0`
        );
    }
}

function checkPnpm(result: DoctorResult): void {
    const required = parseVersion(getRequiredPnpmVersion());

    try {
        const raw = execSync("pnpm -v", { encoding: "utf8" }).trim();
        const found = parseVersion(raw);
        if (found.major !== required.major) {
            result.errors.push(
                `pnpm major mismatch: found ${raw}, expected major ${required.major}. Install: npm install -g pnpm@${required.major}`
            );
            return;
        }

        if (found.minor < required.minor) {
            result.warnings.push(
                `pnpm is older than packageManager pin (${raw} < ${required.major}.${required.minor}.${required.patch}). Consider updating.`
            );
        }
    } catch {
        result.errors.push("pnpm is not installed or not available on PATH. Install: npm install -g pnpm@9.15.0");
    }
}

export async function doctor(): Promise<void> {
    const result: DoctorResult = {
        ok: true,
        errors: [],
        warnings: []
    };

    checkNode(result);
    checkPnpm(result);

    if (result.warnings.length > 0) {
        for (const warning of result.warnings) {
            console.warn(`[doctor][warn] ${warning}`);
        }
    }

    if (result.errors.length > 0) {
        result.ok = false;
        for (const error of result.errors) {
            console.error(`[doctor][error] ${error}`);
        }
        throw new Error("Doctor checks failed. Resolve toolchain issues before build.");
    }

    console.log(`[doctor] OK - node=${process.versions.node}`);
}

if (require.main === module) {
    void doctor().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}
