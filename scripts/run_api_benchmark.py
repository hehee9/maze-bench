from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from dotenv import load_dotenv

from api_clients import (
    APIClientError,
    APIResult,
    ModelConfig,
    create_client,
    reasoning_label,
)
from maze_benchmark import (
    SCORING_VERSION,
    MazeScorer,
    load_problem,
    parse_action_response,
    validate_problem,
)


SCHEMA_VERSION = 1
PUBLIC_SCHEMA_VERSION = 2
TOKEN_USAGE_FIELDS = (
    "input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "total_tokens",
)


@dataclass(frozen=True)
class MazeCase:
    maze_id: str
    width: int
    height: int
    json_path: Path
    image_path: Path
    json_sha256: str
    image_sha256: str


@dataclass(frozen=True)
class BenchmarkTask:
    model: ModelConfig
    maze: MazeCase
    output_path: Path


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def canonical_hash(value: Any) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return sha256_bytes(encoded)


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def slug(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip())
    normalized = normalized.strip("-._").lower()
    return normalized or "default"


def load_models(path: Path) -> List[ModelConfig]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("models"), list):
        raise ValueError(f"{path} must contain a top-level models array")
    models = []
    for index, item in enumerate(data["models"]):
        if not isinstance(item, dict):
            raise ValueError(f"{path} models[{index}] must be an object")
        models.append(ModelConfig.from_dict(item))
    names = [model.name for model in models]
    if len(names) != len(set(names)):
        raise ValueError("Model names must be unique")
    return models


def select_models(
    configured_models: Sequence[ModelConfig],
    requested_names: Optional[Sequence[str]],
    all_models: bool,
) -> List[ModelConfig]:
    if all_models:
        return list(configured_models)
    if not requested_names:
        raise ValueError("Specify --all-models or --models NAME [NAME ...]")

    available = {model.name: model for model in configured_models}
    unknown = [name for name in requested_names if name not in available]
    if unknown:
        available_names = ", ".join(available) or "(none)"
        raise ValueError(
            f"Unknown model name(s): {', '.join(unknown)}. "
            f"Available models: {available_names}"
        )

    requested = set(requested_names)
    return [model for model in configured_models if model.name in requested]


def maze_size(maze: MazeCase) -> str:
    return f"{maze.width}x{maze.height}"


def select_mazes(
    discovered_mazes: Sequence[MazeCase],
    requested_sizes: Optional[Sequence[str]],
) -> List[MazeCase]:
    if not requested_sizes:
        return list(discovered_mazes)

    available_sizes = list(dict.fromkeys(maze_size(maze) for maze in discovered_mazes))
    available = set(available_sizes)
    unknown = [size for size in requested_sizes if size not in available]
    if unknown:
        raise ValueError(
            f"Unknown maze size(s): {', '.join(unknown)}. "
            f"Available maze sizes: {', '.join(available_sizes)}"
        )

    requested = set(requested_sizes)
    return [maze for maze in discovered_mazes if maze_size(maze) in requested]


def discover_mazes(maze_dir: Path) -> List[MazeCase]:
    cases: List[MazeCase] = []
    seen_ids = set()
    for json_path in sorted(maze_dir.rglob("*.json")):
        if json_path.name.endswith(".validation.json"):
            continue
        data = json.loads(json_path.read_text(encoding="utf-8"))
        required = {"problem_id", "width", "height", "events", "transitions"}
        if not isinstance(data, dict) or not required.issubset(data):
            continue

        problem = load_problem(json_path)
        validation = validate_problem(problem)
        if not validation["valid"]:
            raise ValueError(f"Invalid maze {json_path}: {validation['errors']}")

        image_path = json_path.with_suffix(".png")
        if not image_path.is_file():
            raise FileNotFoundError(f"Image missing for {json_path}: {image_path}")
        if problem.problem_id in seen_ids:
            raise ValueError(f"Duplicate maze problem_id: {problem.problem_id}")
        seen_ids.add(problem.problem_id)
        cases.append(
            MazeCase(
                maze_id=problem.problem_id,
                width=problem.width,
                height=problem.height,
                json_path=json_path.resolve(),
                image_path=image_path.resolve(),
                json_sha256=sha256_file(json_path),
                image_sha256=sha256_file(image_path),
            )
        )

    cases.sort(key=lambda case: (case.width, case.height, case.maze_id))
    if not cases:
        raise ValueError(f"No valid maze JSON/PNG pairs found under {maze_dir}")
    return cases


def result_filename(model: ModelConfig, maze: MazeCase) -> str:
    return "__".join(
        (
            slug(model.provider),
            slug(model.model_id),
            slug(reasoning_label(model)),
            slug(maze.maze_id),
        )
    ) + ".json"


def ensure_unique_paths(tasks: Sequence[BenchmarkTask]) -> None:
    paths: Dict[Path, BenchmarkTask] = {}
    for task in tasks:
        previous = paths.get(task.output_path)
        if previous:
            raise ValueError(
                "Result filename collision between "
                f"{previous.model.name}/{previous.maze.maze_id} and "
                f"{task.model.name}/{task.maze.maze_id}"
            )
        paths[task.output_path] = task


def build_fingerprint(
    models: Sequence[ModelConfig],
    mazes: Sequence[MazeCase],
    prompt_hash: str,
) -> Tuple[str, Dict[str, Any]]:
    components = {
        "prompt_sha256": prompt_hash,
        "models": [model.public_dict() for model in models],
        "mazes": [
            {
                "maze_id": maze.maze_id,
                "json_sha256": maze.json_sha256,
                "image_sha256": maze.image_sha256,
            }
            for maze in mazes
        ],
    }
    return canonical_hash(components), components


def sanitize_error(error: BaseException, api_key: str) -> str:
    text = str(error)
    if api_key:
        text = text.replace(api_key, "[REDACTED]")
    text = re.sub(
        r"data:image/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+",
        "data:image/[REDACTED];base64,[REDACTED]",
        text,
    )
    text = re.sub(
        r'("(?:data|url)"\s*:\s*")[A-Za-z0-9+/=]{64,}(")',
        r'\1[REDACTED]\2',
        text,
    )
    return text[:4000]


def grade_response(maze: MazeCase, response_text: str) -> Tuple[bool, Dict[str, Any]]:
    scorer = MazeScorer(load_problem(maze.json_path))
    return scorer.grade_log(response_text)


def response_has_token_usage(response: APIResult) -> bool:
    return any(
        type(getattr(response, field)) is int
        for field in TOKEN_USAGE_FIELDS
    )


def record_is_api_success(record: Dict[str, Any]) -> bool:
    if not bool((record.get("request") or {}).get("success")):
        return False
    if record.get("format_valid") is not False:
        return True

    response = record.get("response") or {}
    usage = response.get("usage") or {}
    return any(
        type(usage.get(field, response.get(field))) is int
        for field in TOKEN_USAGE_FIELDS
    )


def result_record(
    run_id: str,
    task: BenchmarkTask,
    prompt_path: Path,
    prompt_hash: str,
    attempts: List[Dict[str, Any]],
    response: Optional[APIResult],
    grading: Optional[Dict[str, Any]],
    format_valid: Optional[bool],
) -> Dict[str, Any]:
    request_success = response is not None and response.success
    response_data = None
    if response is not None:
        response_data = response.to_jsonable()
        response_data["usage"] = {
            "input_tokens": response.input_tokens,
            "output_tokens": response.output_tokens,
            "reasoning_tokens": response.reasoning_tokens,
            "total_tokens": response.total_tokens,
        }
    return {
        "schema_version": SCHEMA_VERSION,
        "scoring_version": SCORING_VERSION,
        "run_id": run_id,
        "created_at": utc_now(),
        "model": {
            **task.model.public_dict(),
            "reasoning_label": reasoning_label(task.model),
        },
        "maze": {
            "maze_id": task.maze.maze_id,
            "width": task.maze.width,
            "height": task.maze.height,
            "json_path": str(task.maze.json_path),
            "image_path": str(task.maze.image_path),
            "json_sha256": task.maze.json_sha256,
            "image_sha256": task.maze.image_sha256,
        },
        "prompt": {
            "path": str(prompt_path.resolve()),
            "sha256": prompt_hash,
        },
        "request": {
            "success": request_success,
            "attempt_count": len(attempts),
            "latency_seconds": round(
                sum(float(attempt["latency_seconds"]) for attempt in attempts), 6
            ),
            "attempts": attempts,
        },
        "response": response_data,
        "format_valid": format_valid,
        "score": grading["score"] if grading is not None else None,
        "grading": grading,
    }


def run_task(
    task: BenchmarkTask,
    client: Any,
    api_key: str,
    prompt_text: str,
    prompt_path: Path,
    prompt_hash: str,
    run_id: str,
    max_attempts: int,
    sleep: Any = time.sleep,
) -> Dict[str, Any]:
    attempts: List[Dict[str, Any]] = []
    response: Optional[APIResult] = None

    for attempt_number in range(1, max_attempts + 1):
        started_at = utc_now()
        started = time.monotonic()
        try:
            candidate = client.send(prompt_text, task.maze.image_path)
            format_valid, _ = parse_action_response(candidate.raw_response)
            if not format_valid and not response_has_token_usage(candidate):
                raise APIClientError(
                    "API returned an invalid command response without token usage"
                )
            response = candidate
            attempts.append(
                {
                    "attempt": attempt_number,
                    "started_at": started_at,
                    "latency_seconds": round(time.monotonic() - started, 6),
                    "success": True,
                    "error": None,
                }
            )
            break
        except Exception as error:
            attempts.append(
                {
                    "attempt": attempt_number,
                    "started_at": started_at,
                    "latency_seconds": round(time.monotonic() - started, 6),
                    "success": False,
                    "error": sanitize_error(error, api_key),
                }
            )
            if attempt_number < max_attempts:
                sleep(2**attempt_number)

    grading = None
    format_valid = None
    if response is not None:
        format_valid, grading = grade_response(task.maze, response.raw_response)

    record = result_record(
        run_id,
        task,
        prompt_path,
        prompt_hash,
        attempts,
        response,
        grading,
        format_valid,
    )
    atomic_write_json(task.output_path, record)
    return record


def read_current_record(path: Path, run_id: str) -> Optional[Dict[str, Any]]:
    if not path.is_file():
        return None
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return record if record.get("run_id") == run_id else None


def read_compatible_record(
    task: BenchmarkTask,
    prompt_hash: str,
) -> Optional[Dict[str, Any]]:
    if not task.output_path.is_file():
        return None
    try:
        record = json.loads(task.output_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

    record_model = record.get("model") or {}
    expected_model = task.model.public_dict()
    model_matches = all(
        record_model.get(key) == value
        for key, value in expected_model.items()
        if key != "max_output_tokens"
    )
    if model_matches and (
        record_model.get("max_output_tokens") != expected_model["max_output_tokens"]
    ):
        stored_limit = record_model.get("max_output_tokens")
        expected_limit = expected_model["max_output_tokens"]
        response = record.get("response") or {}
        usage = response.get("usage") or {}
        output_tokens = usage.get("output_tokens", response.get("output_tokens"))
        model_matches = (
            record_is_api_success(record)
            and type(stored_limit) is int
            and stored_limit > expected_limit
            and type(output_tokens) is int
            and output_tokens <= expected_limit
        )
    maze = record.get("maze") or {}
    prompt = record.get("prompt") or {}
    if not (
        model_matches
        and maze.get("maze_id") == task.maze.maze_id
        and maze.get("json_sha256") == task.maze.json_sha256
        and maze.get("image_sha256") == task.maze.image_sha256
        and prompt.get("sha256") == prompt_hash
    ):
        return None
    return record


def select_aggregate_tasks(
    configured_models: Sequence[ModelConfig],
    selected_models: Sequence[ModelConfig],
    mazes: Sequence[MazeCase],
    output_dir: Path,
    prompt_hash: str,
) -> List[BenchmarkTask]:
    selected_names = {model.name for model in selected_models}
    aggregate_models = []
    for model in configured_models:
        model_tasks = [
            BenchmarkTask(
                model=model,
                maze=maze,
                output_path=output_dir / result_filename(model, maze),
            )
            for maze in mazes
        ]
        if model.name in selected_names or any(
            read_compatible_record(task, prompt_hash) is not None
            for task in model_tasks
        ):
            aggregate_models.append((model, model_tasks))
    return [
        task
        for _, model_tasks in aggregate_models
        for task in model_tasks
    ]


def read_aggregate_record(
    task: BenchmarkTask,
    run_id: str,
    active_model_names: Optional[set[str]],
    prompt_hash: Optional[str],
    reuse_compatible_active_records: bool = False,
    active_maze_ids: Optional[set[str]] = None,
) -> Optional[Dict[str, Any]]:
    model_is_active = (
        active_model_names is None or task.model.name in active_model_names
    )
    maze_is_active = (
        active_maze_ids is None or task.maze.maze_id in active_maze_ids
    )
    if model_is_active and maze_is_active:
        current = read_current_record(task.output_path, run_id)
        if current is not None or not reuse_compatible_active_records:
            return current
    if prompt_hash is None:
        return None
    return read_compatible_record(task, prompt_hash)


def sum_tokens(records: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    fields = ("input_tokens", "output_tokens", "reasoning_tokens", "total_tokens")
    totals = {field: 0 for field in fields}
    missing = {field: 0 for field in fields}
    for record in records:
        usage = (record.get("response") or {}).get("usage") or {}
        for field in fields:
            value = usage.get(field)
            if isinstance(value, int):
                totals[field] += value
            else:
                missing[field] += 1
    return {"totals": totals, "missing_counts": missing}


def score_stats(records: Sequence[Dict[str, Any]], expected: int) -> Dict[str, Any]:
    api_success = [record for record in records if record_is_api_success(record)]
    graded = [
        record
        for record in api_success
        if isinstance((record.get("grading") or {}).get("score"), (int, float))
    ]
    scores = [float(record["grading"]["score"]) for record in graded]
    provisional = sum(scores) / len(scores) if scores else None
    return {
        "expected_count": expected,
        "processed_count": len(records),
        "api_success_count": len(api_success),
        "api_failure_count": len(records) - len(api_success),
        "graded_count": len(graded),
        "processing_rate": len(records) / expected if expected else 0.0,
        "api_success_rate": len(api_success) / expected if expected else 0.0,
        "coverage": len(graded) / expected if expected else 0.0,
        "provisional_mean_score": provisional,
        "official_mean_score": provisional if len(graded) == expected else None,
        "token_usage": sum_tokens(api_success),
    }


def public_score_stats(
    records: Sequence[Dict[str, Any]],
    expected: int,
) -> Dict[str, Any]:
    stats = score_stats(records, expected)
    return {
        "expected_count": stats["expected_count"],
        "processed_count": stats["processed_count"],
        "api_success_count": stats["api_success_count"],
        "api_failure_count": stats["api_failure_count"],
        "graded_count": stats["graded_count"],
        "processing_rate": stats["processing_rate"],
        "api_success_rate": stats["api_success_rate"],
        "coverage": stats["coverage"],
        "provisional_mean_score": stats["provisional_mean_score"],
        "official_mean_score": stats["official_mean_score"],
        "token_usage": {
            "totals": dict(stats["token_usage"]["totals"]),
            "missing_counts": dict(stats["token_usage"]["missing_counts"]),
        },
    }


def public_result_record(
    task: BenchmarkTask,
    record: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    if record is None:
        return None

    request_success = record_is_api_success(record)
    grading = record.get("grading") if request_success else None
    if not request_success:
        status = "api_failure"
    elif not isinstance(grading, dict):
        status = "grading_unavailable"
    else:
        status = "success"

    response = record.get("response") if request_success else None
    usage = (response or {}).get("usage") or {}
    public_grading = None
    if isinstance(grading, dict):
        public_grading = {
            "success": grading.get("success"),
            "death": grading.get("death"),
            "optimal_action_count": grading.get("optimal_action_count"),
            "actual_action_count": grading.get("actual_action_count"),
            "remaining_action_count": grading.get("remaining_action_count"),
            "completion_ratio": grading.get("completion_ratio"),
            "efficiency_ratio": grading.get("efficiency_ratio"),
        }

    return {
        "status": status,
        "scoring_version": record.get("scoring_version", 1),
        "model": {
            "name": task.model.name,
            "provider": task.model.provider,
            "model_id": task.model.model_id,
            "reasoning_label": reasoning_label(task.model),
        },
        "maze": {
            "maze_id": task.maze.maze_id,
            "width": task.maze.width,
            "height": task.maze.height,
        },
        "output": (response or {}).get("raw_response"),
        "format_valid": record.get("format_valid") if request_success else None,
        "token_usage": {
            "input_tokens": usage.get("input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "reasoning_tokens": usage.get("reasoning_tokens"),
            "total_tokens": usage.get("total_tokens"),
        },
        "score": grading.get("score") if isinstance(grading, dict) else None,
        "grading": public_grading,
    }


def build_public_results(
    run_id: str,
    tasks: Sequence[BenchmarkTask],
    status: str,
    active_model_names: Optional[set[str]] = None,
    prompt_hash: Optional[str] = None,
    reuse_compatible_active_records: bool = False,
    active_maze_ids: Optional[set[str]] = None,
) -> Dict[str, Any]:
    records_by_model: Dict[str, List[Dict[str, Any]]] = {}
    records_by_model_size: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}
    expected_by_model: Dict[str, int] = {}
    model_configs: Dict[str, ModelConfig] = {}
    public_results: List[Dict[str, Any]] = []

    for task in tasks:
        key = task.model.name
        expected_by_model[key] = expected_by_model.get(key, 0) + 1
        model_configs[key] = task.model
        record = read_aggregate_record(
            task,
            run_id,
            active_model_names,
            prompt_hash,
            reuse_compatible_active_records,
            active_maze_ids,
        )
        if record is not None:
            records_by_model.setdefault(key, []).append(record)
            size = f"{task.maze.width}x{task.maze.height}"
            records_by_model_size.setdefault(key, {}).setdefault(size, []).append(
                record
            )
        public_record = public_result_record(task, record)
        if public_record is not None:
            public_results.append(public_record)

    models = []
    for key in sorted(expected_by_model):
        records = records_by_model.get(key, [])
        expected_sizes: Dict[str, int] = {}
        for task in tasks:
            if task.model.name != key:
                continue
            size = f"{task.maze.width}x{task.maze.height}"
            expected_sizes[size] = expected_sizes.get(size, 0) + 1

        config = model_configs[key]
        by_size = records_by_model_size.get(key, {})
        models.append(
            {
                "name": config.name,
                "provider": config.provider,
                "model_id": config.model_id,
                "reasoning_label": reasoning_label(config),
                "pricing": config.pricing_dict(),
                **public_score_stats(records, expected_by_model[key]),
                "by_maze_size": {
                    size: public_score_stats(
                        by_size.get(size, []),
                        expected_sizes[size],
                    )
                    for size in sorted(expected_sizes)
                },
            }
        )

    return {
        "schema_version": PUBLIC_SCHEMA_VERSION,
        "scoring_version": SCORING_VERSION,
        "status": status,
        "expected_result_count": len(tasks),
        "processed_result_count": len(public_results),
        "models": models,
        "results": public_results,
    }


def build_aggregate(
    run_id: str,
    tasks: Sequence[BenchmarkTask],
    status: str,
    active_model_names: Optional[set[str]] = None,
    prompt_hash: Optional[str] = None,
    reuse_compatible_active_records: bool = False,
    active_maze_ids: Optional[set[str]] = None,
) -> Dict[str, Any]:
    records_by_model: Dict[str, List[Dict[str, Any]]] = {}
    expected_by_model: Dict[str, int] = {}
    model_configs: Dict[str, ModelConfig] = {}

    for task in tasks:
        key = task.model.name
        expected_by_model[key] = expected_by_model.get(key, 0) + 1
        model_configs[key] = task.model
        record = read_aggregate_record(
            task,
            run_id,
            active_model_names,
            prompt_hash,
            reuse_compatible_active_records,
            active_maze_ids,
        )
        if record:
            records_by_model.setdefault(key, []).append(record)

    models = []
    for key in sorted(expected_by_model):
        records = records_by_model.get(key, [])
        by_size: Dict[str, List[Dict[str, Any]]] = {}
        expected_sizes: Dict[str, int] = {}
        for task in tasks:
            if task.model.name != key:
                continue
            size = f"{task.maze.width}x{task.maze.height}"
            expected_sizes[size] = expected_sizes.get(size, 0) + 1
        for record in records:
            maze = record["maze"]
            size = f"{maze['width']}x{maze['height']}"
            by_size.setdefault(size, []).append(record)

        config = model_configs[key]
        models.append(
            {
                "name": key,
                "provider": config.provider,
                "model_id": config.model_id,
                "reasoning_label": reasoning_label(config),
                **score_stats(records, expected_by_model[key]),
                "by_maze_size": {
                    size: score_stats(by_size.get(size, []), expected_sizes[size])
                    for size in sorted(expected_sizes)
                },
            }
        )

    all_records = [
        record
        for task in tasks
        if (
            record := read_aggregate_record(
                task,
                run_id,
                active_model_names,
                prompt_hash,
                reuse_compatible_active_records,
                active_maze_ids,
            )
        )
        is not None
    ]
    return {
        "schema_version": SCHEMA_VERSION,
        "scoring_version": SCORING_VERSION,
        "run_id": run_id,
        "updated_at": utc_now(),
        "status": status,
        "expected_result_count": len(tasks),
        "processed_result_count": len(all_records),
        "models": models,
    }


def create_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the maze benchmark through APIs")
    parser.add_argument("--models-config", default="scripts/models.json")
    model_selection = parser.add_mutually_exclusive_group(required=True)
    model_selection.add_argument(
        "--all-models",
        action="store_true",
        help="run every model in the models configuration",
    )
    model_selection.add_argument(
        "--models",
        nargs="+",
        metavar="NAME",
        help="run only models whose name fields exactly match",
    )
    model_selection.add_argument(
        "--list-models",
        action="store_true",
        help="list configured model names without making API requests",
    )
    parser.add_argument("--maze-dir", default="maze_sets")
    parser.add_argument(
        "--maze-sizes",
        nargs="+",
        metavar="SIZE",
        help="run only exact WIDTHxHEIGHT sizes, such as 4x4 6x6",
    )
    parser.add_argument("--prompt", default="scripts/prompt.md")
    parser.add_argument("--output-dir", default="outputs")
    parser.add_argument(
        "--public-output",
        default="public/benchmark_results.json",
        help="write dashboard-safe results to this JSON file",
    )
    parser.add_argument("--max-workers", type=int, default=30)
    parser.add_argument("--max-attempts", type=int, default=3)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    return create_argument_parser().parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = create_argument_parser()
    args = parser.parse_args(argv)
    if args.max_workers < 1 or args.max_attempts < 1:
        parser.error("--max-workers and --max-attempts must be positive")

    root = Path(__file__).resolve().parent.parent
    models_path = (root / args.models_config).resolve()
    maze_dir = (root / args.maze_dir).resolve()
    prompt_path = (root / args.prompt).resolve()
    output_dir = (root / args.output_dir).resolve()
    public_output_path = (root / args.public_output).resolve()
    load_dotenv(root / ".env", override=False)

    configured_models = load_models(models_path)
    if args.list_models:
        if configured_models:
            print("Available models:")
            for model in configured_models:
                print(f"  - {model.name}")
        else:
            print("No models configured.")
        return 0

    try:
        models = select_models(
            configured_models,
            requested_names=args.models,
            all_models=args.all_models,
        )
    except ValueError as error:
        parser.error(str(error))

    if not models:
        print(
            f"No models configured in {models_path}. "
            "Add models before running paid requests.",
            file=sys.stderr,
        )
        return 2

    all_mazes = discover_mazes(maze_dir)
    try:
        mazes = select_mazes(all_mazes, args.maze_sizes)
    except ValueError as error:
        parser.error(str(error))
    prompt_text = prompt_path.read_text(encoding="utf-8")
    prompt_hash = sha256_bytes(prompt_text.encode("utf-8"))
    missing_keys = sorted(
        {model.api_key_env for model in models if not os.getenv(model.api_key_env)}
    )

    tasks = [
        BenchmarkTask(
            model=model,
            maze=maze,
            output_path=output_dir / result_filename(model, maze),
        )
        for model in models
        for maze in mazes
    ]
    ensure_unique_paths(tasks)
    aggregate_tasks = select_aggregate_tasks(
        configured_models,
        models,
        all_mazes,
        output_dir,
        prompt_hash,
    )
    active_model_names = {model.name for model in models}
    active_maze_ids = {maze.maze_id for maze in mazes}
    fingerprint, fingerprint_components = build_fingerprint(models, mazes, prompt_hash)
    state_path = output_dir / "run_state.json"
    aggregate_path = output_dir / "all_model_scores.json"

    if args.dry_run:
        report = {
            "models": [
                {
                    "name": model.name,
                    "provider": model.provider,
                    "model_id": model.model_id,
                    "reasoning": reasoning_label(model),
                }
                for model in models
            ],
            "maze_sizes": list(dict.fromkeys(maze_size(maze) for maze in mazes)),
            "maze_count": len(mazes),
            "request_count": len(tasks),
            "missing_environment_variables": missing_keys,
            "fingerprint": fingerprint,
        }
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 1 if missing_keys else 0

    if missing_keys:
        raise ValueError(
            "Missing API key environment variables: " + ", ".join(missing_keys)
        )

    run_id = str(uuid.uuid4())
    if args.resume:
        pending = [
            task
            for task in tasks
            if not (
                (record := read_compatible_record(task, prompt_hash))
                and record_is_api_success(record)
            )
        ]
    else:
        pending = list(tasks)
    state = {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "created_at": utc_now(),
        "status": "running",
        "resume_mode": bool(args.resume),
        "fingerprint": fingerprint,
        "fingerprint_components": fingerprint_components,
        "expected_result_count": len(tasks),
        "requested_result_count": len(pending),
        "reused_result_count": len(tasks) - len(pending),
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    atomic_write_json(state_path, state)
    atomic_write_json(
        aggregate_path,
        build_aggregate(
            run_id,
            aggregate_tasks,
            status="running",
            active_model_names=active_model_names,
            prompt_hash=prompt_hash,
            reuse_compatible_active_records=args.resume,
            active_maze_ids=active_maze_ids,
        ),
    )
    atomic_write_json(
        public_output_path,
        build_public_results(
            run_id,
            aggregate_tasks,
            status="running",
            active_model_names=active_model_names,
            prompt_hash=prompt_hash,
            reuse_compatible_active_records=args.resume,
            active_maze_ids=active_maze_ids,
        ),
    )

    clients = {
        model.name: create_client(model, os.environ[model.api_key_env])
        for model in models
    }
    completed = 0
    worker_errors: List[Dict[str, str]] = []
    try:
        with ThreadPoolExecutor(max_workers=args.max_workers) as executor:
            futures = {
                executor.submit(
                    run_task,
                    task,
                    clients[task.model.name],
                    os.environ[task.model.api_key_env],
                    prompt_text,
                    prompt_path,
                    prompt_hash,
                    run_id,
                    args.max_attempts,
                ): task
                for task in pending
            }
            for future in as_completed(futures):
                task = futures[future]
                try:
                    record = future.result()
                    result = (
                        f"{record['grading']['score']:.3f}"
                        if record["grading"] is not None
                        else "API failure"
                    )
                    print(f"[{completed + 1}/{len(pending)}] {task.output_path.name}: {result}")
                except Exception as error:
                    worker_error = {
                        "task": task.output_path.name,
                        "error": sanitize_error(
                            error,
                            os.environ[task.model.api_key_env],
                        ),
                    }
                    worker_errors.append(worker_error)
                    print(
                        "Unexpected worker error for "
                        f"{task.output_path.name}: {worker_error['error']}",
                        file=sys.stderr,
                    )
                completed += 1
                atomic_write_json(
                    aggregate_path,
                    build_aggregate(
                        run_id,
                        aggregate_tasks,
                        status="running",
                        active_model_names=active_model_names,
                        prompt_hash=prompt_hash,
                        reuse_compatible_active_records=args.resume,
                        active_maze_ids=active_maze_ids,
                    ),
                )
                atomic_write_json(
                    public_output_path,
                    build_public_results(
                        run_id,
                        aggregate_tasks,
                        status="running",
                        active_model_names=active_model_names,
                        prompt_hash=prompt_hash,
                        reuse_compatible_active_records=args.resume,
                        active_maze_ids=active_maze_ids,
                    ),
                )
    except KeyboardInterrupt:
        state["status"] = "interrupted"
        state["updated_at"] = utc_now()
        atomic_write_json(state_path, state)
        atomic_write_json(
            aggregate_path,
            build_aggregate(
                run_id,
                aggregate_tasks,
                status="interrupted",
                active_model_names=active_model_names,
                prompt_hash=prompt_hash,
                reuse_compatible_active_records=args.resume,
                active_maze_ids=active_maze_ids,
            ),
        )
        atomic_write_json(
            public_output_path,
            build_public_results(
                run_id,
                aggregate_tasks,
                status="interrupted",
                active_model_names=active_model_names,
                prompt_hash=prompt_hash,
                reuse_compatible_active_records=args.resume,
                active_maze_ids=active_maze_ids,
            ),
        )
        print("Interrupted. Re-run with --resume to continue.", file=sys.stderr)
        return 130

    final_status = "failed" if worker_errors else "completed"
    current_run_aggregate = build_aggregate(
        run_id,
        tasks,
        status=final_status,
        active_model_names=active_model_names,
        prompt_hash=prompt_hash,
        reuse_compatible_active_records=args.resume,
        active_maze_ids=active_maze_ids,
    )
    final_aggregate = build_aggregate(
        run_id,
        aggregate_tasks,
        status=final_status,
        active_model_names=active_model_names,
        prompt_hash=prompt_hash,
        reuse_compatible_active_records=args.resume,
        active_maze_ids=active_maze_ids,
    )
    state["status"] = final_status
    state["completed_at"] = utc_now()
    state["processed_result_count"] = current_run_aggregate["processed_result_count"]
    if worker_errors:
        state["worker_errors"] = worker_errors
    atomic_write_json(state_path, state)
    atomic_write_json(aggregate_path, final_aggregate)
    atomic_write_json(
        public_output_path,
        build_public_results(
            run_id,
            aggregate_tasks,
            status=final_status,
            active_model_names=active_model_names,
            prompt_hash=prompt_hash,
            reuse_compatible_active_records=args.resume,
            active_maze_ids=active_maze_ids,
        ),
    )
    return 1 if worker_errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
