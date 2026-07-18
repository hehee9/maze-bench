"""Run Maze Bench through registered asynchronous Batch API providers."""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict, Optional, Sequence

from dotenv import load_dotenv
from PIL import Image

from anthropic_batch_client import AnthropicBatchProvider
from batch_api import (
    BatchItemResult,
    BatchRequest,
    create_batch_provider,
    register_batch_provider,
    registered_batch_providers,
    supports_batch_model,
)
from run_api_benchmark import (
    BenchmarkTask,
    MazeCase,
    atomic_write_json,
    build_aggregate,
    build_fingerprint,
    build_public_results,
    discover_mazes,
    ensure_unique_paths,
    grade_response,
    load_models,
    maze_size,
    read_current_record,
    result_filename,
    result_record,
    sanitize_error,
    select_aggregate_tasks,
    select_mazes,
    select_models,
    sha256_bytes,
    utc_now,
)


BATCH_STATE_SCHEMA_VERSION = 1
ACTIVE_RUN_STATUSES = {"running", "submitting", "polling", "interrupted"}


register_batch_provider(
    "anthropic",
    AnthropicBatchProvider,
    lambda api_key, max_attempts: AnthropicBatchProvider(
        api_key,
        max_attempts=max_attempts,
    ),
)


def create_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the maze benchmark through registered Batch APIs"
    )
    parser.add_argument("--models-config", default="scripts/models.json")
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument(
        "--all-models",
        action="store_true",
        help="run every model supported by a registered Batch API adapter",
    )
    selection.add_argument(
        "--models",
        nargs="+",
        metavar="NAME",
        help="run only models whose name fields exactly match",
    )
    selection.add_argument(
        "--list-models",
        action="store_true",
        help="list configured models supported by Batch API adapters",
    )
    selection.add_argument(
        "--list-providers",
        action="store_true",
        help="list registered Batch API provider identifiers",
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
    parser.add_argument(
        "--poll-seconds",
        type=float,
        default=60.0,
        help="seconds between provider status checks",
    )
    parser.add_argument(
        "--max-attempts",
        type=int,
        default=3,
        help="maximum attempts for safe status and result GET requests",
    )
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    return create_argument_parser().parse_args(argv)


def _select_batch_models(
    configured_models: Sequence[Any],
    requested_names: Optional[Sequence[str]],
    all_models: bool,
) -> list[Any]:
    if all_models:
        return [model for model in configured_models if supports_batch_model(model)]
    selected = select_models(configured_models, requested_names, all_models=False)
    unsupported = [model.name for model in selected if not supports_batch_model(model)]
    if unsupported:
        providers = ", ".join(registered_batch_providers()) or "(none)"
        raise ValueError(
            "No registered Batch API adapter supports: "
            f"{', '.join(unsupported)}. Registered providers: {providers}"
        )
    return selected


def _model_tasks(
    models: Sequence[Any],
    mazes: Sequence[MazeCase],
    output_dir: Path,
) -> list[BenchmarkTask]:
    return [
        BenchmarkTask(
            model=model,
            maze=maze,
            output_path=output_dir / result_filename(model, maze),
        )
        for model in models
        for maze in mazes
    ]


def _estimate_standard_cost(
    model: Any,
    mazes: Sequence[MazeCase],
    prompt_text: str,
) -> Dict[str, Any]:
    prompt_tokens = max(1, math.ceil(len(prompt_text) / 4))
    estimated_input_tokens = 0
    for maze in mazes:
        with Image.open(maze.image_path) as image:
            image_tokens = max(1, math.ceil((image.width * image.height) / 750))
        estimated_input_tokens += prompt_tokens + image_tokens

    maximum_output_tokens = len(mazes) * model.max_output_tokens
    pricing = model.pricing_dict()
    input_rate = pricing["input_per_million"]
    output_rate = pricing["output_per_million"]
    estimated_max_cost = None
    if input_rate is not None and output_rate is not None:
        estimated_max_cost = (
            estimated_input_tokens * input_rate
            + maximum_output_tokens * output_rate
        ) / 1_000_000
    return {
        "cost_basis": "standard_api",
        "pricing": pricing,
        "estimated_input_tokens": estimated_input_tokens,
        "maximum_output_tokens": maximum_output_tokens,
        "estimated_max_cost_usd": estimated_max_cost,
        "estimate_note": (
            "Input tokens use an image-area and character-count estimate; "
            "output tokens use the configured maximum. Batch discounts are excluded."
        ),
    }


def _validate_dry_run_requests(
    model: Any,
    task_map: Dict[str, BenchmarkTask],
    prompt_text: str,
    max_attempts: int,
) -> int:
    provider = create_batch_provider(model, "", max_attempts)
    requests_to_submit = _build_requests(
        provider,
        model,
        task_map,
        list(task_map),
        prompt_text,
    )
    return sum(
        len(json.dumps(request.payload, ensure_ascii=False).encode("utf-8"))
        for request in requests_to_submit
    )


def _read_json(path: Path) -> Dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return data


def _ensure_sync_runner_idle(output_dir: Path) -> None:
    state_path = output_dir / "run_state.json"
    if not state_path.is_file():
        return
    try:
        state = _read_json(state_path)
    except (OSError, ValueError, json.JSONDecodeError):
        return
    if state.get("status") == "running":
        raise ValueError(
            "The synchronous benchmark is marked running in outputs/run_state.json. "
            "Finish or interrupt it before updating shared aggregate files."
        )


def _new_model_state(model: Any, custom_ids: Sequence[str]) -> Dict[str, Any]:
    return {
        "provider": model.provider,
        "model_id": model.model_id,
        "status": "pending_submission",
        "pending_custom_ids": list(custom_ids),
        "succeeded_custom_ids": [],
        "failed_custom_ids": [],
        "active_batch_id": None,
        "batches": [],
    }


def _new_state(
    run_id: str,
    fingerprint: str,
    fingerprint_components: Dict[str, Any],
    models: Sequence[Any],
    tasks_by_model: Dict[str, Dict[str, BenchmarkTask]],
) -> Dict[str, Any]:
    return {
        "schema_version": BATCH_STATE_SCHEMA_VERSION,
        "run_id": run_id,
        "created_at": utc_now(),
        "updated_at": utc_now(),
        "status": "running",
        "execution_mode": "batch",
        "fingerprint": fingerprint,
        "fingerprint_components": fingerprint_components,
        "expected_result_count": sum(len(tasks) for tasks in tasks_by_model.values()),
        "models": {
            model.name: _new_model_state(
                model,
                list(tasks_by_model[model.name]),
            )
            for model in models
        },
    }


def _active_batch(model_state: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    batch_id = model_state.get("active_batch_id")
    if not batch_id:
        return None
    for batch in reversed(model_state.get("batches") or []):
        if batch.get("batch_id") == batch_id:
            return batch
    raise ValueError(f"State references unknown active batch: {batch_id}")


def _build_requests(
    provider: Any,
    model: Any,
    task_map: Dict[str, BenchmarkTask],
    custom_ids: Sequence[str],
    prompt_text: str,
) -> list[BatchRequest]:
    return [
        provider.build_request(
            model,
            custom_id,
            prompt_text,
            str(task_map[custom_id].maze.image_path),
        )
        for custom_id in custom_ids
    ]


def _submit_model_batch(
    state: Dict[str, Any],
    state_path: Path,
    model: Any,
    model_state: Dict[str, Any],
    provider: Any,
    task_map: Dict[str, BenchmarkTask],
    custom_ids: Sequence[str],
    prompt_text: str,
) -> None:
    if not custom_ids:
        return
    model_state["status"] = "submitting"
    state["status"] = "submitting"
    state["updated_at"] = utc_now()
    atomic_write_json(state_path, state)

    requests_to_submit = _build_requests(
        provider,
        model,
        task_map,
        custom_ids,
        prompt_text,
    )
    submission = provider.submit(requests_to_submit)
    batch_record = {
        **asdict(submission),
        "custom_ids": list(custom_ids),
        "submitted_at": utc_now(),
        "local_results_saved": False,
        "raw_result_path": None,
    }
    model_state["batches"].append(batch_record)
    model_state["active_batch_id"] = submission.batch_id
    model_state["status"] = submission.status
    state["status"] = "running"
    state["updated_at"] = utc_now()
    atomic_write_json(state_path, state)
    print(
        f"Submitted [{model.name}] {len(custom_ids)} request(s): "
        f"{submission.batch_id}"
    )


def _validate_result_items(
    items: Sequence[BatchItemResult],
    expected_custom_ids: Sequence[str],
) -> Dict[str, BatchItemResult]:
    expected = set(expected_custom_ids)
    mapped: Dict[str, BatchItemResult] = {}
    for item in items:
        if item.custom_id not in expected:
            raise ValueError(
                f"Batch result contains unknown custom_id: {item.custom_id}"
            )
        if item.custom_id in mapped:
            raise ValueError(
                f"Batch result contains duplicate custom_id: {item.custom_id}"
            )
        mapped[item.custom_id] = item
    return mapped


def _existing_attempts(task: BenchmarkTask, run_id: str) -> list[Dict[str, Any]]:
    record = read_current_record(task.output_path, run_id)
    if not record:
        return []
    attempts = (record.get("request") or {}).get("attempts")
    return list(attempts) if isinstance(attempts, list) else []


def _write_item_record(
    run_id: str,
    task: BenchmarkTask,
    prompt_path: Path,
    prompt_hash: str,
    batch_id: str,
    item: BatchItemResult,
) -> bool:
    attempts = _existing_attempts(task, run_id)
    response = item.response if item.result_type == "succeeded" else None
    attempts.append(
        {
            "attempt": len(attempts) + 1,
            "started_at": utc_now(),
            "latency_seconds": 0.0,
            "success": response is not None,
            "error": None if response is not None else item.error_message,
            "execution_mode": "batch",
            "provider_batch_id": batch_id,
            "provider_result_type": item.result_type,
        }
    )
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
    record["request"]["execution_mode"] = "batch"
    record["request"]["provider"] = task.model.provider
    record["request"]["provider_batch_id"] = batch_id
    atomic_write_json(task.output_path, record)
    return response is not None


def _save_batch_results(
    state: Dict[str, Any],
    state_path: Path,
    output_dir: Path,
    model: Any,
    model_state: Dict[str, Any],
    batch_record: Dict[str, Any],
    task_map: Dict[str, BenchmarkTask],
    prompt_path: Path,
    prompt_hash: str,
    raw_text: str,
    items: Sequence[BatchItemResult],
) -> None:
    expected_ids = list(batch_record["custom_ids"])
    mapped = _validate_result_items(items, expected_ids)
    raw_path = (
        output_dir
        / "batches"
        / model.provider
        / f"{batch_record['batch_id']}.jsonl"
    )
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    raw_path.write_text(raw_text, encoding="utf-8")

    succeeded = set(model_state.get("succeeded_custom_ids") or [])
    failed = set(model_state.get("failed_custom_ids") or [])
    for custom_id in expected_ids:
        item = mapped.get(custom_id)
        if item is None:
            item = BatchItemResult(
                custom_id=custom_id,
                result_type="missing",
                error_message="Batch result did not contain this custom_id",
            )
        success = _write_item_record(
            state["run_id"],
            task_map[custom_id],
            prompt_path,
            prompt_hash,
            batch_record["batch_id"],
            item,
        )
        if success:
            succeeded.add(custom_id)
            failed.discard(custom_id)
        else:
            failed.add(custom_id)

    all_custom_ids = set(task_map)
    failed.update(all_custom_ids - succeeded - failed)
    model_state["succeeded_custom_ids"] = sorted(succeeded)
    model_state["failed_custom_ids"] = sorted(failed)
    model_state["pending_custom_ids"] = sorted(all_custom_ids - succeeded)
    model_state["status"] = (
        "completed" if not model_state["pending_custom_ids"] else "completed_with_failures"
    )
    model_state["active_batch_id"] = None
    batch_record["local_results_saved"] = True
    batch_record["raw_result_path"] = str(raw_path.resolve())
    batch_record["result_counts"] = {
        result_type: sum(1 for item in items if item.result_type == result_type)
        for result_type in sorted({item.result_type for item in items})
    }
    state["updated_at"] = utc_now()
    atomic_write_json(state_path, state)


def _write_aggregates(
    run_id: str,
    aggregate_tasks: Sequence[BenchmarkTask],
    active_model_names: set[str],
    active_maze_ids: set[str],
    prompt_hash: str,
    status: str,
    aggregate_path: Path,
    public_output_path: Path,
) -> None:
    atomic_write_json(
        aggregate_path,
        build_aggregate(
            run_id,
            aggregate_tasks,
            status=status,
            active_model_names=active_model_names,
            prompt_hash=prompt_hash,
            active_maze_ids=active_maze_ids,
        ),
    )
    atomic_write_json(
        public_output_path,
        build_public_results(
            run_id,
            aggregate_tasks,
            status=status,
            active_model_names=active_model_names,
            prompt_hash=prompt_hash,
            active_maze_ids=active_maze_ids,
        ),
    )


def _progress_text(model_name: str, status: Any) -> str:
    counts = status.request_counts
    finished = sum(
        counts.get(key, 0)
        for key in ("succeeded", "errored", "canceled", "expired")
    )
    total = finished + counts.get("processing", 0)
    return (
        f"[{model_name}] {status.status}: {finished}/{total} finished "
        f"(succeeded={counts.get('succeeded', 0)}, "
        f"errored={counts.get('errored', 0)}, "
        f"canceled={counts.get('canceled', 0)}, "
        f"expired={counts.get('expired', 0)})"
    )


def _sanitize_state_error(error: BaseException, models: Sequence[Any]) -> str:
    text = str(error)
    for model in models:
        text = sanitize_error(
            RuntimeError(text),
            os.environ.get(model.api_key_env, ""),
        )
    return text


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = create_argument_parser()
    args = parser.parse_args(argv)
    if args.poll_seconds < 0 or args.max_attempts < 1:
        parser.error("--poll-seconds must be non-negative and --max-attempts positive")

    root = Path(__file__).resolve().parent.parent
    models_path = (root / args.models_config).resolve()
    maze_dir = (root / args.maze_dir).resolve()
    prompt_path = (root / args.prompt).resolve()
    output_dir = (root / args.output_dir).resolve()
    public_output_path = (root / args.public_output).resolve()
    aggregate_path = output_dir / "all_model_scores.json"
    state_path = output_dir / "batch_state.json"
    load_dotenv(root / ".env", override=False)

    if args.list_providers:
        print("\n".join(registered_batch_providers()))
        return 0

    configured_models = load_models(models_path)
    batch_models = [
        model for model in configured_models if supports_batch_model(model)
    ]
    if args.list_models:
        if batch_models:
            print("Available Batch API models:")
            for model in batch_models:
                print(f"  - {model.name} ({model.provider})")
        else:
            print("No configured models have a registered Batch API adapter.")
        return 0

    try:
        models = _select_batch_models(
            configured_models,
            args.models,
            args.all_models,
        )
    except ValueError as error:
        parser.error(str(error))
    if not models:
        print("No configured models support a registered Batch API.", file=sys.stderr)
        return 2

    all_mazes = discover_mazes(maze_dir)
    try:
        mazes = select_mazes(all_mazes, args.maze_sizes)
    except ValueError as error:
        parser.error(str(error))
    prompt_text = prompt_path.read_text(encoding="utf-8")
    prompt_hash = sha256_bytes(prompt_text.encode("utf-8"))
    tasks = _model_tasks(models, mazes, output_dir)
    ensure_unique_paths(tasks)
    tasks_by_model = {
        model.name: {
            task.maze.maze_id: task
            for task in tasks
            if task.model.name == model.name
        }
        for model in models
    }
    fingerprint, fingerprint_components = build_fingerprint(
        models,
        mazes,
        prompt_hash,
    )
    missing_keys = sorted(
        {model.api_key_env for model in models if not os.getenv(model.api_key_env)}
    )

    if args.dry_run:
        report = {
            "execution_mode": "batch",
            "providers": sorted({model.provider for model in models}),
            "models": [
                {
                    "name": model.name,
                    "provider": model.provider,
                    "model_id": model.model_id,
                    "request_count": len(tasks_by_model[model.name]),
                    "request_payload_bytes": _validate_dry_run_requests(
                        model,
                        tasks_by_model[model.name],
                        prompt_text,
                        args.max_attempts,
                    ),
                    **_estimate_standard_cost(model, mazes, prompt_text),
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

    _ensure_sync_runner_idle(output_dir)
    aggregate_tasks = select_aggregate_tasks(
        configured_models,
        models,
        all_mazes,
        output_dir,
        prompt_hash,
    )
    active_model_names = {model.name for model in models}
    active_maze_ids = {maze.maze_id for maze in mazes}
    providers = {
        model.name: create_batch_provider(
            model,
            os.environ[model.api_key_env],
            args.max_attempts,
        )
        for model in models
    }

    if args.resume:
        if not state_path.is_file():
            raise ValueError("--resume requires an existing outputs/batch_state.json")
        state = _read_json(state_path)
        if state.get("fingerprint") != fingerprint:
            raise ValueError(
                "--resume fingerprint mismatch: prompt, maze, or model settings changed"
            )
        if set((state.get("models") or {})) != active_model_names:
            raise ValueError("--resume model selection does not match batch_state.json")
        state["status"] = "running"
        state["resumed_at"] = utc_now()
    else:
        if state_path.is_file():
            existing = _read_json(state_path)
            if existing.get("status") in ACTIVE_RUN_STATUSES:
                raise ValueError(
                    "An unresolved batch run already exists. "
                    "Use --resume instead of creating duplicate provider batches."
                )
        state = _new_state(
            str(uuid.uuid4()),
            fingerprint,
            fingerprint_components,
            models,
            tasks_by_model,
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    atomic_write_json(state_path, state)
    _write_aggregates(
        state["run_id"],
        aggregate_tasks,
        active_model_names,
        active_maze_ids,
        prompt_hash,
        "running",
        aggregate_path,
        public_output_path,
    )

    retry_allowed = args.resume
    retries_submitted: set[str] = set()
    try:
        for model in models:
            model_state = state["models"][model.name]
            active = _active_batch(model_state)
            if active and not active.get("local_results_saved"):
                continue
            pending = list(model_state.get("pending_custom_ids") or [])
            if pending:
                _submit_model_batch(
                    state,
                    state_path,
                    model,
                    model_state,
                    providers[model.name],
                    tasks_by_model[model.name],
                    pending,
                    prompt_text,
                )
                if args.resume:
                    retries_submitted.add(model.name)

        while True:
            active_models = [
                model
                for model in models
                if _active_batch(state["models"][model.name]) is not None
            ]
            if not active_models:
                break

            for model in active_models:
                model_state = state["models"][model.name]
                batch_record = _active_batch(model_state)
                if batch_record is None:
                    continue
                provider = providers[model.name]
                status = provider.retrieve(batch_record["batch_id"])
                batch_record.update(
                    {
                        "status": status.status,
                        "request_counts": dict(status.request_counts),
                        "ended_at": status.ended_at,
                        "expires_at": status.expires_at,
                        "results_url": status.results_url,
                        "last_checked_at": utc_now(),
                    }
                )
                model_state["status"] = status.status
                state["status"] = "polling"
                state["updated_at"] = utc_now()
                atomic_write_json(state_path, state)
                print(_progress_text(model.name, status))
                if not status.terminal:
                    continue

                raw_text, items = provider.download_results(status.batch_id)
                _save_batch_results(
                    state,
                    state_path,
                    output_dir,
                    model,
                    model_state,
                    batch_record,
                    tasks_by_model[model.name],
                    prompt_path,
                    prompt_hash,
                    raw_text,
                    items,
                )
                _write_aggregates(
                    state["run_id"],
                    aggregate_tasks,
                    active_model_names,
                    active_maze_ids,
                    prompt_hash,
                    "running",
                    aggregate_path,
                    public_output_path,
                )

                pending = list(model_state.get("pending_custom_ids") or [])
                if (
                    retry_allowed
                    and pending
                    and model.name not in retries_submitted
                ):
                    _submit_model_batch(
                        state,
                        state_path,
                        model,
                        model_state,
                        provider,
                        tasks_by_model[model.name],
                        pending,
                        prompt_text,
                    )
                    retries_submitted.add(model.name)

            if any(
                _active_batch(state["models"][model.name]) is not None
                for model in models
            ):
                time.sleep(args.poll_seconds)
    except KeyboardInterrupt:
        state["status"] = "interrupted"
        state["updated_at"] = utc_now()
        atomic_write_json(state_path, state)
        _write_aggregates(
            state["run_id"],
            aggregate_tasks,
            active_model_names,
            active_maze_ids,
            prompt_hash,
            "interrupted",
            aggregate_path,
            public_output_path,
        )
        print("Interrupted. Re-run with --resume to continue.", file=sys.stderr)
        return 130
    except Exception as error:
        state["status"] = "interrupted"
        state["updated_at"] = utc_now()
        state["last_error"] = _sanitize_state_error(error, models)
        atomic_write_json(state_path, state)
        _write_aggregates(
            state["run_id"],
            aggregate_tasks,
            active_model_names,
            active_maze_ids,
            prompt_hash,
            "interrupted",
            aggregate_path,
            public_output_path,
        )
        raise

    has_failures = any(
        model_state.get("pending_custom_ids")
        for model_state in state["models"].values()
    )
    state["status"] = "completed_with_failures" if has_failures else "completed"
    state["completed_at"] = utc_now()
    state["updated_at"] = utc_now()
    state["processed_result_count"] = sum(
        len(tasks_by_model[model.name]) for model in models
    )
    atomic_write_json(state_path, state)
    _write_aggregates(
        state["run_id"],
        aggregate_tasks,
        active_model_names,
        active_maze_ids,
        prompt_hash,
        "completed",
        aggregate_path,
        public_output_path,
    )
    return 1 if has_failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
