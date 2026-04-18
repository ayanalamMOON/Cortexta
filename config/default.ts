export const defaultConfig = {
    daemonPort: Number(process.env.CORTEXA_DAEMON_PORT ?? 4312),
    vectorProvider: process.env.CORTEXA_VECTOR_PROVIDER ?? "qdrant",
    maxContextTokens: 4000
};
