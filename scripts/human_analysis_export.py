"""분석 시작 기록의 고정 스냅샷 수집 및 보관 형식 검증."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen


_DATASETS = {"production", "verification"}
_RELATIONS = {"same", "opposite", "adjacent"}
_PARTICIPANT_ID_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
_ARCHIVE_FIELDS = {
    "schema_version",
    "dataset",
    "start_through",
    "terminal_through",
    "cutoff",
    "current_catalog_id",
    "catalogs",
    "starts",
}
_CATALOG_FIELDS = {"catalog_id", "registered_at", "mazes"}
_MAZE_FIELDS = {"maze_id", "tier", "width", "height", "relation"}
_START_FIELDS = {
    "sequence",
    "attempt_id",
    "participant_id",
    "maze_id",
    "tier",
    "catalog_id",
    "started_at",
}
_SNAPSHOT_FIELDS = ("start_through", "terminal_through", "cutoff")
_PageFetcher = Callable[
    [str, str, int, dict[str, Any] | None], dict[str, Any]
]


def _checked_integer(value: Any, field: str, minimum: int = 0) -> int:
    """정수 필드와 허용 최솟값 검증"""
    if type(value) is not int or value < minimum:
        raise ValueError(f"분석 내보내기의 {field} 값이 올바르지 않습니다.")
    return value


def _checked_utc_timestamp(value: Any, field: str) -> str:
    """UTC 시간 문자열 검증"""
    if not isinstance(value, str):
        raise ValueError(f"분석 내보내기의 {field} 값이 문자열이 아닙니다.")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"분석 내보내기의 {field} 값이 ISO 형식이 아닙니다.") from error
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        raise ValueError(f"분석 내보내기의 {field} 값이 UTC가 아닙니다.")
    return value


def _catalog_id(maze_ids: list[str]) -> str:
    """미로 ID 목록에서 카탈로그 ID 계산"""
    digest = hashlib.sha256("\n".join(sorted(maze_ids)).encode("utf-8")).hexdigest()
    return f"catalog-{digest}"


def _normalize_catalogs(value: Any, cutoff: str) -> list[dict[str, Any]]:
    """카탈로그와 포함된 미로의 고정 스냅샷 검증"""
    if not isinstance(value, list):
        raise ValueError("분석 내보내기의 catalogs 값이 목록이 아닙니다.")
    catalogs_by_id: dict[str, dict[str, Any]] = {}
    for catalog in value:
        if not isinstance(catalog, dict) or set(catalog) != _CATALOG_FIELDS:
            raise ValueError("분석 내보내기의 카탈로그 형식이 올바르지 않습니다.")
        catalog_id = catalog.get("catalog_id")
        if not isinstance(catalog_id, str) or not catalog_id:
            raise ValueError("분석 내보내기의 catalog_id 값이 올바르지 않습니다.")
        registered_at = _checked_utc_timestamp(
            catalog.get("registered_at"), "catalog.registered_at"
        )
        if registered_at > cutoff:
            raise ValueError("분석 내보내기 스냅샷보다 나중에 등록된 카탈로그가 있습니다.")
        mazes = catalog.get("mazes")
        if not isinstance(mazes, list):
            raise ValueError("분석 내보내기의 catalog.mazes 값이 목록이 아닙니다.")
        mazes_by_id: dict[str, dict[str, Any]] = {}
        for maze in mazes:
            if not isinstance(maze, dict) or set(maze) != _MAZE_FIELDS:
                raise ValueError("분석 내보내기의 미로 형식이 올바르지 않습니다.")
            maze_id = maze.get("maze_id")
            tier = maze.get("tier")
            relation = maze.get("relation")
            if not isinstance(maze_id, str) or not maze_id:
                raise ValueError("분석 내보내기의 maze_id 값이 올바르지 않습니다.")
            if not isinstance(tier, str) or tier not in {"1", "2"}:
                raise ValueError("분석 내보내기의 maze.tier 값이 올바르지 않습니다.")
            if not isinstance(relation, str) or relation not in _RELATIONS:
                raise ValueError("분석 내보내기의 maze.relation 값이 올바르지 않습니다.")
            normalized_maze = {
                "maze_id": maze_id,
                "tier": tier,
                "width": _checked_integer(maze.get("width"), "maze.width", 1),
                "height": _checked_integer(maze.get("height"), "maze.height", 1),
                "relation": relation,
            }
            if maze_id in mazes_by_id:
                raise ValueError(f"카탈로그의 maze_id가 중복되었습니다: {maze_id}")
            mazes_by_id[maze_id] = normalized_maze
        normalized = {
            "catalog_id": catalog_id,
            "registered_at": registered_at,
            "mazes": [mazes_by_id[maze_id] for maze_id in sorted(mazes_by_id)],
        }
        if catalog_id != _catalog_id(list(mazes_by_id)):
            raise ValueError(f"카탈로그 ID와 미로 목록이 일치하지 않습니다: {catalog_id}")
        if catalog_id in catalogs_by_id:
            raise ValueError(f"카탈로그 ID가 중복되었습니다: {catalog_id}")
        catalogs_by_id[catalog_id] = normalized
    return [catalogs_by_id[catalog_id] for catalog_id in sorted(catalogs_by_id)]


def _normalize_header(page: Any) -> dict[str, Any]:
    """응답의 분석 데이터셋 및 커서 스냅샷 검증"""
    if (
        not isinstance(page, dict)
        or type(page.get("schema_version")) is not int
        or page["schema_version"] != 1
    ):
        raise ValueError("분석 내보내기의 스키마 버전이 올바르지 않습니다.")
    dataset = page.get("dataset")
    if not isinstance(dataset, str) or dataset not in _DATASETS:
        raise ValueError("분석 내보내기의 dataset 값이 올바르지 않습니다.")
    start_through = _checked_integer(page.get("start_through"), "start_through")
    terminal_through = _checked_integer(
        page.get("terminal_through"), "terminal_through"
    )
    cutoff = _checked_utc_timestamp(page.get("cutoff"), "cutoff")
    catalogs = _normalize_catalogs(page.get("catalogs"), cutoff)
    current_catalog_id = page.get("current_catalog_id")
    catalog_ids = {catalog["catalog_id"] for catalog in catalogs}
    if current_catalog_id is None:
        if catalogs:
            raise ValueError("분석 내보내기의 current_catalog_id가 비어 있습니다.")
    elif not isinstance(current_catalog_id, str) or current_catalog_id not in catalog_ids:
        raise ValueError("분석 내보내기의 current_catalog_id 값이 올바르지 않습니다.")
    return {
        "schema_version": 1,
        "dataset": dataset,
        "start_through": start_through,
        "terminal_through": terminal_through,
        "cutoff": cutoff,
        "current_catalog_id": current_catalog_id,
        "catalogs": catalogs,
    }


def _normalize_start(
    value: Any,
    after: int,
    start_through: int,
    cutoff: str,
    catalogs: list[dict[str, Any]],
) -> dict[str, Any]:
    """내보내기 시작 기록에서 보관 필드만 추출"""
    if not isinstance(value, dict):
        raise ValueError("분석 내보내기 시작 기록이 객체가 아닙니다.")
    sequence = _checked_integer(value.get("sequence"), "start.sequence", 1)
    if not after < sequence <= start_through:
        raise ValueError("분석 내보내기 시작 기록의 sequence가 페이지 범위를 벗어났습니다.")
    attempt_id = value.get("attempt_id")
    participant_id = value.get("participant_id")
    maze_id = value.get("maze_id")
    tier = value.get("tier")
    catalog_id = value.get("catalog_id")
    started_at = _checked_utc_timestamp(value.get("started_at"), "start.started_at")
    if not isinstance(attempt_id, str) or not attempt_id:
        raise ValueError("분석 내보내기의 attempt_id 값이 올바르지 않습니다.")
    if (
        not isinstance(participant_id, str)
        or _PARTICIPANT_ID_PATTERN.fullmatch(participant_id) is None
    ):
        raise ValueError("분석 내보내기의 participant_id 값이 올바르지 않습니다.")
    if not isinstance(maze_id, str) or not maze_id:
        raise ValueError("분석 내보내기의 maze_id 값이 올바르지 않습니다.")
    if not isinstance(tier, str) or tier not in {"1", "2"}:
        raise ValueError("분석 내보내기의 start.tier 값이 올바르지 않습니다.")
    if not isinstance(catalog_id, str) or not catalog_id:
        raise ValueError("분석 내보내기의 start.catalog_id 값이 올바르지 않습니다.")
    if started_at > cutoff:
        raise ValueError("분석 내보내기의 시작 시각이 cutoff보다 나중입니다.")
    catalog = next(
        (item for item in catalogs if item["catalog_id"] == catalog_id), None
    )
    if catalog is None:
        raise ValueError(f"시작 기록에 연결된 카탈로그가 없습니다: {catalog_id}")
    maze = next((item for item in catalog["mazes"] if item["maze_id"] == maze_id), None)
    if maze is None or maze["tier"] != tier:
        raise ValueError(f"시작 기록의 미로 연결 정보가 올바르지 않습니다: {attempt_id}")
    return {
        "sequence": sequence,
        "attempt_id": attempt_id,
        "participant_id": participant_id,
        "maze_id": maze_id,
        "tier": tier,
        "catalog_id": catalog_id,
        "started_at": started_at,
    }


def _merge_starts(
    existing: list[dict[str, Any]], fetched: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """기존 보관 기록과 새 기록 병합 및 중복 검증"""
    starts_by_id: dict[str, dict[str, Any]] = {}
    sequences: dict[int, str] = {}
    for start in (*existing, *fetched):
        attempt_id = start["attempt_id"]
        previous = starts_by_id.get(attempt_id)
        if previous is not None:
            if previous != start:
                raise ValueError(f"중복 attempt_id 내용이 다릅니다: {attempt_id}")
            continue
        previous_id = sequences.get(start["sequence"])
        if previous_id is not None and previous_id != attempt_id:
            raise ValueError(f"시작 sequence가 중복되었습니다: {start['sequence']}")
        starts_by_id[attempt_id] = start
        sequences[start["sequence"]] = attempt_id
    return sorted(starts_by_id.values(), key=lambda start: start["sequence"])


def _normalize_archive(value: Any) -> dict[str, Any]:
    """저장된 분석 시작 아카이브 검증 및 정규화"""
    if not isinstance(value, dict) or set(value) != _ARCHIVE_FIELDS:
        raise ValueError("저장된 분석 시작 기록의 필드 형식이 올바르지 않습니다.")
    header = _normalize_header(value)
    starts_value = value.get("starts")
    if not isinstance(starts_value, list):
        raise ValueError("저장된 분석 시작 기록이 목록이 아닙니다.")
    starts = [
        _normalize_start(
            start,
            0,
            header["start_through"],
            header["cutoff"],
            header["catalogs"],
        )
        for start in starts_value
    ]
    for original, normalized in zip(starts_value, starts, strict=True):
        if set(original) != _START_FIELDS:
            raise ValueError("저장된 분석 시작 기록의 필드 형식이 올바르지 않습니다.")
        if original != normalized:
            raise ValueError("저장된 분석 시작 기록에 허용되지 않은 값이 있습니다.")
    return {**header, "starts": _merge_starts([], starts)}


def load_analysis_archive(path: str | Path) -> dict[str, Any] | None:
    """분석 시작 아카이브 로드 및 검증"""
    archive_path = Path(path)
    if not archive_path.exists():
        return None
    return _normalize_archive(json.loads(archive_path.read_text(encoding="utf-8")))


def _normalize_site_url(site_url: str) -> str:
    """사이트 주소를 검증하고 끝의 슬래시 제거"""
    normalized = site_url.rstrip("/")
    parsed = urlsplit(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("site_url에는 http 또는 https 주소를 지정해야 합니다.")
    return normalized


def _fetch_analysis_page(
    site_url: str,
    token: str,
    after: int,
    snapshot: dict[str, Any] | None,
) -> dict[str, Any]:
    """인증 토큰으로 분석 내보내기 페이지 조회"""
    query: dict[str, Any] = {"after": after}
    if snapshot is not None:
        query.update({field: snapshot[field] for field in _SNAPSHOT_FIELDS})
    parsed = urlsplit(f"{site_url}/api/analysis-export")
    endpoint = urlunsplit(parsed._replace(query=urlencode(query)))
    request = Request(
        endpoint,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "MazeBench-HumanAnalysis/1.0",
        },
    )
    with urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def collect_analysis_snapshot(
    site_url: str,
    token: str,
    previous: dict[str, Any] | None,
    allow_verification: bool = False,
    page_fetcher: _PageFetcher = _fetch_analysis_page,
) -> dict[str, Any]:
    """분석 내보내기를 고정 스냅샷으로 수집해 기존 아카이브와 병합"""
    site_url = _normalize_site_url(site_url)
    previous_archive = _normalize_archive(previous) if previous is not None else None
    initial_after = previous_archive["start_through"] if previous_archive else 0
    after = initial_after
    snapshot: dict[str, Any] | None = None
    expected_header: dict[str, Any] | None = None
    fetched_starts: list[dict[str, Any]] = []
    while True:
        page = page_fetcher(site_url, token, after, snapshot)
        header = _normalize_header(page)
        if expected_header is None:
            expected_header = header
            snapshot = {field: header[field] for field in _SNAPSHOT_FIELDS}
            if header["dataset"] == "verification" and not allow_verification:
                raise ValueError("verification 데이터셋은 기본 설정에서 거부됩니다.")
            if previous_archive is not None:
                if header["dataset"] != previous_archive["dataset"]:
                    raise ValueError("기존 분석 시작 기록과 dataset이 다릅니다.")
                if header["start_through"] < previous_archive["start_through"]:
                    raise ValueError("분석 내보내기 스냅샷이 저장된 시작 커서보다 오래되었습니다.")
                if header["terminal_through"] < previous_archive["terminal_through"]:
                    raise ValueError("분석 내보내기 스냅샷이 저장된 종료 커서보다 오래되었습니다.")
                current_catalogs = {
                    catalog["catalog_id"]: catalog for catalog in header["catalogs"]
                }
                for catalog in previous_archive["catalogs"]:
                    if current_catalogs.get(catalog["catalog_id"]) != catalog:
                        raise ValueError("분석 내보내기에서 저장된 카탈로그가 누락되거나 변경되었습니다.")
        elif header != expected_header:
            raise ValueError("페이지마다 분석 내보내기 스냅샷이 달라졌습니다.")

        if type(page.get("has_more")) is not bool:
            raise ValueError("분석 내보내기의 has_more 값이 올바르지 않습니다.")
        next_cursor = _checked_integer(page.get("next_cursor"), "next_cursor")
        if not after <= next_cursor <= expected_header["start_through"]:
            raise ValueError("분석 내보내기의 next_cursor가 페이지 범위를 벗어났습니다.")
        starts_value = page.get("starts")
        if not isinstance(starts_value, list):
            raise ValueError("분석 내보내기의 starts 값이 목록이 아닙니다.")
        normalized_starts = [
            _normalize_start(
                start,
                after,
                expected_header["start_through"],
                expected_header["cutoff"],
                expected_header["catalogs"],
            )
            for start in starts_value
        ]
        sequences = [start["sequence"] for start in normalized_starts]
        if any(left >= right for left, right in zip(sequences, sequences[1:])):
            raise ValueError("분석 내보내기 페이지의 시작 기록 순서가 올바르지 않습니다.")
        expected_cursor = sequences[-1] if sequences else after
        if next_cursor != expected_cursor:
            raise ValueError("분석 내보내기의 next_cursor가 마지막 시작 기록과 다릅니다.")
        fetched_starts = _merge_starts(fetched_starts, normalized_starts)
        if not page["has_more"]:
            break
        if next_cursor <= after or next_cursor >= expected_header["start_through"]:
            raise ValueError("다음 페이지가 있다고 표시했지만 분석 커서가 진행되지 않습니다.")
        after = next_cursor

    assert expected_header is not None
    if previous_archive is not None and expected_header["cutoff"] < previous_archive["cutoff"]:
        raise ValueError("분석 내보내기 cutoff가 저장된 스냅샷보다 오래되었습니다.")
    starts = _merge_starts(
        previous_archive["starts"] if previous_archive is not None else [],
        fetched_starts,
    )
    header = expected_header.copy()
    return {**header, "starts": starts}
