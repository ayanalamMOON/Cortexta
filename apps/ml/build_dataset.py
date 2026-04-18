from __future__ import annotations

import argparse
import json
import random
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator

CODE_EXTENSIONS = {
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".java",
    ".cpp",
    ".cc",
    ".cxx",
    ".c",
    ".h",
    ".hpp",
    ".go",
    ".rs",
}

SKIP_DIRS = {
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".next",
    "out",
}

KEYWORDS = {
    "if",
    "else",
    "for",
    "while",
    "switch",
    "case",
    "return",
    "class",
    "function",
    "def",
    "import",
    "from",
    "try",
    "catch",
    "finally",
    "public",
    "private",
    "protected",
    "static",
    "new",
    "const",
    "let",
    "var",
    "async",
    "await",
    "true",
    "false",
    "null",
    "undefined",
    "None",
}

IMPORT_RE = re.compile(r"^\s*(?:import\s+.+|from\s+\S+\s+import\s+.+|#include\s+[<\"][^>\"]+[>\"])", re.MULTILINE)
FUNC_RE = re.compile(
    r"^\s*(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(|"
    r"^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(|"
    r"\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\([^\)]*\)\s*=>",
    re.MULTILINE,
)
CLASS_RE = re.compile(r"^\s*(?:export\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)", re.MULTILINE)
LOOP_RE = re.compile(r"\b(for|while|do)\b")
BRANCH_RE = re.compile(r"\b(if|switch|case|elif|else\s+if)\b")
RETURN_RE = re.compile(r"\breturn\b")
IDENT_RE = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]{2,}\b")
CALL_RE = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*\(")


@dataclass
class ChunkRecord:
    source: str
    text: str
    summary: str
    struct: dict


def iter_code_files(root: Path) -> Iterator[Path]:
    for path in root.rglob("*"):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if not path.is_file():
            continue
        if path.suffix.lower() not in CODE_EXTENSIONS:
            continue
        yield path


def chunk_text(text: str, max_chars: int = 1800, min_chars: int = 180) -> list[str]:
    blocks = [block.strip() for block in re.split(r"\n\s*\n", text) if block.strip()]

    chunks: list[str] = []
    current = ""

    for block in blocks:
        candidate = block if not current else f"{current}\n\n{block}"
        if len(candidate) <= max_chars:
            current = candidate
            continue

        if current.strip() and len(current.strip()) >= min_chars:
            chunks.append(current.strip())

        if len(block) <= max_chars:
            current = block
        else:
            for i in range(0, len(block), max_chars):
                segment = block[i : i + max_chars].strip()
                if segment and len(segment) >= min_chars:
                    chunks.append(segment)
            current = ""

    if current.strip() and len(current.strip()) >= min_chars:
        chunks.append(current.strip())

    return chunks


def parse_dependencies(import_lines: list[str]) -> list[str]:
    deps: list[str] = []
    for line in import_lines:
        stripped = line.strip()
        if stripped.startswith("#include"):
            match = re.search(r"#include\s+[<\"]([^>\"]+)[>\"]", stripped)
            if match:
                deps.append(match.group(1))
            continue

        if stripped.startswith("from "):
            parts = stripped.split()
            if len(parts) >= 2:
                deps.append(parts[1])
            continue

        if stripped.startswith("import "):
            payload = stripped[len("import ") :]
            head = payload.split(" as ")[0].split(",")[0].strip()
            if head:
                deps.append(head)

    return [d for d in deps if d]


def estimate_max_depth(text: str) -> int:
    brace_depth = 0
    brace_max = 0
    for ch in text:
        if ch == "{":
            brace_depth += 1
            brace_max = max(brace_max, brace_depth)
        elif ch == "}":
            brace_depth = max(0, brace_depth - 1)

    indent_max = 0
    for line in text.splitlines():
        if not line.strip():
            continue
        leading = len(line) - len(line.lstrip(" "))
        indent_max = max(indent_max, leading // 4)

    return max(brace_max, indent_max)


def build_struct(chunk: str) -> dict:
    import_lines = IMPORT_RE.findall(chunk)
    functions = [name for groups in FUNC_RE.findall(chunk) for name in groups if name]
    classes = CLASS_RE.findall(chunk)

    identifiers = [token for token in IDENT_RE.findall(chunk) if token not in KEYWORDS]
    calls = [name for name in CALL_RE.findall(chunk) if name not in KEYWORDS]

    loops = len(LOOP_RE.findall(chunk))
    branches = len(BRANCH_RE.findall(chunk))
    num_returns = len(RETURN_RE.findall(chunk))

    unique_dependencies = sorted(set(parse_dependencies(import_lines)))
    unique_identifiers = sorted(set(identifiers))
    recursion_flag = any(chunk.count(f"{fn}(") >= 2 for fn in set(functions))

    avg_identifier_len = (
        sum(len(identifier) for identifier in unique_identifiers) / len(unique_identifiers)
        if unique_identifiers
        else 0.0
    )

    stats = {
        "num_functions": len(set(functions)),
        "num_classes": len(set(classes)),
        "num_interfaces": 0,
        "num_loops": loops,
        "num_branches": branches,
        "num_calls": len(calls),
        "num_imports": len(import_lines),
        "num_returns": num_returns,
        "max_depth": estimate_max_depth(chunk),
        "line_count": len(chunk.splitlines()),
        "identifier_count": len(unique_identifiers),
        "recursion_flag": recursion_flag,
        "cyclomatic_proxy": 1 + loops + branches,
        "avg_identifier_len": avg_identifier_len,
        "unique_dependency_count": len(unique_dependencies),
    }

    return {
        "stats": stats,
        "identifiers": unique_identifiers[:120],
        "dependencies": unique_dependencies,
        "imports": import_lines,
    }


def build_summary(rel_path: str, struct: dict) -> str:
    stats = struct.get("stats", {})
    identifiers = struct.get("identifiers", [])
    dependencies = struct.get("dependencies", [])

    top_ids = ", ".join(identifiers[:6]) if identifiers else "n/a"
    deps = ", ".join(dependencies[:4]) if dependencies else "none"

    return (
        f"{rel_path}: functions={stats.get('num_functions', 0)}, "
        f"classes={stats.get('num_classes', 0)}, loops={stats.get('num_loops', 0)}, "
        f"branches={stats.get('num_branches', 0)}, calls={stats.get('num_calls', 0)}, "
        f"imports={stats.get('num_imports', 0)}, depth={stats.get('max_depth', 0)}, "
        f"cyclomatic_proxy={stats.get('cyclomatic_proxy', 1)}; "
        f"top_identifiers=[{top_ids}], dependencies=[{deps}]"
    )


def collect_records(root: Path, max_chars: int, min_chars: int) -> tuple[list[ChunkRecord], int]:
    records: list[ChunkRecord] = []
    scanned_files = 0

    for file_path in iter_code_files(root):
        scanned_files += 1
        try:
            text = file_path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue

        if not text.strip():
            continue

        rel_path = file_path.relative_to(root).as_posix()
        for chunk in chunk_text(text, max_chars=max_chars, min_chars=min_chars):
            struct = build_struct(chunk)
            summary = build_summary(rel_path, struct)
            records.append(
                ChunkRecord(
                    source=rel_path,
                    text=chunk,
                    summary=summary,
                    struct=struct,
                )
            )

    return records, scanned_files


def make_pairs(records: list[ChunkRecord], seed: int, max_pairs: int | None = None) -> tuple[list[dict], int, int]:
    rng = random.Random(seed)
    if len(records) < 2:
        return [], 0, 0

    positives = [
        {
            "text_a": record.text,
            "text_b": record.summary,
            "struct_a": record.struct,
            "struct_b": record.struct,
            "label": 0.92,
            "source": record.source,
            "pair_type": "positive",
        }
        for record in records
    ]

    indices = list(range(len(records)))
    shuffled = indices[:]
    rng.shuffle(shuffled)

    negatives: list[dict] = []
    for i, record in enumerate(records):
        j = shuffled[i]
        if j == i:
            j = (j + 1) % len(records)
        other = records[j]

        negatives.append(
            {
                "text_a": record.text,
                "text_b": other.summary,
                "struct_a": record.struct,
                "struct_b": other.struct,
                "label": 0.08,
                "source": record.source,
                "neg_source": other.source,
                "pair_type": "negative",
            }
        )

    pairs = positives + negatives
    rng.shuffle(pairs)

    if max_pairs is not None and len(pairs) > max_pairs:
        pairs = pairs[:max_pairs]

    return pairs, len(positives), len(negatives)


def write_jsonl(rows: Iterable[dict], output_path: Path) -> int:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with output_path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            count += 1
    return count


def main() -> None:
    here = Path(__file__).resolve()
    default_root = here.parents[2]

    parser = argparse.ArgumentParser(description="Build real training pairs from local code data")
    parser.add_argument("--root", type=Path, default=default_root, help="Project root to mine")
    parser.add_argument("--output", type=Path, default=default_root / "data" / "training" / "pairs.jsonl")
    parser.add_argument("--manifest", type=Path, default=default_root / "data" / "training" / "manifest.json")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--max-chars", type=int, default=1800)
    parser.add_argument("--min-chars", type=int, default=180)
    parser.add_argument("--max-pairs", type=int, default=12000)
    args = parser.parse_args()

    root = args.root.resolve()
    records, scanned_files = collect_records(root, max_chars=args.max_chars, min_chars=args.min_chars)

    if len(records) < 2:
        raise RuntimeError(
            f"Insufficient real code chunks for training pair generation under {root}. Found {len(records)} chunks."
        )

    pairs, positive_count, negative_count = make_pairs(records, seed=args.seed, max_pairs=args.max_pairs)
    written = write_jsonl(pairs, args.output)

    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "projectRoot": str(root),
        "filesScanned": scanned_files,
        "chunksCollected": len(records),
        "pairsWritten": written,
        "positivePairs": positive_count,
        "negativePairs": negative_count,
        "output": str(args.output.resolve()),
    }

    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
