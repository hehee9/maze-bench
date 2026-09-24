"""재현 가능한 Tier2 미로 자산 생성."""

from __future__ import annotations

import json
import math
from collections import deque
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

from maze_benchmark import DIRS, MazeGenerator, MazeProblem, save_problem


WALL_DENSITY = 0.85
IMAGE_SIZE = 2048
SIZES = (15, 18, 21, 24)
RELATIONS = (
    ("adjacent", "N", "E", 2, 1),
    ("opposite", "N", "S", 2, 3),
    ("same", "N", "N", 1, 5),
)
LARGE_OPPOSITE_SEED_LIMIT = 10_000


def minimum_coverage_ratio(size: int) -> float:
    """크기별 최소 커버리지 비율 반환."""
    return 0.25 - 0.05 * math.log(size / 18) / math.log(4 / 3)


def minimum_coverage_cells(size: int) -> int:
    """정사각형 미로의 최소 커버리지 칸 수 반환."""
    return math.ceil(minimum_coverage_ratio(size) * size * size)


def shortest_cell_coverage(problem: MazeProblem) -> int:
    """최단 내부 셀 경로의 양 끝점을 포함한 칸 수 계산."""
    start = tuple(problem.start_cell)
    goal = tuple(problem.goal_cell)
    distances = {start: 1}
    queue = deque([start])

    while queue:
        x, y = queue.popleft()
        cell = (x, y)
        if cell == goal:
            return distances[cell]
        for direction in problem.openings[f"{x},{y}"]:
            dx, dy = DIRS[direction]
            neighbor = (x + dx, y + dy)
            if (
                0 <= neighbor[0] < problem.width
                and 0 <= neighbor[1] < problem.height
                and neighbor not in distances
            ):
                distances[neighbor] = distances[cell] + 1
                queue.append(neighbor)

    raise ValueError(f"내부 셀 경로 없음: {start} -> {goal}")


def _select_candidates(
    candidate_factory: Callable[[int], Tuple[object, int]],
    count: int,
    minimum_cells: int,
    seed_limit: Optional[int] = None,
) -> List[Dict]:
    """기준 통과 후보 우선 선택 및 승인된 최대 커버리지 대체 후보 처리."""
    selected = []
    best_fallback = None
    seed = 0

    while seed_limit is None or seed < seed_limit:
        problem, coverage_cells = candidate_factory(seed)
        candidate = {
            "problem": problem,
            "coverage_cells": coverage_cells,
            "seed": seed,
            "attempts": seed + 1,
        }
        if coverage_cells >= minimum_cells:
            candidate["fallback_exception"] = False
            selected.append(candidate)
            if len(selected) == count:
                return selected
        elif seed_limit is not None and (
            best_fallback is None
            or coverage_cells > best_fallback["coverage_cells"]
        ):
            best_fallback = candidate
        seed += 1

    if seed_limit is not None and count == 2 and len(selected) == 1:
        if best_fallback is not None:
            best_fallback["fallback_exception"] = True
            selected.append(best_fallback)

    if len(selected) != count:
        raise RuntimeError(
            f"필요 후보 {count}개 중 {len(selected)}개만 확보 "
            f"(시드 탐색 한도: {seed_limit})"
        )
    return selected


def _generate_category(
    size: int,
    relation: str,
    start_side: str,
    goal_side: str,
    count: int,
    first_id_number: int,
    output_root: Path,
) -> List[Dict]:
    """고정된 입구 방향 범주의 미로 생성·선택·검증·저장."""
    minimum_cells = minimum_coverage_cells(size)

    def candidate_factory(seed: int) -> Tuple[MazeProblem, int]:
        problem = MazeGenerator(
            width=size,
            height=size,
            wall_density=WALL_DENSITY,
            image_size=IMAGE_SIZE,
            seed=seed,
        ).generate(start_side=start_side, goal_side=goal_side)
        return problem, shortest_cell_coverage(problem)

    seed_limit = (
        LARGE_OPPOSITE_SEED_LIMIT
        if size == 24 and relation == "opposite"
        else None
    )
    selected = _select_candidates(
        candidate_factory,
        count=count,
        minimum_cells=minimum_cells,
        seed_limit=seed_limit,
    )

    size_name = f"{size}x{size}"
    output_directory = output_root / size_name
    entries = []
    for index, candidate in enumerate(selected):
        problem = candidate["problem"]
        problem.problem_id = (
            f"maze_t2_{size_name}_{relation}_{first_id_number + index:02d}"
        )
        saved = save_problem(problem, output_directory)
        actual_ratio = candidate["coverage_cells"] / (size * size)
        entries.append(
            {
                **saved,
                "relation": relation,
                "start_side": start_side,
                "goal_side": goal_side,
                "attempts": candidate["attempts"],
                "coverage_cells": candidate["coverage_cells"],
                "minimum_coverage_cells": minimum_cells,
                "actual_coverage_ratio": actual_ratio,
                "minimum_coverage_ratio": minimum_coverage_ratio(size),
                "fallback_exception": candidate["fallback_exception"],
            }
        )
    return entries


def generate_tier2(output_root: Optional[str | Path] = None) -> Dict:
    """승인된 Tier2 미로 전체 생성."""
    if output_root is None:
        output_root = Path(__file__).resolve().parents[1] / "maze_sets_tier2"
    output_root = Path(output_root)
    output_root.mkdir(parents=True, exist_ok=True)

    summary = {
        "wall_density": WALL_DENSITY,
        "image_size": IMAGE_SIZE,
        "coverage_definition": (
            "시작점과 도착점을 포함한 최단 내부 셀 그래프 경로의 칸 수"
        ),
        "minimum_coverage_ratio_formula": (
            "0.25 - 0.05 * ln(n / 18) / ln(4 / 3)"
        ),
        "sets": [],
    }

    for size in SIZES:
        size_name = f"{size}x{size}"
        problems = []
        for relation, start_side, goal_side, count, first_id_number in RELATIONS:
            problems.extend(
                _generate_category(
                    size,
                    relation,
                    start_side,
                    goal_side,
                    count,
                    first_id_number,
                    output_root,
                )
            )

        manifest_path = output_root / size_name / f"maze_t2_{size_name}_manifest.json"
        manifest_path.write_text(
            json.dumps(problems, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        summary["sets"].append(
            {
                "size": size_name,
                "minimum_coverage_cells": minimum_coverage_cells(size),
                "manifest": manifest_path.relative_to(output_root).as_posix(),
                "problems": problems,
            }
        )

    summary_path = output_root / "generation_summary.json"
    summary_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return summary


if __name__ == "__main__":
    generated = generate_tier2()
    print(json.dumps(generated, ensure_ascii=False, indent=2))
