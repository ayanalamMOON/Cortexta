import path from "node:path";

export function normalizePath(p: string): string {
    return p.replace(/\\/g, "/");
}

export function resolveFromRoot(root: string, rel: string): string {
    return path.resolve(root, rel);
}
