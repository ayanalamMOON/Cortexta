import type { StreamDelta } from "../stream/delta-protocol";

export interface AgentBusEvents {
    "stream:delta": StreamDelta;
    "agent:status": { agent: string; status: "idle" | "running" | "done" | "error"; message?: string; ts: number };
}

class TypedAgentBus {
    private history: StreamDelta[] = [];

    private listeners: {
        [K in keyof AgentBusEvents]: Set<(payload: AgentBusEvents[K]) => void>;
    } = {
            "stream:delta": new Set<(payload: AgentBusEvents["stream:delta"]) => void>(),
            "agent:status": new Set<(payload: AgentBusEvents["agent:status"]) => void>()
        };

    emitEvent<K extends keyof AgentBusEvents>(event: K, payload: AgentBusEvents[K]): boolean {
        if (event === "stream:delta") {
            this.history.push(payload as StreamDelta);
            if (this.history.length > 200) {
                this.history.shift();
            }
        }

        const listeners = this.listeners[event];
        listeners.forEach((listener) => {
            listener(payload);
        });

        return listeners.size > 0;
    }

    onEvent<K extends keyof AgentBusEvents>(event: K, listener: (payload: AgentBusEvents[K]) => void): this {
        this.listeners[event].add(listener);
        return this;
    }

    offEvent<K extends keyof AgentBusEvents>(event: K, listener: (payload: AgentBusEvents[K]) => void): this {
        this.listeners[event].delete(listener);
        return this;
    }

    replay(limit = 50): StreamDelta[] {
        return this.history.slice(Math.max(0, this.history.length - limit));
    }
}

export const agentBus = new TypedAgentBus();
