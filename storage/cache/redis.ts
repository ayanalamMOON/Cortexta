export interface RedisConfig {
    url: string;
    host: string;
    port: number;
    db: number;
    tls: boolean;
}

function readEnv(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

export function redisUrl(url = readEnv("CORTEXA_REDIS_URL") ?? "redis://localhost:6379/0"): string {
    return url;
}

export function parseRedisConfig(inputUrl = redisUrl()): RedisConfig {
    const parsed = new URL(inputUrl);
    return {
        url: inputUrl,
        host: parsed.hostname || "localhost",
        port: Number(parsed.port || (parsed.protocol === "rediss:" ? 6380 : 6379)),
        db: Number((parsed.pathname || "/0").replace("/", "") || 0),
        tls: parsed.protocol === "rediss:"
    };
}
