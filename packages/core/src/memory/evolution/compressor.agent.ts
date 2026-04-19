import { compressorAgent } from "../../../../../agents/compressor.agent";

export interface CompressorInput {
    text: string;
    maxChars?: number;
    preserveLineBreaks?: boolean;
}

export class CompressorAgent {
    compress(input: CompressorInput): string {
        return compressorAgent(input.text, {
            maxChars: input.maxChars,
            preserveLineBreaks: input.preserveLineBreaks
        });
    }
}
