"""무작위 상대 명령 정책의 미로별 기대 점수를 계산한다."""

from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path

from maze_benchmark import (
    SCORING_VERSION,
    MazeProblem,
    MazeScorer,
    load_problem,
    rotate_direction,
)


ROOT = Path(__file__).resolve().parents[1]
POLICY = "uniform-four-after-correct-entry"
_ACTIONS = ("S", "R", "B", "L")
_LIVE_MASS_CUTOFF = 1e-13


def expected_random_score(problem: MazeProblem) -> float:
    """균등한 네 방향 명령의 정확한 기대 점수를 확률 전파로 계산한다."""
    scorer = MazeScorer(problem)
    entry = scorer.score_actions(["S"])
    if entry.death:
        raise ValueError(f"첫 직진 명령이 시작 진입에 실패했습니다: {problem.problem_id}")
    if entry.success:
        return entry.score

    optimal_actions = scorer.optimal_distance
    moves = entry.actual_action_count
    live = {(entry.final_event, entry.final_facing): 1.0}
    expected_score = 0.0

    while math.fsum(live.values()) >= _LIVE_MASS_CUTOFF:
        next_live: defaultdict[tuple[str, str], float] = defaultdict(float)
        for (event_id, facing), mass in live.items():
            available = problem.transitions[event_id]
            for action in _ACTIONS:
                absolute_direction = rotate_direction(facing, action)
                edge = available.get(absolute_direction)
                branch_mass = mass / 4
                if edge is None:
                    remaining = scorer.remaining_distance(event_id, facing)
                    denominator = moves + remaining
                    terminal_score = 100.0 * optimal_actions * moves / denominator**2
                    expected_score += branch_mass * terminal_score
                    continue

                next_event = edge["to"]
                next_moves = moves + 1
                if next_event == scorer.goal_event:
                    expected_score += branch_mass * (100.0 * optimal_actions / next_moves)
                else:
                    next_live[(next_event, absolute_direction)] += branch_mass

        live = next_live
        moves += 1

    return expected_score


def build_random_baseline(repository_root: Path = ROOT) -> dict:
    """두 티어의 manifest에 등록된 모든 미로 기대 점수를 만든다."""
    tiers: dict[str, dict[str, float]] = {"1": {}, "2": {}}
    for tier, directory_name in (("1", "maze_sets"), ("2", "maze_sets_tier2")):
        maze_root = repository_root / directory_name
        for manifest_path in sorted(maze_root.rglob("*_manifest.json")):
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            for item in manifest:
                problem = load_problem(manifest_path.parent / item["json"])
                tiers[tier][item["problem_id"]] = expected_random_score(problem)
        tiers[tier] = dict(sorted(tiers[tier].items()))

    return {
        "schema_version": 1,
        "scoring_version": SCORING_VERSION,
        "policy": POLICY,
        "tiers": tiers,
    }


def main() -> None:
    """계산 결과를 JSON 파일로 저장한다."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "public" / "random_baseline.json",
        help="기대 점수 JSON을 저장할 경로",
    )
    args = parser.parse_args()

    result = build_random_baseline()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    means = {
        tier: math.fsum(scores.values()) / len(scores)
        for tier, scores in result["tiers"].items()
    }
    print(
        f"저장 완료: {args.output} "
        f"(Tier 1 평균 {means['1']:.8f}, Tier 2 평균 {means['2']:.8f})"
    )


if __name__ == "__main__":
    main()
