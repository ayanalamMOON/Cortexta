import { clampImportance } from "./importance";
import { temporalScore } from "./temporal";

export function hybridScore(similarity: number, importance: number, ageMs: number): number {
    return similarity * 0.5 + clampImportance(importance) * 0.3 + temporalScore(ageMs) * 0.2;
}
