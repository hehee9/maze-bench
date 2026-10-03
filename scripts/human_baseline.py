"""참가자별 동일 미로 집합 점수의 공동 추정 및 분위수 집계."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from itertools import combinations
from typing import Any

import numpy as np
import torch
from scipy.optimize import minimize
from scipy.special import expit, logit, logsumexp
from scipy.stats import norm


MODEL_VERSION = "participant-joint-beta-gamma-bounded-v1"
IMPUTATIONS = 2000
RANDOM_SEED = 20261004
GRID_STEP = 0.04
_ENDPOINTS = np.array([0.0, 5.0, 30.0, 3600.0, np.inf])


@dataclass
class _History:
    """전체 시작 이력과 보정 가능한 미로의 수치 입력."""

    people: list[str]
    calibrated_ids: list[str]
    calibrated_tiers: np.ndarray
    records: np.ndarray
    gaps: np.ndarray
    current_ids: list[str]
    current_tiers: np.ndarray
    widths: np.ndarray
    observed: np.ndarray
    orders: np.ndarray
    start_counts: np.ndarray
    calibration_columns: np.ndarray
    metadata: dict[str, dict[str, Any]]
    cohorts: dict[str, np.ndarray]


def _timestamp(value: str) -> float:
    """UTC 시각의 초 단위 변환."""
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def _build_history(scored_records: list[dict], analysis: dict, catalog: dict) -> _History:
    """시작 순서, 카탈로그 소진 구간 및 실제 점수 보존."""
    cutoff = _timestamp(analysis["cutoff"])
    catalogs = sorted(analysis["catalogs"], key=lambda item: (_timestamp(item["registered_at"]), item["catalog_id"]))
    catalog_by_id = {entry["catalog_id"]: entry for entry in catalogs}
    metadata = {}
    for entry in catalogs:
        for maze in entry["mazes"]:
            metadata[maze["maze_id"]] = maze
    current_entry = catalog_by_id[analysis["current_catalog_id"]]
    current_ids = sorted(catalog)
    if {item["maze_id"] for item in current_entry["mazes"]} != set(current_ids):
        raise ValueError("현재 미로 목록과 분석 카탈로그가 일치하지 않습니다.")
    starts = sorted(analysis["starts"], key=lambda item: item["sequence"])
    start_by_attempt = {item["attempt_id"]: item for item in starts}
    if len(start_by_attempt) != len(starts):
        raise ValueError("시작 기록의 시도 ID가 중복되었습니다.")
    terminal = {item["attempt_id"]: item for item in scored_records}
    if len(terminal) != len(scored_records):
        raise ValueError("종료 기록의 시도 ID가 중복되었습니다.")
    people = sorted({start_by_attempt[item["attempt_id"]]["participant_id"] for item in scored_records})
    person_index = {person: index for index, person in enumerate(people)}
    calibrated_ids = sorted({item["maze_id"] for item in scored_records})
    maze_index = {maze: index for index, maze in enumerate(calibrated_ids)}
    current_index = {maze: index for index, maze in enumerate(current_ids)}
    histories = {person: [] for person in people}
    for start in starts:
        if start["participant_id"] in histories:
            histories[start["participant_id"]].append(start)
    observed = np.full((len(people), len(current_ids)), np.nan)
    orders = np.zeros(observed.shape, dtype=np.int64)
    start_counts = np.zeros(len(people), dtype=np.int64)
    records = []
    gaps = []
    cohorts = {tier: np.zeros(len(people), dtype=bool) for tier in ("1", "2")}
    for person, history in histories.items():
        p = person_index[person]
        start_counts[p] = len(history)
        tried = set()
        for ordinal, start in enumerate(history, 1):
            maze_id = start["maze_id"]
            if maze_id in tried:
                raise ValueError("동일 참가자의 미로 시작 기록이 중복되었습니다.")
            tried.add(maze_id)
            if maze_id in current_index:
                orders[p, current_index[maze_id]] = ordinal
            if start["attempt_id"] not in terminal:
                continue
            record = terminal[start["attempt_id"]]
            if record["maze_id"] != maze_id or record["tier"] != start["tier"]:
                raise ValueError("시작 기록과 종료 기록의 미로가 일치하지 않습니다.")
            score = float(record["scoring_result"]["score"])
            if not np.isfinite(score) or not 0 <= score <= 100:
                raise ValueError("실제 점수는 0부터 100 사이여야 합니다.")
            tier = start["tier"]
            cohorts[tier][p] = True
            finished = _timestamp(record["finished_at"])
            records.append([p, maze_index[maze_id], int(tier), score, ordinal])
            if maze_id in current_index:
                observed[p, current_index[maze_id]] = score / 100
            # 시작 시 배포된 카탈로그 기준으로 소진 판정; 사전 등록된 미로 제외.
            available = {maze["maze_id"] for maze in catalog_by_id[start["catalog_id"]]["mazes"]}
            if available <= tried:
                continue
            event = ordinal < len(history)
            end = _timestamp(history[ordinal]["started_at"]) if event else cutoff
            if end < finished:
                raise ValueError("종료 이후 대기 구간의 시각 순서가 올바르지 않습니다.")
            gaps.append([p, ordinal, score, int(event), end - finished])
    return _History(
        people, calibrated_ids,
        np.array([int(metadata[maze]["tier"]) for maze in calibrated_ids]),
        np.asarray(records, dtype=np.float64).reshape(-1, 5),
        np.asarray(gaps, dtype=np.float64).reshape(-1, 5),
        current_ids, np.array([int(metadata[maze]["tier"]) for maze in current_ids]),
        np.array([metadata[maze]["width"] for maze in current_ids], dtype=np.float64),
        observed, orders, start_counts,
        np.array([maze_index[maze] if maze in maze_index else -1 for maze in current_ids]),
        metadata, cohorts,
    )


def _prepare_numeric(records: np.ndarray, gaps: np.ndarray, people: int) -> dict:
    """정규 능력 격자와 구간별 계속 참여 노출량 구성."""
    grid = np.arange(-12, 12 + GRID_STEP / 2, GRID_STEP)
    log_weights = norm.logpdf(grid)
    log_weights -= logsumexp(log_weights)
    exposure = np.maximum(0, np.minimum(gaps[:, 4, None], _ENDPOINTS[None, 1:]) - _ENDPOINTS[None, :-1])
    event = gaps[:, 3].astype(bool)
    tensor = lambda value: torch.as_tensor(value, device="cpu")
    return {
        "I": tensor(records[:, 0].astype(int)), "J": tensor(records[:, 1].astype(int)),
        "v": tensor(records[:, 3] / 100),
        "growth": tensor(1 - 1 / np.sqrt(records[:, 4])),
        "tier": tensor(records[:, 2].astype(int) - 1),
        "x": tensor(grid), "lw": tensor(log_weights),
        "GI": tensor(gaps[:, 0].astype(int)), "exposure": tensor(exposure),
        "event": tensor(event),
        "event_bins": tensor(np.searchsorted(_ENDPOINTS[1:-1], gaps[:, 4])),
        "logk": tensor(np.log(gaps[:, 1])), "lastscore": tensor(gaps[:, 2] / 100),
        "D": tensor(np.bincount(gaps[event, 0].astype(int), minlength=people).astype(float)),
        "people": people,
    }


def _unpack(parameters: torch.Tensor, mazes: int) -> tuple:
    """미로·능력·성장·계속 참여 모수 분리."""
    at = 3 * mazes
    return (
        parameters[:at].reshape(3, mazes), torch.exp(parameters[at]),
        torch.exp(parameters[at + 1:at + 3]), parameters[at + 3:at + 5],
        parameters[at + 5:at + 9], parameters[at + 9], parameters[at + 10],
        parameters[at + 11], torch.exp(parameters[at + 12]),
    )


def _likelihood(parameters: torch.Tensor, data: dict, tiers: np.ndarray, posterior: bool = False) -> torch.Tensor:
    """양 끝점 베타 점수와 감마 계속 참여 성향의 공동 주변우도."""
    abc, sigma, phi, growth, hazard, eta, delta, kappa, frailty = _unpack(parameters, len(tiers))
    ability = sigma * data["x"][None, :]
    latent = ability + growth[data["tier"]][:, None] * data["growth"][:, None]
    success = abc[0, data["J"]][:, None] + latent
    zero = abc[1, data["J"]][:, None] - latent
    mean = torch.sigmoid(abc[2, data["J"]][:, None] + latent)
    concentration = phi[data["tier"]][:, None]
    alpha = (mean * concentration).clamp_min(1e-10)
    beta = ((1 - mean) * concentration).clamp_min(1e-10)
    score = data["v"][:, None].clamp(1e-12, 1 - 1e-12)
    log_beta = ((alpha - 1) * torch.log(score) + (beta - 1) * torch.log1p(-score)
                + torch.lgamma(alpha + beta) - torch.lgamma(alpha) - torch.lgamma(beta))
    log_success = torch.nn.functional.logsigmoid(success)
    log_other = torch.nn.functional.logsigmoid(-success)
    log_score = torch.where(
        data["v"][:, None] == 1, log_success,
        torch.where(data["v"][:, None] == 0,
                    log_other + torch.nn.functional.logsigmoid(zero),
                    log_other + torch.nn.functional.logsigmoid(-zero) + log_beta),
    )
    person_score = torch.zeros((data["people"], len(data["x"])), dtype=torch.float64).index_add(0, data["I"], log_score)
    history = eta * data["logk"] + delta * data["lastscore"]
    cumulative = (data["exposure"] * torch.exp(hazard)[None, :]).sum(dim=1) * torch.exp(history)
    total = torch.zeros(data["people"], dtype=torch.float64).index_add(0, data["GI"], cumulative)
    events = (hazard[data["event_bins"]] + history) * data["event"].to(torch.float64)
    event_total = torch.zeros(data["people"], dtype=torch.float64).index_add(0, data["GI"], events)
    counts = data["D"]
    denominator = torch.logaddexp(torch.log(frailty), torch.log(total.clamp_min(1e-300))[:, None] + kappa * ability)
    continuation = (event_total[:, None] + kappa * ability * counts[:, None]
                    + torch.lgamma(frailty + counts)[:, None] - torch.lgamma(frailty)
                    + frailty * torch.log(frailty) - (frailty + counts[:, None]) * denominator)
    joint = person_score + continuation + data["lw"][None, :]
    if posterior:
        return torch.softmax(joint, dim=1)
    penalty = torch.tensor(0.0, dtype=torch.float64)
    for tier in (1, 2):
        block = abc[:, torch.as_tensor(tiers == tier)]
        if block.shape[1]:
            deviation = block - block.mean(dim=1, keepdim=True)
            penalty += (deviation * deviation).sum() / (2 * 2.5 ** 2)
    penalty += ((growth * growth).sum() + eta * eta + delta * delta + kappa * kappa) / (2 * 3 ** 2)
    return -torch.logsumexp(joint, dim=1).sum() + penalty


def _fit_numeric(records: np.ndarray, gaps: np.ndarray, people: int, tiers: np.ndarray) -> dict:
    """고정 초기값과 경계로 공동 모수 최적화."""
    torch.set_num_threads(1)
    data = _prepare_numeric(records, gaps, people)
    abc = np.zeros((3, len(tiers)))
    for tier in (1, 2):
        values = records[records[:, 2] == tier, 3] / 100
        if not len(values):
            continue
        success = (np.sum(values == 1) + .5) / (len(values) + 1)
        zero = (np.sum(values == 0) + .5) / (np.sum(values < 1) + 1)
        interior = values[(values > 0) & (values < 1)]
        mean = interior.mean() if len(interior) else .5
        abc[:, tiers == tier] = logit([success, zero, mean])[:, None]
    exposure = data["exposure"].numpy().sum(axis=0)
    events = np.bincount(data["event_bins"].numpy()[data["event"].numpy()], minlength=4)
    initial = np.r_[abc.ravel(), np.log(.7), np.log([4, 3]), [.2, .2],
                    np.log((events + .5) / (exposure + 1)), 0, 0, 0, np.log(.5)]
    bounds = ([(None, None)] * (3 * len(tiers)) + [(-6, 3), (-4, 6), (-4, 6)]
              + [(-10, 10)] * 2 + [(-30, 5)] * 4 + [(-10, 10)] * 3 + [(-8, 5)])

    def objective(values: np.ndarray) -> tuple[float, np.ndarray]:
        parameters = torch.tensor(values, dtype=torch.float64, requires_grad=True)
        value = _likelihood(parameters, data, tiers)
        value.backward()
        return float(value.detach()), parameters.grad.detach().numpy()

    result = minimize(objective, initial, jac=True, method="L-BFGS-B", bounds=bounds,
                      options={"maxiter": 1100, "ftol": 1e-10, "gtol": 1e-5, "maxls": 35, "maxcor": 20})
    at_bounds = any(low is not None and min(result.x[i] - low, high - result.x[i]) < 1e-4
                    for i, (low, high) in enumerate(bounds))
    if not result.success or at_bounds or not np.isfinite(result.fun):
        raise RuntimeError(f"참가자 모형 최적화 실패: {result.message}; 경계 도달={at_bounds}")
    with torch.no_grad():
        posterior = _likelihood(torch.tensor(result.x), data, tiers, posterior=True).numpy()
    return {"parameters": result.x, "data": data, "posterior": posterior}


def _draw_orders(history: _History, rng: np.random.Generator) -> np.ndarray:
    """현재 미로의 실제 시작 차수 고정 및 미시작 순서 공동 추정."""
    known = history.orders > 0
    future = ~known
    # 미래 차수 2·3은 서비스의 크기 가중 선택 규칙 유지.
    priority = np.zeros(history.orders.shape, dtype=int)
    for ordinal in (2, 3):
        selected = np.where((history.start_counts < ordinal) & (future & (priority == 0)).any(axis=1))[0]
        if not len(selected):
            continue
        weights = np.where(future[selected] & (priority[selected] == 0), 1 / history.widths[None, :], 0)
        cumulative = np.cumsum(weights, axis=1)
        cumulative /= cumulative[:, -1, None]
        cumulative[:, -1] = 1
        chosen = np.sum(cumulative < rng.random((len(selected), 1)), axis=1)
        priority[selected, chosen] = ordinal
    # 별도 정렬 키로 알려진 차수와 미로 수에 무관하게 미래 차수 배정.
    keys = rng.random(history.orders.shape)
    permutation = np.lexsort((keys, np.where(priority > 0, priority, 4), known), axis=1)
    future_ranks = np.argsort(permutation, axis=1) + 1
    return np.where(known, history.orders, history.start_counts[:, None] + future_ranks)


def _draw_completed(history: _History, fitted: dict, rng: np.random.Generator) -> np.ndarray:
    """참가자별 능력 하나와 모든 결측 점수의 일관된 공동 추출."""
    abc, sigma, phi, growth, *_ = _unpack(torch.tensor(fitted["parameters"]), len(history.calibrated_ids))
    abc, phi, growth = abc.numpy(), phi.numpy(), growth.numpy()
    cumulative = np.cumsum(fitted["posterior"], axis=1)
    cumulative[:, -1] = 1
    selected = np.sum(cumulative < rng.random((len(history.people), 1)), axis=1)
    ability = float(sigma) * fitted["data"]["x"].numpy()[selected, None]
    orders = _draw_orders(history, rng)
    supported = history.calibration_columns >= 0
    columns = history.calibration_columns[supported]
    tiers = history.current_tiers[supported] - 1
    latent = ability + growth[tiers][None, :] * (1 - 1 / np.sqrt(orders[:, supported]))
    success = expit(abc[0, columns][None, :] + latent)
    zero = expit(abc[1, columns][None, :] - latent)
    mean = expit(abc[2, columns][None, :] + latent)
    concentration = phi[tiers][None, :]
    interior = rng.beta(np.maximum(mean * concentration, 1e-10), np.maximum((1 - mean) * concentration, 1e-10))
    generated = np.where(rng.random(success.shape) < success, 1,
                         np.where(rng.random(zero.shape) < zero, 0, interior))
    scores = history.observed.copy()
    scores[:, supported] = np.where(np.isfinite(history.observed[:, supported]), history.observed[:, supported], generated)
    return scores


def _groups(history: _History) -> dict[str, dict]:
    """크기 조합과 출입구 관계별 미로 집합 구성."""
    result = {}
    for tier in ("1", "2"):
        ids = [maze for maze in history.current_ids if history.metadata[maze]["tier"] == tier]
        sizes = sorted({(history.metadata[maze]["width"], history.metadata[maze]["height"]) for maze in ids})
        by_size = {f"{width}x{height}": [maze for maze in ids
                   if (history.metadata[maze]["width"], history.metadata[maze]["height"]) == (width, height)]
                   for width, height in sizes}
        combinations_by_size = {}
        for count in range(1, len(sizes) + 1):
            for subset in combinations(list(by_size), count):
                combinations_by_size["|".join(subset)] = sorted(maze for size in subset for maze in by_size[size])
        result[tier] = {
            "size_combinations": combinations_by_size,
            "by_size": by_size,
            "by_size_relation": {size: {relation: [maze for maze in mazes if history.metadata[maze]["relation"] == relation]
                                        for relation in ("adjacent", "opposite", "same")}
                                 for size, mazes in by_size.items()},
        }
    return result


def build_participant_aggregates(scored_records: list[dict], analysis: dict, catalog: dict) -> dict:
    """동일 참가자 집단의 필터별 평균 점수 분위수 집계.

    실제 점수 보존 후 공동 결측 추정마다 참가자의 선택 미로 평균 계산.
    미보정 미로가 포함된 집합은 공개 추정을 보류.
    """
    history = _build_history(scored_records, analysis, catalog)
    group_ids = _groups(history)
    result = {
        "model": {"version": MODEL_VERSION, "catalog_id": analysis["current_catalog_id"],
                  "cutoff": analysis["cutoff"], "imputations": IMPUTATIONS},
        "tiers": {tier: {"aggregates": {"size_combinations": {}, "by_size": {}, "by_size_relation": {}}}
                  for tier in ("1", "2")},
    }
    index = {maze: column for column, maze in enumerate(history.current_ids)}
    calibrated = set(history.calibrated_ids)
    computations = {}
    for tier, groups in group_ids.items():
        cohort = history.cohorts[tier]
        cache = {}
        entries = []
        for category in ("size_combinations", "by_size"):
            for key, mazes in groups[category].items():
                entries.append((result["tiers"][tier]["aggregates"][category], key, mazes))
        for size, relations in groups["by_size_relation"].items():
            destination = result["tiers"][tier]["aggregates"]["by_size_relation"].setdefault(size, {})
            entries.extend((destination, relation, mazes) for relation, mazes in relations.items())
        for destination, key, mazes in entries:
            group_key = tuple(sorted(mazes))
            if group_key not in cache:
                ready = bool(mazes) and bool(cohort.any()) and set(mazes) <= calibrated
                group = {"status": "ready" if ready else "pending", "maze_ids": list(group_key),
                         "participant_count": int(cohort.sum()),
                         "median_score": None, "p05_score": None, "p95_score": None}
                cache[group_key] = group
                if ready:
                    columns = np.array([index[maze] for maze in group_key])
                    computations[(tier, group_key)] = (group, cohort, columns)
            destination[key] = cache[group_key]
    needs_model = any(not np.isfinite(history.observed[cohort][:, columns]).all()
                      for _, cohort, columns in computations.values())
    fitted = _fit_numeric(history.records, history.gaps, len(history.people), history.calibrated_tiers) if needs_model else None
    sums = {key: np.zeros(3) for key in computations}
    rng = np.random.default_rng(RANDOM_SEED)
    draws = IMPUTATIONS if fitted is not None else 1
    for _ in range(draws):
        scores = _draw_completed(history, fitted, rng) if fitted is not None else history.observed
        for key, (_, cohort, columns) in computations.items():
            means = scores[cohort][:, columns].mean(axis=1) * 100
            sums[key] += np.quantile(means, [.05, .5, .95], method="linear")
    for key, (group, _, _) in computations.items():
        p05, median, p95 = sums[key] / draws
        group.update(p05_score=float(p05), median_score=float(median), p95_score=float(p95))
    return result
