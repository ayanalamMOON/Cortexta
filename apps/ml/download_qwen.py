from __future__ import annotations

import os

from huggingface_hub import hf_hub_download


def main() -> None:
    repo_id = os.getenv("CORTEXA_QWEN_REPO", "Qwen/Qwen2.5-1.5B-Instruct-GGUF").strip()
    filename = os.getenv("CORTEXA_QWEN_FILENAME", "qwen2.5-1.5b-instruct-q4_k_m.gguf").strip()
    local_dir = os.getenv("CORTEXA_QWEN_LOCAL_DIR", os.path.join("data", "models")).strip()
    token = (
        os.getenv("CORTEXA_LLM_HF_TOKEN")
        or os.getenv("HUGGINGFACE_TOKEN")
        or os.getenv("HF_TOKEN")
        or None
    )

    os.makedirs(local_dir, exist_ok=True)

    path = hf_hub_download(
        repo_id=repo_id,
        filename=filename,
        local_dir=local_dir,
        token=token,
    )

    print(path)


if __name__ == "__main__":
    main()
