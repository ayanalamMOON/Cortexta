import { runIngestion } from "../core/ingestion/ingest.pipeline";

function cwd(): string {
    return process.cwd();
}

export async function syncChat(): Promise<void> {
    const result = await runIngestion({
        projectPath: cwd(),
        includeChats: true,
        maxFiles: 0
    });

    console.log(
        `[cortexa] synced chat turns=${result.chatTurns} stored=${result.memoriesStored} errors=${result.errors.length}`
    );
}

if (require.main === module) {
    void syncChat();
}
