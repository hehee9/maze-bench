/**
 * @file public/benchmark-data.js
 * @description Share benchmark formatting, cost, URL, and catalog helpers
 */

(function exposeBenchmarkData(globalScope) {
  "use strict";

  const i18n = globalScope.MazeBenchI18n;
  const RELATIONS = ["adjacent", "opposite", "same"];
  const TIER_CONFIG = Object.freeze({
    1: Object.freeze({
      id: 1,
      resultsFile: "benchmark_results.json",
      mazeDirectory: "../maze_sets",
      problemCount: 30,
      sizes: Object.freeze(["4x4", "6x6", "9x9", "12x12", "15x15", "18x18"]),
    }),
    2: Object.freeze({
      id: 2,
      resultsFile: "benchmark_results_tier2.json",
      mazeDirectory: "../maze_sets_tier2",
      problemCount: 20,
      sizes: Object.freeze(["15x15", "18x18", "21x21", "24x24"]),
    }),
  });
  const TOKEN_FIELDS = [
    "input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "total_tokens",
  ];
  const HUMAN_RESULTS_FILE = "human_results.json";
  const HUMAN_SCORE_FIELDS = [
    {
      id: "human-median",
      labelKey: "leaderboard.humanMedian",
      scoreField: "median_score",
      color: "#6B5CE7",
    },
    {
      id: "human-top-five",
      labelKey: "leaderboard.humanTopFive",
      scoreField: "p95_score",
      color: "#9B8CE8",
    },
  ];
  const REASONING_NAME_SUFFIX = /\s+\((?:minimal|medium|thinking|non-thinking|8k thinking)\)$/i;
  const MODEL_DEVELOPERS = {
    anthropic: {
      key: "anthropic",
      label: "Anthropic",
      color: "#D97757",
      iconPath: "assets/developers/anthropic.svg",
    },
    deepseek: {
      key: "deepseek",
      label: "DeepSeek",
      color: "#5786FE",
      iconPath: "assets/developers/deepseek.svg",
    },
    google: {
      key: "google",
      label: "Google",
      color: "#4285F4",
      iconPath: "assets/developers/google.svg",
    },
    meta: {
      key: "meta",
      label: "Meta",
      color: "#0064E0",
      iconPath: "assets/developers/meta.svg",
    },
    minimax: {
      key: "minimax",
      label: "MiniMax",
      color: "#A855F7",
      iconPath: "assets/developers/minimax.svg",
    },
    moonshotai: {
      key: "moonshotai",
      label: "Moonshot AI",
      color: "#3F3F46",
      iconPath: "assets/developers/moonshot-ai.svg",
    },
    openai: {
      key: "openai",
      label: "OpenAI",
      color: "#10A37F",
      iconPath: "assets/developers/openai.svg",
    },
    qwen: {
      key: "qwen",
      label: "Alibaba Cloud",
      color: "#FF6A00",
      iconPath: "assets/developers/qwen.svg",
    },
    xiaomi: {
      key: "xiaomi",
      label: "Xiaomi",
      color: "#FF6900",
      iconPath: "assets/developers/xiaomi.svg",
    },
    "z-ai": {
      key: "z-ai",
      label: "Z.ai",
      color: "#2D2D2D",
      iconPath: "assets/developers/z-ai.svg",
    },
    "x-ai": {
      key: "x-ai",
      label: "xAI",
      color: "#18181B",
      iconPath: "assets/developers/xai.ico",
    },
    unknown: {
      key: "unknown",
      color: "#94A3B8",
      iconPath: "assets/developers/unknown.svg",
    },
  };

  /** @description Translate a dashboard string with a Korean fallback */
  function _t(key, parameters = {}) {
    return i18n?.t(key, parameters) ?? key;
  }

  /** @description Create an error that can be translated again after a locale change */
  function _error(key, parameters = {}) {
    const error = new Error(_t(key, parameters));
    error.translationKey = key;
    error.translationParameters = parameters;
    return error;
  }

  /** @description Build a stable key for a model */
  function modelKey(value) {
    const model = value?.model ?? value ?? {};
    return [
      model.provider,
      model.model_id,
      model.reasoning_label,
      model.name,
    ].join("\u001f");
  }

  /** @description Return a model name without its trailing reasoning configuration */
  function displayModelName(value) {
    const model = value?.model ?? value ?? {};
    const name = model.name ?? model.model_id ?? _t("common.noNameModel");
    return String(name).replace(REASONING_NAME_SUFFIX, "");
  }

  /** @description Convert a maze size to its canonical query value */
  function mazeSize(maze) {
    return `${maze.width}x${maze.height}`;
  }

  /** @description Sort canonical maze sizes by area and dimensions */
  function compareSizes(first, second) {
    const [firstWidth, firstHeight] = first.split("x").map(Number);
    const [secondWidth, secondHeight] = second.split("x").map(Number);
    return (
      firstWidth * firstHeight - secondWidth * secondHeight
      || firstWidth - secondWidth
      || firstHeight - secondHeight
    );
  }

  /** @description Collect every maze size represented by models or results */
  function getSizes(payload) {
    const sizes = new Set();
    for (const model of payload.models ?? []) {
      for (const size of Object.keys(model.by_maze_size ?? {})) {
        sizes.add(size);
      }
    }
    for (const result of payload.results ?? []) {
      if (result.maze?.width && result.maze?.height) {
        sizes.add(mazeSize(result.maze));
      }
    }
    return [...sizes].sort(compareSizes);
  }

  /** @description Return overall or size-specific aggregate statistics */
  function statsForModel(model, size) {
    if (!model) {
      return null;
    }
    return size === "all" ? model : model.by_maze_size?.[size] ?? null;
  }

  /** @description Classify aggregate completion for ranking and display */
  function aggregateState(stats) {
    if (!stats || Number(stats.processed_count) === 0) {
      return "empty";
    }
    return (
      Number(stats.processed_count) >= Number(stats.expected_count)
      && Number.isFinite(stats.official_mean_score)
    )
      ? "complete"
      : "partial";
  }

  /** @description Sort models by aggregate state and score, then assign official ranks */
  function rankModels(models, statsSelector = (model) => model) {
    const entries = models.map((model, originalIndex) => {
      const stats = statsSelector(model);
      const state = aggregateState(stats);
      const score = state === "complete"
        ? stats?.official_mean_score
        : stats?.provisional_mean_score;
      return {
        model,
        stats,
        state,
        score,
        processed: Number(stats?.processed_count) || 0,
        expected: Number(stats?.expected_count) || 0,
        originalIndex,
        rank: null,
      };
    });
    const stateOrder = { complete: 0, partial: 1, empty: 2 };
    entries.sort((first, second) => (
      stateOrder[first.state] - stateOrder[second.state]
      || (
        (Number.isFinite(second.score) ? second.score : -Infinity)
        - (Number.isFinite(first.score) ? first.score : -Infinity)
      )
      || first.originalIndex - second.originalIndex
    ));

    let rank = 0;
    for (const entry of entries) {
      if (entry.state === "complete") {
        rank += 1;
        entry.rank = rank;
      }
    }
    return entries;
  }

  /** @description 모델과 사람 상세 항목을 기존 완료 규칙으로 정렬 */
  function rankModelDetailEntries(models, humanAggregate) {
    const entries = rankModels(models).map((entry) => ({
      ...entry,
      type: "model",
    }));
    const humanStats = humanAggregate.stats;
    entries.push({
      type: "human",
      key: "human",
      stats: humanStats,
      state: aggregateState(humanStats),
      score: humanAggregate.score,
      processed: Number(humanStats.processed_count) || 0,
      expected: Number(humanStats.expected_count) || 0,
      originalIndex: entries.length,
      rank: null,
    });

    const stateOrder = { complete: 0, partial: 1, empty: 2 };
    entries.sort((first, second) => (
      stateOrder[first.state] - stateOrder[second.state]
      || (
        (Number.isFinite(second.score) ? second.score : -Infinity)
        - (Number.isFinite(first.score) ? first.score : -Infinity)
      )
      || first.originalIndex - second.originalIndex
    ));

    let rank = 0;
    for (const entry of entries) {
      if (entry.state === "complete") {
        entry.rank = ++rank;
      }
    }
    return entries;
  }

  /** @description 모델과 인간 점수 행의 통합 순위 */
  function rankLeaderboardEntries(
    models,
    statsSelector = (model) => model,
    humanRows = [],
  ) {
    const modelEntries = rankModels(models, statsSelector).map((entry) => ({
      ...entry,
      type: "model",
      key: modelKey(entry.model),
    }));
    const entries = [
      ...modelEntries,
      ...humanRows.map((humanRow, index) => ({
        ...humanRow,
        type: "human",
        key: humanRow.id,
        processed: humanRow.stats.processed_count,
        expected: humanRow.stats.expected_count,
        originalIndex: modelEntries.length + index,
        rank: null,
      })),
    ];
    const stateOrder = { complete: 0, partial: 1, empty: 2 };
    entries.sort((first, second) => (
      stateOrder[first.state] - stateOrder[second.state]
      || (
        (Number.isFinite(second.score) ? second.score : -Infinity)
        - (Number.isFinite(first.score) ? first.score : -Infinity)
      )
      || first.originalIndex - second.originalIndex
    ));

    let rank = 0;
    for (const entry of entries) {
      if (entry.state === "complete") {
        rank += 1;
        entry.rank = rank;
      }
    }
    return entries;
  }

  /** @description Sort ranked entries while keeping missing values at the bottom */
  function sortRankedEntries(entries, key, direction) {
    const collator = new Intl.Collator(
      i18n?.getLocale() === "ko" ? "ko-KR" : "en-US",
      {
      numeric: true,
      sensitivity: "base",
      },
    );
    const directionFactor = direction === "ascending" ? 1 : -1;
    const sortValue = (entry) => {
      if (key === "rank") {
        return Number.isFinite(entry.rank) ? entry.rank : null;
      }
      if (key === "model") {
        return entry.type === "human"
          ? entry.label
          : entry.model?.name ?? entry.model?.model_id ?? _t("common.noNameModel");
      }
      if (key === "score") {
        return Number.isFinite(entry.score) ? entry.score : null;
      }
      if (key === "cost") {
        return entry.type === "human"
          ? null
          : calculateCost(entry.stats?.token_usage, entry.model?.pricing);
      }
      if (key === "tokens") {
        const tokenUsage = entry.stats?.token_usage;
        if (
          !Number.isFinite(tokenUsage?.totals?.total_tokens)
          || Number(tokenUsage?.missing_counts?.total_tokens) > 0
        ) {
          return null;
        }
        return tokenUsage.totals.total_tokens;
      }
      return null;
    };

    return entries
      .map((entry, stableIndex) => ({
        entry,
        stableIndex,
        value: sortValue(entry),
      }))
      .sort((first, second) => {
        const firstMissing = first.value === null;
        const secondMissing = second.value === null;
        if (firstMissing !== secondMissing) {
          return firstMissing ? 1 : -1;
        }
        if (firstMissing) {
          return first.stableIndex - second.stableIndex;
        }
        const comparison = typeof first.value === "string"
          ? collator.compare(first.value, second.value)
          : first.value - second.value;
        return (
          comparison * directionFactor
          || first.stableIndex - second.stableIndex
        );
      })
      .map(({ entry }) => entry);
  }

  /** @description Identify a model developer from public provider metadata */
  function modelDeveloper(model) {
    let developer = MODEL_DEVELOPERS.unknown;
    if (model?.provider === "openai_responses") {
      developer = MODEL_DEVELOPERS.openai;
    } else if (model?.provider === "google") {
      developer = MODEL_DEVELOPERS.google;
    } else if (model?.provider === "anthropic") {
      developer = MODEL_DEVELOPERS.anthropic;
    } else if (model?.provider === "openai_chat") {
      const modelId = String(model.model_id ?? "").toLowerCase();
      const prefix = modelId.split("/", 1)[0];
      developer = modelId.startsWith("deepseek-")
        ? MODEL_DEVELOPERS.deepseek
        : MODEL_DEVELOPERS[prefix] ?? MODEL_DEVELOPERS.unknown;
    }
    return developer.key === "unknown"
      ? { ...developer, label: _t("common.unknownDeveloper") }
      : developer;
  }

  /** @description Return the shared chart color for a model developer */
  function developerColor(model) {
    return modelDeveloper(model).color;
  }

  /** @description 순위가 매겨진 완료 항목의 개발사별 선택 개수 제한 */
  function _selectDefaultRankedEntries(
    entries,
    developerKeySelector,
    maxPerDeveloper,
    maxEntries,
  ) {
    const developerCounts = new Map();
    const selected = [];
    for (const entry of entries) {
      if (entry.state !== "complete" || selected.length >= maxEntries) {
        continue;
      }
      const developerKey = developerKeySelector(entry);
      const count = developerCounts.get(developerKey) ?? 0;
      if (count >= maxPerDeveloper) {
        continue;
      }
      selected.push(entry);
      developerCounts.set(developerKey, count + 1);
    }
    return selected;
  }

  /** @description Select top complete models with a per-developer limit */
  function selectDefaultModels(models, {
    maxPerDeveloper = 3,
    maxModels = 9,
  } = {}) {
    return _selectDefaultRankedEntries(
      rankModels(models),
      (entry) => modelDeveloper(entry.model).key,
      maxPerDeveloper,
      maxModels,
    ).map(({ model }) => model);
  }

  /** @description 모델과 인간 행에 공통 기본 차트 선택 규칙 적용 */
  function selectDefaultEntries(entries, {
    maxPerDeveloper = 3,
    maxEntries = 9,
  } = {}) {
    const rankedEntries = entries
      .filter((entry) => entry.state === "complete")
      .sort((first, second) => first.rank - second.rank);
    return _selectDefaultRankedEntries(
      rankedEntries,
      (entry) => entry.type === "human"
        ? "human"
        : modelDeveloper(entry.model).key,
      maxPerDeveloper,
      maxEntries,
    );
  }

  /** @description Return the entrance relation encoded in a public maze identifier */
  function mazeRelation(maze) {
    const match = /_(adjacent|opposite|same)_/i.exec(maze?.maze_id ?? "");
    return match?.[1].toLowerCase() ?? null;
  }

  /** @description Average finite score values */
  function _meanScore(values) {
    if (values.length === 0) {
      return null;
    }
    return values.reduce((total, value) => total + value, 0) / values.length;
  }

  /** @description Aggregate one model's public scores by maze size and entrance relation */
  function aggregateModelScores(results, model, requestedSizes = null) {
    const selectedResults = results.filter(
      (result) => modelKey(result) === modelKey(model),
    );
    const discoveredSizes = new Set();
    const sizeScores = new Map();
    const cellScores = new Map();

    for (const result of selectedResults) {
      if (!result.maze?.width || !result.maze?.height) {
        continue;
      }
      const size = mazeSize(result.maze);
      discoveredSizes.add(size);
      if (!Number.isFinite(result.score)) {
        continue;
      }
      if (!sizeScores.has(size)) {
        sizeScores.set(size, []);
      }
      sizeScores.get(size).push(result.score);

      const relation = mazeRelation(result.maze);
      if (!relation) {
        continue;
      }
      const cellKey = `${size}\u001e${relation}`;
      if (!cellScores.has(cellKey)) {
        cellScores.set(cellKey, []);
      }
      cellScores.get(cellKey).push(result.score);
    }

    const sizes = requestedSizes
      ? [...new Set(requestedSizes)].sort(compareSizes)
      : [...discoveredSizes].sort(compareSizes);
    const relations = RELATIONS.map((key) => ({
      key,
      label: _t(`relation.${key}`),
    }));
    return {
      sizes,
      relations,
      bySize: sizes.map((size) => {
        const scores = sizeScores.get(size) ?? [];
        return {
          size,
          meanScore: _meanScore(scores),
          sampleCount: scores.length,
        };
      }),
      heatmap: sizes.map((size) => ({
        size,
        cells: relations.map(({ key, label }) => {
          const scores = cellScores.get(`${size}\u001e${key}`) ?? [];
          return {
            relation: key,
            label,
            meanScore: _meanScore(scores),
            sampleCount: scores.length,
          };
        }),
      })),
    };
  }

  /** @description Combine one model's aggregate statistics for selected maze sizes */
  function combineModelStats(model, requestedSizes = null) {
    if (!model) {
      return null;
    }
    if (requestedSizes === null) {
      return model;
    }

    const selectedSizes = [...new Set(requestedSizes)];
    const selectedStats = selectedSizes
      .map((size) => model.by_maze_size?.[size])
      .filter(Boolean);
    const combined = {
      expected_count: 0,
      processed_count: 0,
      api_success_count: 0,
      api_failure_count: 0,
      graded_count: 0,
      provisional_mean_score: null,
      official_mean_score: null,
      token_usage: {
        totals: Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0])),
        missing_counts: Object.fromEntries(
          TOKEN_FIELDS.map((field) => [field, 0]),
        ),
      },
    };
    let scoreTotal = 0;

    for (const stats of selectedStats) {
      for (const field of [
        "expected_count",
        "processed_count",
        "api_success_count",
        "api_failure_count",
        "graded_count",
      ]) {
        combined[field] += Number(stats[field]) || 0;
      }
      const gradedCount = Number(stats.graded_count) || 0;
      if (Number.isFinite(stats.provisional_mean_score)) {
        scoreTotal += stats.provisional_mean_score * gradedCount;
      }
      for (const field of TOKEN_FIELDS) {
        combined.token_usage.totals[field] += (
          Number(stats.token_usage?.totals?.[field]) || 0
        );
        combined.token_usage.missing_counts[field] += (
          Number(stats.token_usage?.missing_counts?.[field]) || 0
        );
      }
    }

    if (combined.graded_count > 0) {
      combined.provisional_mean_score = scoreTotal / combined.graded_count;
    }
    if (
      combined.expected_count > 0
      && combined.graded_count === combined.expected_count
    ) {
      combined.official_mean_score = combined.provisional_mean_score;
    }
    return combined;
  }

  /** @description Collect unique mazes in size and maze-number order */
  function getMazes(results, requestedSizes = null, additionalMazes = []) {
    const selectedSizes = requestedSizes === null
      ? null
      : new Set(requestedSizes);
    const mazes = new Map();
    for (const result of results ?? []) {
      const maze = result.maze;
      if (!maze?.maze_id || !maze.width || !maze.height) {
        continue;
      }
      const size = mazeSize(maze);
      if (selectedSizes && !selectedSizes.has(size)) {
        continue;
      }
      if (!mazes.has(maze.maze_id)) {
        mazes.set(maze.maze_id, maze);
      }
    }
    for (const maze of additionalMazes) {
      if (!maze?.maze_id || !maze.width || !maze.height) {
        continue;
      }
      const size = mazeSize(maze);
      if (selectedSizes && !selectedSizes.has(size)) {
        continue;
      }
      if (!mazes.has(maze.maze_id)) {
        mazes.set(maze.maze_id, maze);
      }
    }
    return [...mazes.values()].sort((first, second) => {
      const sizeOrder = compareSizes(mazeSize(first), mazeSize(second));
      if (sizeOrder !== 0) {
        return sizeOrder;
      }
      const firstNumber = Number(/_(\d+)$/.exec(first.maze_id)?.[1]);
      const secondNumber = Number(/_(\d+)$/.exec(second.maze_id)?.[1]);
      return (
        (Number.isFinite(firstNumber) ? firstNumber : Infinity)
        - (Number.isFinite(secondNumber) ? secondNumber : Infinity)
        || first.maze_id.localeCompare(second.maze_id)
      );
    });
  }

  /** @description Aggregate leaderboard charts for one selected maze-size range */
  function aggregateLeaderboardModels(
    payload,
    requestedSizes = null,
    humanResults = null,
    tier = 1,
  ) {
    let sizes = requestedSizes === null
      ? getSizes(payload)
      : [...new Set(requestedSizes)].sort(compareSizes);
    const humanRows = humanResults === null
      ? []
      : aggregateHumanBaselines(humanResults, tier, requestedSizes);
    if (requestedSizes === null && humanRows.length > 0) {
      sizes = [...new Set([
        ...sizes,
        ...humanRows.flatMap((row) => row.bySize.map(({ size }) => size)),
      ])]
        .sort(compareSizes);
    }
    const mazes = getMazes(
      payload.results,
      sizes,
      humanRows.flatMap((row) => row.mazes),
    );
    const resultIndex = new Map();
    for (const result of payload.results ?? []) {
      if (!result.maze?.maze_id) {
        continue;
      }
      resultIndex.set(
        `${modelKey(result)}\u001e${result.maze.maze_id}`,
        result,
      );
    }
    const models = (payload.models ?? []).map((model) => {
      const stats = combineModelStats(model, sizes);
      const state = aggregateState(stats);
      const analytics = aggregateModelScores(payload.results, model, sizes);
      const score = state === "complete"
        ? stats.official_mean_score
        : stats.provisional_mean_score;
      const scoresByMaze = Object.fromEntries(mazes.map((maze) => {
        const result = resultIndex.get(
          `${modelKey(model)}\u001e${maze.maze_id}`,
        );
        return [
          maze.maze_id,
          Number.isFinite(result?.score) ? result.score : null,
        ];
      }));
      return {
        model,
        stats,
        state,
        score,
        cost: calculateCost(stats?.token_usage, model.pricing),
        bySize: analytics.bySize,
        scoresByMaze,
      };
    });
    const modelByKey = new Map(models.map((entry) => (
      [modelKey(entry.model), entry]
    )));
    const entries = rankLeaderboardEntries(
      payload.models ?? [],
      (model) => modelByKey.get(modelKey(model)).stats,
      humanRows,
    ).map((entry) => {
      if (entry.type === "human") {
        return entry;
      }
      return {
        ...modelByKey.get(entry.key),
        type: "model",
        key: entry.key,
        rank: entry.rank,
        originalIndex: entry.originalIndex,
      };
    });
    return { sizes, mazes, models, humanRows, entries };
  }

  /** @description Calculate USD cost without double-counting reasoning tokens */
  function calculateCost(tokenUsage, pricing) {
    const inputRate = pricing?.input_per_million;
    const outputRate = pricing?.output_per_million;
    const totals = tokenUsage?.totals ?? tokenUsage;
    const missing = tokenUsage?.missing_counts ?? {};
    if (
      !Number.isFinite(inputRate)
      || !Number.isFinite(outputRate)
      || !Number.isFinite(totals?.input_tokens)
      || !Number.isFinite(totals?.output_tokens)
      || Number(missing.input_tokens) > 0
      || Number(missing.output_tokens) > 0
    ) {
      return null;
    }
    return (
      totals.input_tokens * inputRate
      + totals.output_tokens * outputRate
    ) / 1_000_000;
  }

  /** @description Format a benchmark score */
  function formatScore(value) {
    return Number.isFinite(value) ? value.toFixed(2) : "—";
  }

  /** @description Format an integer token count */
  function formatTokens(value) {
    return Number.isFinite(value)
      ? new Intl.NumberFormat(
        i18n?.getLocale() === "ko" ? "ko-KR" : "en-US",
        { maximumFractionDigits: 0 },
      ).format(value)
      : "—";
  }

  /** @description Format a USD amount with extra precision for small totals */
  function formatCost(value) {
    if (!Number.isFinite(value)) {
      return "—";
    }
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: value < 1 ? 4 : 2,
    }).format(value);
  }

  /** @description Convert a canonical maze size to a display label */
  function formatSize(size) {
    return size.replace("x", " × ");
  }

  /** @description 사람의 미로별 백분위, 플레이 수, 중앙값 분석 집계 */
  function aggregateHumanDetail(payload, tier = 1, requestedSizes = null) {
    const tierId = Number(tier) === 2 ? 2 : 1;
    const tierMazes = getMazes(
      [],
      null,
      payload.tiers[String(tierId)].mazes,
    );
    const selectedSizes = requestedSizes === null
      ? null
      : new Set(requestedSizes);
    const mazes = selectedSizes === null
      ? tierMazes
      : tierMazes.filter((maze) => selectedSizes.has(mazeSize(maze)));
    const attemptedMazes = mazes.filter((maze) => maze.attempt_count > 0);
    const medianMazes = attemptedMazes.filter(
      (maze) => Number.isFinite(maze.median_score),
    );
    const medianScore = _meanScore(
      medianMazes.map((maze) => maze.median_score),
    );
    const stats = {
      expected_count: mazes.length,
      processed_count: medianMazes.length,
      official_mean_score: (
        mazes.length > 0 && medianMazes.length === mazes.length
      )
        ? medianScore
        : null,
      provisional_mean_score: medianScore,
    };
    const state = aggregateState(stats);
    const summary = {
      p95Score: _meanScore(
        attemptedMazes
          .filter((maze) => Number.isFinite(maze.p95_score))
          .map((maze) => maze.p95_score),
      ),
      medianScore,
      p05Score: _meanScore(
        attemptedMazes
          .filter((maze) => Number.isFinite(maze.p05_score))
          .map((maze) => maze.p05_score),
      ),
      playCount: mazes.reduce((total, maze) => total + maze.attempt_count, 0),
    };
    const sizes = getTierConfig(tierId).sizes;
    const relations = RELATIONS.map((key) => ({
      key,
      label: _t(`relation.${key}`),
    }));
    const bySize = sizes.map((size) => {
      const sizeMazes = tierMazes.filter(
        (maze) => mazeSize(maze) === size && maze.attempt_count > 0,
      );
      const scoredMazes = sizeMazes.filter(
        (maze) => Number.isFinite(maze.median_score),
      );
      return {
        size,
        meanScore: _meanScore(scoredMazes.map((maze) => maze.median_score)),
        sampleCount: scoredMazes.length,
      };
    });
    const heatmap = sizes.map((size) => ({
      size,
      cells: relations.map(({ key, label }) => {
        const scoredMazes = tierMazes.filter((maze) => (
          mazeSize(maze) === size
          && maze.attempt_count > 0
          && mazeRelation(maze) === key
          && Number.isFinite(maze.median_score)
        ));
        return {
          relation: key,
          label,
          meanScore: _meanScore(scoredMazes.map((maze) => maze.median_score)),
          sampleCount: scoredMazes.length,
        };
      }),
    }));

    return {
      mazes,
      stats,
      state,
      score: state === "complete"
        ? stats.official_mean_score
        : stats.provisional_mean_score,
      summary,
      sizes,
      relations,
      bySize,
      heatmap,
    };
  }

  /** @description 선택한 티어의 인간 미로 중앙값과 상위 5% 점수 집계 */
  function aggregateHumanBaselines(payload, tier = 1, requestedSizes = null) {
    const tierResults = payload.tiers[String(Number(tier) === 2 ? 2 : 1)];
    const selectedSizes = requestedSizes === null
      ? null
      : new Set(requestedSizes);
    const mazes = tierResults.mazes.filter((maze) => (
      selectedSizes === null || selectedSizes.has(mazeSize(maze))
    ));
    const sizes = requestedSizes === null
      ? [...new Set(mazes.map(mazeSize))].sort(compareSizes)
      : [...new Set(requestedSizes)].sort(compareSizes);
    return HUMAN_SCORE_FIELDS.map((metric) => {
      const scoresByMaze = Object.fromEntries(mazes.map((maze) => (
        [
          maze.maze_id,
          Number.isFinite(maze[metric.scoreField])
            ? maze[metric.scoreField]
            : null,
        ]
      )));
      const scoredMazes = mazes.filter((maze) => (
        Number.isFinite(maze[metric.scoreField])
      ));
      const provisionalMeanScore = _meanScore(
        scoredMazes.map((maze) => maze[metric.scoreField]),
      );
      const stats = {
        expected_count: mazes.length,
        processed_count: scoredMazes.length,
        official_mean_score: (
          mazes.length > 0 && scoredMazes.length === mazes.length
        )
          ? provisionalMeanScore
          : null,
        provisional_mean_score: provisionalMeanScore,
      };
      const state = aggregateState(stats);
      const bySize = sizes.map((size) => ({
        size,
        meanScore: _meanScore(
          scoredMazes
            .filter((maze) => mazeSize(maze) === size)
            .map((maze) => maze[metric.scoreField]),
        ),
      }));
      return {
        id: metric.id,
        label: _t(metric.labelKey),
        iconPath: "assets/developers/human.svg",
        color: metric.color,
        stats,
        state,
        score: state === "complete"
          ? stats.official_mean_score
          : stats.provisional_mean_score,
        cost: null,
        bySize,
        scoresByMaze,
        mazes,
      };
    });
  }

  /** @description 벤치마크 티어의 공개 설정 반환 */
  function getTierConfig(tier = 1) {
    return TIER_CONFIG[Number(tier) === 2 ? 2 : 1];
  }

  /** @description Return a readable public maze name */
  function mazeDisplayName(maze, fallbackIndex = 0) {
    const match = /^maze_(?:t2_)?\d+x\d+_(adjacent|opposite|same)_(\d+)$/i.exec(
      maze?.maze_id ?? "",
    );
    if (match) {
      return _t("common.mazeNamed", {
        number: Number(match[2]),
        relation: _t(`relation.${match[1].toLowerCase()}`),
      });
    }
    return _t("common.mazeFallback", { number: fallbackIndex + 1 });
  }

  /** @description Create a URL while omitting empty query parameters */
  function buildUrl(path, parameters) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== null && value !== undefined && value !== "") {
        query.set(key, String(value));
      }
    }
    const suffix = query.toString();
    return suffix ? `${path}?${suffix}` : path;
  }

  /** @description 선택한 벤치마크 티어의 공개 결과를 불러옴 */
  async function loadBenchmarkResults(tier = 1) {
    const config = getTierConfig(tier);
    const response = await fetch(config.resultsFile, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (!Array.isArray(payload.models) || !Array.isArray(payload.results)) {
      throw _error("common.modelsResultsMissing");
    }
    return payload;
  }

  /** @description 별도 집계용 인간 리더보드 데이터 로드 */
  async function loadHumanResults() {
    const response = await fetch(HUMAN_RESULTS_FILE, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  }

  const api = {
    aggregateLeaderboardModels,
    aggregateHumanBaselines,
    aggregateHumanDetail,
    aggregateModelScores,
    aggregateState,
    buildUrl,
    calculateCost,
    combineModelStats,
    compareSizes,
    developerColor,
    displayModelName,
    formatCost,
    formatScore,
    formatSize,
    formatTokens,
    getMazes,
    getSizes,
    getTierConfig,
    loadBenchmarkResults,
    loadHumanResults,
    mazeDisplayName,
    mazeRelation,
    mazeSize,
    modelDeveloper,
    modelKey,
    rankModels,
    rankModelDetailEntries,
    rankLeaderboardEntries,
    selectDefaultEntries,
    selectDefaultModels,
    sortRankedEntries,
    statsForModel,
  };

  globalScope.MazeBenchmarkData = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
}(globalThis));
