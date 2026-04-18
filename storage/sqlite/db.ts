import fs from "node:fs";
import path from "node:path";

type BetterSqlite3Ctor = new (filename: string) => SqliteDatabase;

export interface SqliteStatement {
    run: (...params: unknown[]) => unknown;
    get: <T = unknown>(...params: unknown[]) => T;
    all: <T = unknown>(...params: unknown[]) => T[];
}

export interface SqliteDatabase {
    exec: (sql: string) => void;
    pragma: (pragma: string) => void;
    prepare: (sql: string) => SqliteStatement;
    transaction: <T extends (...args: never[]) => unknown>(fn: T) => T;
    close: () => void;
}

let singleton: SqliteDatabase | null = null;

function readEnv(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

function cwd(): string {
    return (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() ?? ".";
}

function resolveDbPath(dbPath?: string): string {
    const configured = dbPath ?? readEnv("CORTEXA_DB_PATH") ?? path.join("data", "cortexa.db");
    return path.isAbsolute(configured) ? configured : path.resolve(cwd(), configured);
}

function toAbsoluteFromCwd(filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : path.resolve(cwd(), filePath);
}

function findSchemaPath(schemaPath?: string): string {
    const attempted = new Set<string>();

    const tryPath = (candidate: string): string | undefined => {
        const absolute = path.resolve(candidate);
        attempted.add(absolute);
        return fs.existsSync(absolute) ? absolute : undefined;
    };

    if (schemaPath) {
        const configured = toAbsoluteFromCwd(schemaPath);
        const found = tryPath(configured);
        if (found) {
            return found;
        }
        throw new Error(`Schema file not found at configured path: ${configured}`);
    }

    const directCandidates = [
        path.resolve(__dirname, "schema.sql"),
        path.resolve(cwd(), "storage", "sqlite", "schema.sql")
    ];

    for (const candidate of directCandidates) {
        const found = tryPath(candidate);
        if (found) {
            return found;
        }
    }

    const walkStarts = [cwd(), __dirname];
    for (const start of walkStarts) {
        let current = path.resolve(start);
        while (true) {
            const found = tryPath(path.join(current, "storage", "sqlite", "schema.sql"));
            if (found) {
                return found;
            }

            const parent = path.dirname(current);
            if (parent === current) {
                break;
            }
            current = parent;
        }
    }

    throw new Error(
        `Unable to locate SQLite schema file. Checked:\n- ${Array.from(attempted).join("\n- ")}`
    );
}

function ensureParentDir(filePath: string): void {
    const parent = path.dirname(filePath);
    if (!fs.existsSync(parent)) {
        fs.mkdirSync(parent, { recursive: true });
    }
}

function loadDriver(): BetterSqlite3Ctor {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const driver = require("better-sqlite3");
        return (driver.default ?? driver) as BetterSqlite3Ctor;
    } catch {
        throw new Error("Unable to load better-sqlite3. Ensure dependencies are installed via pnpm.");
    }
}

export function connectSqlite(dbPath?: string): SqliteDatabase {
    if (singleton) {
        return singleton;
    }

    const absolutePath = resolveDbPath(dbPath);
    ensureParentDir(absolutePath);

    const Database = loadDriver();
    const db = new Database(absolutePath);

    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");

    singleton = db;
    return db;
}

export function readSchema(schemaPath?: string): string {
    const resolved = findSchemaPath(schemaPath);
    return fs.readFileSync(resolved, "utf8");
}

export function initializeSqlite(db = connectSqlite(), schemaPath?: string): void {
    const schema = readSchema(schemaPath);
    db.exec(schema);
}

export function withTransaction<T>(db: SqliteDatabase, fn: () => T): T {
    const txn = db.transaction(fn as () => unknown);
    return txn() as T;
}

export function closeSqlite(): void {
    if (!singleton) {
        return;
    }

    singleton.close();
    singleton = null;
}
