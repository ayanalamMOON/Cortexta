import fs from "node:fs";
import path from "node:path";

const REQUIRED_DIRS = ["data", "data/sessions", "data/cache", "logs"];
const REQUIRED_ENV_KEYS = ["CORTEXA_DAEMON_PORT", "CORTEXA_VECTOR_PROVIDER", "CORTEXA_VECTOR_URL", "CORTEXA_EMBEDDING_URL"];

function cwd(): string {
    return process.cwd();
}

function ensureDir(rel: string): void {
    const full = path.resolve(cwd(), rel);
    if (!fs.existsSync(full)) {
        fs.mkdirSync(full, { recursive: true });
    }
}

function ensureEnvFile(): void {
    const envPath = path.resolve(cwd(), ".env");
    if (!fs.existsSync(envPath)) {
        fs.writeFileSync(envPath, "", "utf8");
    }

    const current = fs.readFileSync(envPath, "utf8");
    const lines = current.split(/\r?\n/);
    const existing = new Set(lines.map((line) => line.split("=")[0]?.trim()).filter(Boolean));

    const additions = REQUIRED_ENV_KEYS.filter((key) => !existing.has(key)).map((key) => `${key}=`);
    if (additions.length > 0) {
        const next = `${current.trimEnd()}\n${additions.join("\n")}\n`;
        fs.writeFileSync(envPath, next, "utf8");
    }
}

export async function setup(): Promise<void> {
    for (const dir of REQUIRED_DIRS) {
        ensureDir(dir);
    }

    ensureEnvFile();
    console.log("[cortexa] setup complete: directories and env entries ensured");
}

if (require.main === module) {
    void setup();
}
