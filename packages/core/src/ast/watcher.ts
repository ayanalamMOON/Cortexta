import chokidar from "chokidar";
import { detectLanguage } from "./language-registry";

export interface WatcherEvent {
    type: "add" | "change" | "unlink";
    filePath: string;
    timestamp: number;
}

export interface WatcherHandle {
    close: () => Promise<void>;
}

export interface StartWatcherOptions {
    ignored?: RegExp;
    includeUnknownLanguages?: boolean;
}

export function startWatcher(
    rootPath: string,
    onEvent: (event: WatcherEvent) => void,
    options: StartWatcherOptions = {}
): WatcherHandle {
    const ignored = options.ignored ?? /(^|[\/\\])\.(git|next)|node_modules|dist|build|coverage/;
    const watcher = chokidar.watch(rootPath, {
        ignored,
        persistent: true,
        ignoreInitial: true
    });

    function emit(type: WatcherEvent["type"], filePath: string): void {
        if (!options.includeUnknownLanguages) {
            const language = detectLanguage(filePath);
            if (!language) {
                return;
            }
        }

        onEvent({
            type,
            filePath,
            timestamp: Date.now()
        });
    }

    watcher.on("add", (filePath) => emit("add", filePath));
    watcher.on("change", (filePath) => emit("change", filePath));
    watcher.on("unlink", (filePath) => emit("unlink", filePath));

    return {
        close: async () => {
            await watcher.close();
        }
    };
}
