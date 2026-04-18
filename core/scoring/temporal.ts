export function temporalScore(ageMs: number, decay = 0.00000001): number {
    return Math.exp(-decay * Math.max(0, ageMs));
}
