from __future__ import annotations

from typing import Any, Dict, List

FEATURE_NAMES = [
    "num_functions",
    "num_classes",
    "num_interfaces",
    "num_loops",
    "num_branches",
    "num_calls",
    "num_imports",
    "num_returns",
    "max_depth",
    "line_count",
    "identifier_count",
    "recursion_flag",
    "cyclomatic_proxy",
    "avg_identifier_len",
    "unique_dependency_count",
]


def _to_float(value: Any, default: float = 0.0) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0

    if isinstance(value, (int, float)):
        return float(value)

    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return default

    return default


def _count(value: Any) -> float:
    if isinstance(value, (list, tuple, set, dict)):
        return float(len(value))
    return _to_float(value, 0.0)


def build_feature_vector(entity_json: Dict[str, Any]) -> List[float]:
    """
    Build a fixed-size structural feature vector.

    Accepts both blueprint shape (nested `stats`) and legacy flat counters.
    """
    source = entity_json if isinstance(entity_json, dict) else {}
    stats = source.get("stats") if isinstance(source.get("stats"), dict) else {}

    dependencies = source.get("dependencies") if isinstance(source.get("dependencies"), list) else []
    identifiers = source.get("identifiers") if isinstance(source.get("identifiers"), list) else []

    imports = stats.get("imports", source.get("imports", []))

    line_count = _to_float(stats.get("line_count", source.get("line_count", source.get("lines", 0))))
    identifier_count = _to_float(stats.get("identifier_count", source.get("identifier_count", len(identifiers))))

    avg_identifier_len = _to_float(stats.get("avg_identifier_len", source.get("avg_identifier_len", 0.0)))
    if avg_identifier_len == 0.0 and identifiers:
        avg_identifier_len = sum(len(str(item)) for item in identifiers) / float(len(identifiers))

    recursion_flag = _to_float(stats.get("recursion_flag", source.get("recursion_flag", False)))
    cyclomatic_proxy = _to_float(stats.get("cyclomatic_proxy", source.get("cyclomatic_proxy", 0.0)))

    return [
        _to_float(stats.get("num_functions", source.get("num_functions", source.get("functions", 0)))),
        _to_float(stats.get("num_classes", source.get("num_classes", source.get("classes", 0)))),
        _to_float(stats.get("num_interfaces", source.get("num_interfaces", source.get("interfaces", 0)))),
        _to_float(stats.get("num_loops", source.get("num_loops", source.get("loops", 0)))),
        _to_float(stats.get("num_branches", source.get("num_branches", source.get("branches", 0)))),
        _to_float(stats.get("num_calls", source.get("num_calls", source.get("calls", 0)))),
        _count(stats.get("num_imports", source.get("num_imports", imports))),
        _to_float(stats.get("num_returns", source.get("num_returns", source.get("returns", 0)))),
        _to_float(stats.get("max_depth", source.get("max_depth", source.get("depth", 0)))),
        line_count,
        identifier_count,
        recursion_flag,
        cyclomatic_proxy,
        avg_identifier_len,
        _to_float(stats.get("unique_dependency_count", source.get("unique_dependency_count", len(set(dependencies))))),
    ]


def pad_or_trim(vec: List[float], size: int = 15) -> List[float]:
    if len(vec) >= size:
        return vec[:size]
    return vec + [0.0] * (size - len(vec))
