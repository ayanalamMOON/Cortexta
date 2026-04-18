export interface LLMClient {
    completeJson<T>(args: {
        system: string;
        user: string;
        schemaHint: string;
        temperature?: number;
    }): Promise<T>;
}
