"""사람 플레이 결과를 검증·채점하고 공개 집계 파일을 동기화합니다."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from statistics import fmean, median
from typing import Any, Callable
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from maze_benchmark import (
    SCORING_VERSION,
    VALID_ACTIONS,
    MazeProblem,
    MazeScorer,
    load_problem,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "public" / "human_results.json"
DEFAULT_ARCHIVE = ROOT / "human_data" / "records.json"
DEFAULT_STATE = ROOT / "human_data" / "sync-state.json"
MAZE_DIRECTORIES = {
    "1": ROOT / "maze_sets",
    "2": ROOT / "maze_sets_tier2",
}
TERMINAL_STATUSES = {"success", "collision", "quit"}
_PageFetcher = Callable[[str, str, int, int | None], dict[str, Any]]


def _checked_integer(value: Any, field: str, minimum: int = 0) -> int:
    """정수 필드와 허용 최솟값 검증"""
    if type(value) is not int or value < minimum:
        raise ValueError(f"내보내기 응답의 {field} 값이 올바르지 않습니다.")
    return value


def _load_maze_catalog() -> dict[str, tuple[str, MazeProblem]]:
    """실제 미로 파일을 tier와 문제 객체로 로드"""
    catalog: dict[str, tuple[str, MazeProblem]] = {}
    for tier, directory in MAZE_DIRECTORIES.items():
        paths = sorted(
            path
            for path in directory.rglob("*.json")
            if not path.name.endswith(".validation.json")
            and not path.name.endswith("_manifest.json")
            and path.name != "generation_summary.json"
        )
        for path in paths:
            problem = load_problem(path)
            if problem.problem_id in catalog:
                raise ValueError(f"미로 ID가 중복되었습니다: {problem.problem_id}")
            catalog[problem.problem_id] = (tier, problem)
    if not catalog:
        raise ValueError("채점할 미로 파일을 찾지 못했습니다.")
    return catalog


def _maze_rows(catalog: dict[str, tuple[str, MazeProblem]]) -> dict[str, list[dict[str, Any]]]:
    """모든 미로의 초기 공개 집계 행 구성"""
    rows = {"1": [], "2": []}
    for maze_id, (tier, problem) in sorted(catalog.items()):
        rows[tier].append(
            {
                "maze_id": maze_id,
                "width": problem.width,
                "height": problem.height,
                "attempt_count": 0,
                "mean_score": None,
                "median_score": None,
                "p05_score": None,
                "p95_score": None,
            }
        )
    return rows


def _empty_public_results(catalog: dict[str, tuple[str, MazeProblem]]) -> dict[str, Any]:
    """참가 기록이 없는 공개 결과 스키마 구성"""
    return {
        "schema_version": 1,
        "scoring_version": SCORING_VERSION,
        "site_url": None,
        "updated_at": None,
        "tiers": {
            tier: {
                "participant_count": 0,
                "attempt_count": 0,
                "mazes": rows,
            }
            for tier, rows in _maze_rows(catalog).items()
        },
    }


def _normalize_site_url(site_url: str) -> str:
    """사이트 주소를 검증하고 끝의 슬래시 제거"""
    normalized = site_url.rstrip("/")
    parsed = urlsplit(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("--site-url에는 http 또는 https 주소를 지정해야 합니다.")
    return normalized


def _fetch_export_page(
    site_url: str,
    token: str,
    after: int,
    through: int | None,
) -> dict[str, Any]:
    """인증 토큰으로 내보내기 페이지 조회"""
    query = {"after": after}
    if through is not None:
        query["through"] = through
    parsed = urlsplit(f"{site_url}/api/export")
    endpoint = urlunsplit(parsed._replace(query=urlencode(query)))
    request = Request(
        endpoint,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "MazeBench-HumanSync/1.0",
        },
    )
    with urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def _participant_counts(value: Any) -> dict[str, int]:
    """tier별 참가자 수 형식 검증"""
    if not isinstance(value, dict) or set(value) != {"1", "2"}:
        raise ValueError("내보내기 응답의 participant_counts 형식이 올바르지 않습니다.")
    return {
        tier: _checked_integer(value[tier], f"participant_counts.{tier}")
        for tier in ("1", "2")
    }


def _validate_page_header(
    page: Any,
    expected_through: int | None,
    expected_dataset: str | None,
    expected_counts: dict[str, int] | None,
) -> tuple[int, str, dict[str, int]]:
    """내보내기 페이지의 스냅샷 메타데이터 검증"""
    if (
        not isinstance(page, dict)
        or type(page.get("schema_version")) is not int
        or page["schema_version"] != 1
    ):
        raise ValueError("사람 플레이 내보내기의 스키마 버전이 올바르지 않습니다.")
    dataset = page.get("dataset")
    if not isinstance(dataset, str) or dataset not in {"production", "verification"}:
        raise ValueError("내보내기 응답의 dataset 값이 올바르지 않습니다.")
    through = _checked_integer(page.get("through"), "through")
    counts = _participant_counts(page.get("participant_counts"))
    if expected_through is not None and through != expected_through:
        raise ValueError("페이지마다 내보내기 스냅샷이 달라졌습니다.")
    if expected_dataset is not None and dataset != expected_dataset:
        raise ValueError("페이지마다 내보내기 dataset이 달라졌습니다.")
    if expected_counts is not None and counts != expected_counts:
        raise ValueError("페이지마다 참가자 수 스냅샷이 달라졌습니다.")
    if type(page.get("has_more")) is not bool:
        raise ValueError("내보내기 응답의 has_more 값이 올바르지 않습니다.")
    _checked_integer(page.get("next_cursor"), "next_cursor")
    if not isinstance(page.get("records"), list):
        raise ValueError("내보내기 응답의 records 값이 목록이 아닙니다.")
    return through, dataset, counts


def _normalize_record(record: Any, after: int, through: int) -> dict[str, Any]:
    """내보내기 원본에서 기록에 필요한 필드만 추출"""
    if not isinstance(record, dict):
        raise ValueError("내보내기 기록이 객체가 아닙니다.")
    sequence = _checked_integer(record.get("sequence"), "record.sequence", 1)
    if not after < sequence <= through:
        raise ValueError("내보내기 기록의 sequence가 페이지 범위를 벗어났습니다.")
    attempt_id = record.get("attempt_id")
    maze_id = record.get("maze_id")
    tier = record.get("tier")
    actions = record.get("actions")
    status = record.get("status")
    started_at = record.get("started_at")
    finished_at = record.get("finished_at")
    if not isinstance(attempt_id, str) or not attempt_id:
        raise ValueError("내보내기 기록의 attempt_id가 비어 있습니다.")
    if not isinstance(maze_id, str) or not maze_id:
        raise ValueError("내보내기 기록의 maze_id가 비어 있습니다.")
    if not isinstance(tier, str) or tier not in {"1", "2"}:
        raise ValueError("내보내기 기록의 tier 값이 올바르지 않습니다.")
    if not isinstance(actions, list) or any(
        not isinstance(action, str) or action not in VALID_ACTIONS
        for action in actions
    ):
        raise ValueError("내보내기 기록의 actions 값이 올바르지 않습니다.")
    if not isinstance(status, str) or status not in TERMINAL_STATUSES:
        raise ValueError("내보내기 기록의 status 값이 올바르지 않습니다.")
    if not isinstance(started_at, str) or not isinstance(finished_at, str):
        raise ValueError("내보내기 기록의 시각 값이 문자열이 아닙니다.")
    try:
        started = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        finished = datetime.fromisoformat(finished_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("내보내기 기록의 시각이 ISO 형식이 아닙니다.") from error
    if started.tzinfo is None or finished.tzinfo is None or finished < started:
        raise ValueError("내보내기 기록의 시각 순서가 올바르지 않습니다.")
    return {
        "sequence": sequence,
        "attempt_id": attempt_id,
        "maze_id": maze_id,
        "tier": tier,
        "actions": actions.copy(),
        "status": status,
        "started_at": started_at,
        "finished_at": finished_at,
    }


def _fetch_snapshot(
    site_url: str,
    token: str,
    cursor: int,
    allow_verification: bool,
    page_fetcher: _PageFetcher = _fetch_export_page,
) -> tuple[str, int, dict[str, int], list[dict[str, Any]]]:
    """고정 스냅샷의 모든 페이지 수집 및 중복 제거"""
    records_by_id: dict[str, dict[str, Any]] = {}
    sequences: dict[int, str] = {}
    after = cursor
    through: int | None = None
    dataset: str | None = None
    counts: dict[str, int] | None = None
    while True:
        page = page_fetcher(site_url, token, after, through)
        page_through, page_dataset, page_counts = _validate_page_header(
            page, through, dataset, counts
        )
        if through is None:
            through = page_through
            dataset = page_dataset
            counts = page_counts
            if through < cursor:
                raise ValueError("내보내기 스냅샷이 저장된 커서보다 오래되었습니다.")
            if dataset == "verification" and not allow_verification:
                raise ValueError("verification 데이터셋은 기본 설정에서 거부됩니다.")
        next_cursor = page["next_cursor"]
        if not after <= next_cursor <= through:
            raise ValueError("내보내기 응답의 next_cursor가 페이지 범위를 벗어났습니다.")
        normalized_records = [
            _normalize_record(record, after, through) for record in page["records"]
        ]
        for record in normalized_records:
            attempt_id = record["attempt_id"]
            previous = records_by_id.get(attempt_id)
            if previous is not None:
                if previous != record:
                    raise ValueError(f"중복 attempt_id 내용이 다릅니다: {attempt_id}")
                continue
            previous_id = sequences.get(record["sequence"])
            if previous_id is not None and previous_id != attempt_id:
                raise ValueError(f"sequence가 중복되었습니다: {record['sequence']}")
            records_by_id[attempt_id] = record
            sequences[record["sequence"]] = attempt_id
        if not page["has_more"]:
            break
        if next_cursor <= after or next_cursor >= through:
            raise ValueError("다음 페이지가 있다고 표시했지만 커서가 진행되지 않습니다.")
        after = next_cursor
    return dataset, through, counts, sorted(
        records_by_id.values(), key=lambda record: record["sequence"]
    )


def _load_json(path: Path) -> Any:
    """UTF-8 JSON 파일 로드"""
    return json.loads(path.read_text(encoding="utf-8"))


def _load_state(path: Path) -> dict[str, Any]:
    """저장된 동기화 커서 상태 로드"""
    if not path.exists():
        return {
            "schema_version": 1,
            "cursor": 0,
            "dataset": None,
            "participant_counts": {"1": 0, "2": 0},
        }
    state = _load_json(path)
    if (
        not isinstance(state, dict)
        or type(state.get("schema_version")) is not int
        or state["schema_version"] != 1
    ):
        raise ValueError("저장된 동기화 커서 파일의 스키마가 올바르지 않습니다.")
    cursor = _checked_integer(state.get("cursor"), "state.cursor")
    dataset = state.get("dataset")
    if dataset is not None and (
        not isinstance(dataset, str) or dataset not in {"production", "verification"}
    ):
        raise ValueError("저장된 동기화 커서의 dataset이 올바르지 않습니다.")
    return {
        "schema_version": 1,
        "cursor": cursor,
        "dataset": dataset,
        "participant_counts": _participant_counts(state.get("participant_counts")),
    }


def _load_archive(path: Path) -> tuple[str | None, list[dict[str, Any]]]:
    """기존 원본 기록 보관 파일 로드"""
    if not path.exists():
        return None, []
    archive = _load_json(path)
    if (
        not isinstance(archive, dict)
        or type(archive.get("schema_version")) is not int
        or archive["schema_version"] != 1
    ):
        raise ValueError("저장된 사람 플레이 기록의 스키마가 올바르지 않습니다.")
    dataset = archive.get("dataset")
    if dataset is not None and (
        not isinstance(dataset, str) or dataset not in {"production", "verification"}
    ):
        raise ValueError("저장된 기록의 dataset 값이 올바르지 않습니다.")
    records = archive.get("records")
    if not isinstance(records, list):
        raise ValueError("저장된 사람 플레이 기록이 목록이 아닙니다.")
    normalized = []
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("저장된 사람 플레이 기록이 객체가 아닙니다.")
        raw = _normalize_archive_raw(record)
        normalized.append(raw)
    return dataset, normalized


def _normalize_archive_raw(record: dict[str, Any]) -> dict[str, Any]:
    """보관 기록에서 원본 필드만 추출"""
    sequence = _checked_integer(record.get("sequence"), "archive.sequence", 1)
    return _normalize_record(
        {
            "sequence": sequence,
            "attempt_id": record.get("attempt_id"),
            "maze_id": record.get("maze_id"),
            "tier": record.get("tier"),
            "actions": record.get("actions"),
            "status": record.get("status"),
            "started_at": record.get("started_at"),
            "finished_at": record.get("finished_at"),
        },
        sequence - 1,
        sequence,
    )


def _merge_records(
    existing: list[dict[str, Any]], fetched: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """기존 기록과 새 기록 병합 및 중복 제거"""
    records_by_id: dict[str, dict[str, Any]] = {}
    sequences: dict[int, str] = {}
    for record in (*existing, *fetched):
        attempt_id = record["attempt_id"]
        previous = records_by_id.get(attempt_id)
        if previous is not None:
            if previous != record:
                raise ValueError(f"저장 기록과 내보내기의 attempt_id가 충돌합니다: {attempt_id}")
            continue
        previous_id = sequences.get(record["sequence"])
        if previous_id is not None and previous_id != attempt_id:
            raise ValueError(f"저장 기록의 sequence가 중복되었습니다: {record['sequence']}")
        records_by_id[attempt_id] = record
        sequences[record["sequence"]] = attempt_id
    return sorted(records_by_id.values(), key=lambda record: record["sequence"])


def _score_records(
    records: list[dict[str, Any]],
    catalog: dict[str, tuple[str, MazeProblem]],
) -> list[dict[str, Any]]:
    """기존 채점기를 적용하고 종료 상태 검증"""
    scorers: dict[str, MazeScorer] = {}
    scored_records = []
    for record in records:
        maze_id = record["maze_id"]
        maze = catalog.get(maze_id)
        if maze is None:
            raise ValueError(f"내보내기 기록에 알 수 없는 미로가 있습니다: {maze_id}")
        tier, problem = maze
        if tier != record["tier"]:
            raise ValueError(f"미로와 기록의 tier가 다릅니다: {maze_id}")
        if maze_id not in scorers:
            scorers[maze_id] = MazeScorer(problem)
        scorer = scorers[maze_id]
        result = scorer.score_actions(record["actions"])
        status = record["status"]
        if status == "success":
            matches = (
                result.success
                and not result.death
                and len(result.actions_executed) == len(record["actions"])
            )
        elif status == "collision":
            matches = (
                result.death
                and not result.success
                and result.first_invalid_action_index == len(record["actions"]) - 1
            )
        else:
            matches = (
                not result.success
                and not result.death
                and len(result.actions_executed) == len(record["actions"])
            )
        if not matches:
            raise ValueError(
                f"기록된 terminal status와 미로 채점 결과가 다릅니다: {record['attempt_id']}"
            )
        scored_records.append({**record, "scoring_result": result.to_jsonable()})
    return scored_records


def _build_public_results(
    site_url: str,
    dataset: str,
    participant_counts: dict[str, int],
    records: list[dict[str, Any]],
    catalog: dict[str, tuple[str, MazeProblem]],
    previous_public: dict[str, Any] | None,
) -> dict[str, Any]:
    """tier별 참가·시도 수와 미로 점수 통계 산출"""
    if dataset not in {"production", "verification"}:
        raise ValueError("공개 집계에 사용할 dataset이 없습니다.")
    rows_by_tier = _maze_rows(catalog)
    scores: dict[str, list[float]] = defaultdict(list)
    attempt_counts = {"1": 0, "2": 0}
    for record in records:
        tier = record["tier"]
        attempt_counts[tier] += 1
        scores[record["maze_id"]].append(record["scoring_result"]["score"])
    for tier, rows in rows_by_tier.items():
        for row in rows:
            maze_scores = scores[row["maze_id"]]
            row["attempt_count"] = len(maze_scores)
            row["mean_score"] = fmean(maze_scores) if maze_scores else None
            row["median_score"] = median(maze_scores) if maze_scores else None
            if maze_scores:
                sorted_scores = sorted(maze_scores)
                # 정렬 점수의 (n - 1) * q 위치 선형 보간
                p05_position = (len(sorted_scores) - 1) * 0.05
                p05_lower_index = int(p05_position)
                p05_interpolation = p05_position - p05_lower_index
                p05_lower_score = sorted_scores[p05_lower_index]
                p05_upper_index = min(p05_lower_index + 1, len(sorted_scores) - 1)
                p05_upper_score = sorted_scores[p05_upper_index]
                row["p05_score"] = p05_lower_score + (
                    p05_upper_score - p05_lower_score
                ) * p05_interpolation
                p95_position = (len(sorted_scores) - 1) * 0.95
                lower_index = int(p95_position)
                interpolation = p95_position - lower_index
                lower_score = sorted_scores[lower_index]
                upper_index = min(lower_index + 1, len(sorted_scores) - 1)
                upper_score = sorted_scores[upper_index]
                row["p95_score"] = lower_score + (upper_score - lower_score) * interpolation
            else:
                row["p05_score"] = None
                row["p95_score"] = None
    current = {
        "schema_version": 1,
        "scoring_version": SCORING_VERSION,
        "site_url": site_url,
        "updated_at": None,
        "tiers": {
            tier: {
                "participant_count": participant_counts[tier],
                "attempt_count": attempt_counts[tier],
                "mazes": rows,
            }
            for tier, rows in rows_by_tier.items()
        },
    }
    if previous_public is not None:
        previous_without_time = {
            key: value for key, value in previous_public.items() if key != "updated_at"
        }
        current_without_time = {
            key: value for key, value in current.items() if key != "updated_at"
        }
        if previous_without_time == current_without_time:
            current["updated_at"] = previous_public.get("updated_at")
            return current
    current["updated_at"] = (
        datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )
    return current


def _json_text(value: Any) -> str:
    """기록 비교가 안정적인 JSON 텍스트 생성"""
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def _write_if_changed(files: dict[Path, str]) -> None:
    """내용이 달라진 파일만 임시 파일을 거쳐 교체"""
    temporary_paths: dict[Path, Path] = {}
    try:
        for path, content in files.items():
            if path.exists() and path.read_text(encoding="utf-8") == content:
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                newline="\n",
                dir=path.parent,
                prefix=f".{path.name}.",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary.write(content)
                temporary_paths[path] = Path(temporary.name)
        for path, temporary_path in temporary_paths.items():
            os.replace(temporary_path, path)
    finally:
        for temporary_path in temporary_paths.values():
            if temporary_path.exists():
                temporary_path.unlink()


def sync_results(
    site_url: str,
    token: str,
    output_path: Path,
    archive_path: Path,
    state_path: Path,
    allow_verification: bool = False,
    page_fetcher: _PageFetcher = _fetch_export_page,
) -> dict[str, Any]:
    """전체 수집·검증 후 집계, 보관 기록, 커서 갱신"""
    paths = [path.resolve() for path in (output_path, archive_path, state_path)]
    if len(set(paths)) != len(paths):
        raise ValueError("출력, 기록 보관, 커서 파일 경로는 서로 달라야 합니다.")
    site_url = _normalize_site_url(site_url)
    state = _load_state(state_path)
    archive_dataset, existing_records = _load_archive(archive_path)
    if state["cursor"] and not archive_path.exists():
        raise ValueError("커서가 진행되었지만 보관 기록 파일이 없습니다.")
    if state["cursor"] and state["dataset"] is None:
        raise ValueError("저장된 커서에 dataset 값이 없습니다.")
    if existing_records and archive_dataset is None:
        raise ValueError("저장된 기록에 dataset 값이 없습니다.")
    if state["dataset"] is not None and archive_dataset not in {None, state["dataset"]}:
        raise ValueError("커서와 기록 보관 파일의 dataset이 다릅니다.")
    if not token:
        raise ValueError("내보내기 인증 토큰이 비어 있습니다.")
    dataset, through, participant_counts, fetched_records = _fetch_snapshot(
        site_url,
        token,
        state["cursor"],
        allow_verification,
        page_fetcher,
    )
    if state["dataset"] not in {None, dataset} or archive_dataset not in {None, dataset}:
        raise ValueError("현재 dataset을 기존 기록 파일과 함께 사용할 수 없습니다.")
    if existing_records and max(record["sequence"] for record in existing_records) > through:
        raise ValueError("현재 내보내기 스냅샷이 보관 기록보다 오래되었습니다.")
    if dataset == "verification" and any(
        path.resolve() == official.resolve()
        for path, official in (
            (output_path, DEFAULT_OUTPUT),
            (archive_path, DEFAULT_ARCHIVE),
            (state_path, DEFAULT_STATE),
        )
    ):
        raise ValueError("verification 데이터셋에는 기본 정본과 분리된 파일 경로가 필요합니다.")
    merged_records = _merge_records(existing_records, fetched_records)
    catalog = _load_maze_catalog()
    scored_records = _score_records(merged_records, catalog)
    previous_public = _load_json(output_path) if output_path.exists() else None
    public_results = _build_public_results(
        site_url,
        dataset,
        participant_counts,
        scored_records,
        catalog,
        previous_public,
    )
    archive = {
        "schema_version": 1,
        "scoring_version": SCORING_VERSION,
        "dataset": dataset,
        "records": scored_records,
    }
    next_state = {
        "schema_version": 1,
        "cursor": through,
        "dataset": dataset,
        "participant_counts": participant_counts,
    }
    _write_if_changed(
        {
            archive_path: _json_text(archive),
            output_path: _json_text(public_results),
            state_path: _json_text(next_state),
        }
    )
    return public_results


def _build_argument_parser() -> argparse.ArgumentParser:
    """동기화 명령줄 옵션 등록"""
    parser = argparse.ArgumentParser(description="사람 미로 플레이 결과 동기화")
    parser.add_argument("--site-url", default=os.environ.get("HUMAN_SITE_URL"))
    parser.add_argument("--export-token-env", default="HUMAN_EXPORT_TOKEN")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--state", type=Path)
    parser.add_argument("--allow-verification", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    """명령줄에서 사람 플레이 동기화 실행"""
    parser = _build_argument_parser()
    args = parser.parse_args(argv)
    if not args.site_url:
        parser.error("--site-url 또는 HUMAN_SITE_URL이 필요합니다.")
    output_path = args.output or DEFAULT_OUTPUT
    archive_path = args.archive or DEFAULT_ARCHIVE
    state_path = args.state or DEFAULT_STATE
    if args.allow_verification:
        explicit_paths = (args.output, args.archive, args.state)
        official_paths = (DEFAULT_OUTPUT, DEFAULT_ARCHIVE, DEFAULT_STATE)
        if any(path is None for path in explicit_paths) or any(
            path.resolve() == official.resolve()
            for path, official in zip(explicit_paths, official_paths)
        ):
            parser.error(
                "verification 데이터셋에는 기본 정본과 분리된 --output, --archive, --state 경로가 모두 필요합니다."
            )
    token = os.environ.get(args.export_token_env)
    if token is None:
        parser.error(f"환경 변수 {args.export_token_env}에 내보내기 토큰이 필요합니다.")
    sync_results(
        args.site_url,
        token,
        output_path,
        archive_path,
        state_path,
        allow_verification=args.allow_verification,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
