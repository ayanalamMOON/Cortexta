import { Command } from "commander";
import { getMemoryById, searchMemories } from "../../../../core/mempalace/memory.service";
import { logger } from "../utils/logger";

function buildRefactorPlan(title: string, summary: string, content: string): string[] {
    const bullets: string[] = [];
    const lowered = `${title}\n${summary}\n${content}`.toLowerCase();

    if (lowered.includes("duplicate") || lowered.includes("redundant")) {
        bullets.push("Identify repeated logic and extract shared utility/module.");
    }
    if (lowered.includes("long") || lowered.includes("complex")) {
        bullets.push("Split large function/class into focused units with explicit interfaces.");
    }
    if (lowered.includes("state") || lowered.includes("mutable")) {
        bullets.push("Isolate mutable state behind a small API and add invariants.");
    }
    if (lowered.includes("error") || lowered.includes("exception")) {
        bullets.push("Introduce typed error boundaries and consistent error propagation.");
    }

    bullets.push("Add/refresh targeted tests for critical control flow before code changes.");
    bullets.push("Refactor in small commits and re-run build/tests after each step.");
    return bullets;
}

export const refactorCommand = new Command("refactor")
    .argument("<entityId>", "Graph or memory entity id")
    .description("Generate and preview refactor plan")
    .action(async (entityId: string) => {
        const exact = getMemoryById(entityId);
        const memory = exact ?? (await searchMemories(entityId, { topK: 1 }))[0] ?? null;

        if (!memory) {
            logger.warn(`No memory/entity found for: ${entityId}`);
            return;
        }

        const plan = buildRefactorPlan(memory.title, memory.summary, memory.content);
        logger.info(`Refactor plan for [${memory.kind}] ${memory.title} (${memory.id})`);
        logger.info(`Summary: ${memory.summary}`);
        plan.forEach((step, index) => {
            logger.info(`${index + 1}. ${step}`);
        });
    });
