"""티어별 벤치마크 경로 기본값과 경로 해석을 제공합니다."""

from __future__ import annotations

from pathlib import Path
from typing import Optional, Tuple


TIER_DEFAULT_PATHS = {
    1: (
        "maze_sets",
        "outputs",
        "public/benchmark_results.json",
    ),
    2: (
        "maze_sets_tier2",
        "outputs/tier2",
        "public/benchmark_results_tier2.json",
    ),
}


def resolve_tier_paths(
    root: Path,
    tier: int,
    maze_dir: Optional[str],
    output_dir: Optional[str],
    public_output: Optional[str],
) -> Tuple[Path, Path, Path]:
    """티어 기본 경로와 명시 경로를 실제 파일 시스템 경로로 변환합니다."""
    defaults = TIER_DEFAULT_PATHS[tier]
    maze_path = maze_dir if maze_dir is not None else defaults[0]
    result_path = output_dir if output_dir is not None else defaults[1]
    public_path = public_output if public_output is not None else defaults[2]
    return (
        (root / maze_path).resolve(),
        (root / result_path).resolve(),
        (root / public_path).resolve(),
    )
