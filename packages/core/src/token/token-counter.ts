import { encoding_for_model, get_encoding } from "tiktoken";

interface EncodingLike {
    encode: (text: string) => number[];
    free?: () => void;
}

export class TokenCounter {
    private encoding: EncodingLike;

    constructor(model = "gpt-4o-mini") {
        try {
            this.encoding = encoding_for_model(model as never) as unknown as EncodingLike;
        } catch {
            this.encoding = get_encoding("cl100k_base") as unknown as EncodingLike;
        }
    }

    countText(text: string): number {
        return this.encoding.encode(text).length;
    }

    countJson(value: unknown): number {
        return this.countText(JSON.stringify(value));
    }

    free(): void {
        this.encoding.free?.();
    }
}
