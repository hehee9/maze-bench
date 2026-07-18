/**
 * @file public/model.js
 * @description Render model aggregates and per-maze benchmark details
 */

(function initializeModelDetail() {
  "use strict";

  const DEFAULT_SIDEBAR_WIDTH = 288;
  const MIN_SIDEBAR_WIDTH = 232;
  const MAX_SIDEBAR_WIDTH = 420;
  const SIDEBAR_STORAGE_KEY = "maze-bench-model-sidebar-width";
  const i18n = globalThis.MazeBenchI18n;
  const data = globalThis.MazeBenchmarkData;
  const elements = {
    modelTitle: document.querySelector("#modelTitle"),
    scoreValue: document.querySelector("#scoreValue"),
    costValue: document.querySelector("#costValue"),
    tokenPriceValue: document.querySelector("#tokenPriceValue"),
    sizeSelect: document.querySelector("#sizeSelect"),
    resultTitle: document.querySelector("#resultTitle"),
    resultBody: document.querySelector("#resultBody"),
    tableScroll: document.querySelector(".model-detail-content .table-scroll"),
    emptyState: document.querySelector("#emptyState"),
    messageBox: document.querySelector("#messageBox"),
    rankingSidebar: document.querySelector("#rankingSidebar"),
    rankingList: document.querySelector("#rankingList"),
    rankingToggle: document.querySelector("#rankingToggle"),
    rankingClose: document.querySelector("#rankingClose"),
    sidebarBackdrop: document.querySelector("#sidebarBackdrop"),
    rankingResizeHandle: document.querySelector("#rankingResizeHandle"),
    modelMainStage: document.querySelector("#modelMainStage"),
    sizeScoreChart: document.querySelector("#sizeScoreChart"),
    scoreHeatmap: document.querySelector("#scoreHeatmap"),
    exportModelSizesButton: document.querySelector("#exportModelSizesButton"),
    exportModelHeatmapButton: document.querySelector("#exportModelHeatmapButton"),
  };
  const state = {
    payload: null,
    size: "all",
    modelKey: null,
    mazes: [],
    resultIndex: new Map(),
    sidebarOpen: false,
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    sidebarResizing: false,
    loadError: null,
  };
  const sidebarMedia = window.matchMedia("(max-width: 900px)");

  /** @description Translate a model-detail string */
  function _t(key, parameters = {}) {
    return i18n.t(key, parameters);
  }

  /** @description Create an error that can be translated after a locale change */
  function _error(key, parameters = {}) {
    const error = new Error(_t(key, parameters));
    error.translationKey = key;
    error.translationParameters = parameters;
    return error;
  }

  /** @description Translate a stored error in the active locale */
  function _errorText(error) {
    if (error?.translationKey) {
      return _t(error.translationKey, error.translationParameters);
    }
    return error instanceof Error ? error.message : String(error);
  }

  /** @description Return the selected aggregate model */
  function _selectedModel() {
    return state.payload.models.find(
      (model) => data.modelKey(model) === state.modelKey,
    ) ?? null;
  }

  /** @description Return a total token value only when none are missing */
  function _totalTokens(tokenUsage) {
    if (
      !Number.isFinite(tokenUsage?.totals?.total_tokens)
      || Number(tokenUsage?.missing_counts?.total_tokens) > 0
    ) {
      return null;
    }
    return tokenUsage.totals.total_tokens;
  }

  /** @description Identify the public state of one model result */
  function _resultState(result) {
    if (!result) {
      return {
        label: state.payload.status === "running"
          ? _t("common.waiting")
          : _t("common.noResults"),
        className: "is-muted",
        replayable: false,
      };
    }
    if (result.status === "api_failure") {
      return {
        label: _t("common.apiFailure"),
        className: "is-danger",
        replayable: false,
      };
    }
    if (result.status !== "success") {
      return {
        label: _t("common.unavailable"),
        className: "is-danger",
        replayable: false,
      };
    }
    if (result.format_valid !== true || !String(result.output ?? "").trim()) {
      return {
        label: _t("common.formatError"),
        className: "is-danger",
        replayable: false,
      };
    }
    if (result.grading?.success) {
      return {
        label: _t("common.completed"),
        className: "is-success",
        replayable: true,
      };
    }
    if (result.grading?.death) {
      return {
        label: _t("common.collision"),
        className: "is-danger",
        replayable: true,
      };
    }
    return { label: _t("common.unreached"), className: "", replayable: true };
  }

  /** @description Update model and size query parameters */
  function _syncUrl() {
    const model = _selectedModel();
    const url = data.buildUrl("model.html", {
      model: model?.name,
      size: state.size === "all" ? null : state.size,
    });
    window.history.replaceState(null, "", url);
  }

  /** @description Create a status pill */
  function _createStatus(stateInfo) {
    const badge = document.createElement("span");
    badge.className = `state-pill ${stateInfo.className}`.trim();
    badge.textContent = stateInfo.label;
    return badge;
  }

  /** @description Return a readable model name */
  function _modelName(model) {
    return data.displayModelName(model);
  }

  /** @description Return the largest sidebar width that preserves usable main content */
  function _maximumSidebarWidth() {
    if (sidebarMedia.matches) {
      return MAX_SIDEBAR_WIDTH;
    }
    return Math.max(
      MIN_SIDEBAR_WIDTH,
      Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - 560),
    );
  }

  /** @description Apply and optionally persist the desktop sidebar width */
  function _setSidebarWidth(width, persist = false) {
    const maximum = _maximumSidebarWidth();
    const nextWidth = Math.min(maximum, Math.max(MIN_SIDEBAR_WIDTH, width));
    state.sidebarWidth = nextWidth;
    document.body.style.setProperty("--model-sidebar-width", `${nextWidth}px`);
    elements.rankingResizeHandle.setAttribute("aria-valuemax", String(maximum));
    elements.rankingResizeHandle.setAttribute("aria-valuenow", String(nextWidth));
    if (!persist) {
      return;
    }
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(nextWidth));
    } catch {
      // Width persistence is optional when browser storage is unavailable.
    }
  }

  /** @description Restore the last desktop sidebar width */
  function _restoreSidebarWidth() {
    let savedWidth = DEFAULT_SIDEBAR_WIDTH;
    try {
      const stored = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
      const storedValue = Number(stored);
      if (stored !== null && Number.isFinite(storedValue)) {
        savedWidth = storedValue;
      }
    } catch {
      // Keep the default width when browser storage is unavailable.
    }
    _setSidebarWidth(savedWidth);
  }

  /** @description Finish an active sidebar resize interaction */
  function _finishSidebarResize() {
    if (!state.sidebarResizing) {
      return;
    }
    state.sidebarResizing = false;
    document.body.classList.remove("is-resizing-sidebar");
    _setSidebarWidth(state.sidebarWidth, true);
  }

  /** @description Forward boundary wheel movement from the result table to the page */
  function _forwardBoundaryWheel(event) {
    if (event.deltaY === 0 || event.ctrlKey) {
      return;
    }
    const maximumScroll = (
      elements.tableScroll.scrollHeight - elements.tableScroll.clientHeight
    );
    const atTop = elements.tableScroll.scrollTop <= 1;
    const atBottom = elements.tableScroll.scrollTop >= maximumScroll - 1;
    const movesPastBoundary = (
      maximumScroll <= 1
      || (event.deltaY < 0 && atTop)
      || (event.deltaY > 0 && atBottom)
    );
    if (!movesPastBoundary) {
      return;
    }

    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? window.innerHeight
        : 1;
    event.preventDefault();
    window.scrollBy({ top: event.deltaY * unit });
  }

  /** @description Synchronize the mobile ranking drawer and its accessibility state */
  function _setSidebarOpen(open, returnFocus = false) {
    const shouldOpen = sidebarMedia.matches && open;
    state.sidebarOpen = shouldOpen;
    elements.rankingSidebar.classList.toggle("is-open", shouldOpen);
    elements.rankingToggle.setAttribute("aria-expanded", String(shouldOpen));
    elements.sidebarBackdrop.hidden = !shouldOpen;
    document.body.classList.toggle("is-sidebar-open", shouldOpen);

    if (sidebarMedia.matches) {
      elements.rankingSidebar.inert = !shouldOpen;
      elements.rankingSidebar.setAttribute("aria-hidden", String(!shouldOpen));
      elements.modelMainStage.inert = shouldOpen;
    } else {
      elements.rankingSidebar.inert = false;
      elements.rankingSidebar.removeAttribute("aria-hidden");
      elements.modelMainStage.inert = false;
    }

    if (shouldOpen) {
      elements.rankingClose.focus();
    } else if (returnFocus && sidebarMedia.matches) {
      elements.rankingToggle.focus();
    }
  }

  /** @description Apply the correct sidebar mode after a viewport change */
  function _syncSidebarMode() {
    _setSidebarWidth(state.sidebarWidth);
    _setSidebarOpen(false);
  }

  /** @description Render the overall model ranking sidebar */
  function _renderRanking() {
    const entries = data.rankModels(state.payload.models);
    const links = entries.map((entry) => {
      const modelName = _modelName(entry.model);
      const link = document.createElement("a");
      const isActive = data.modelKey(entry.model) === state.modelKey;
      link.className = `ranking-entry is-${entry.state}`;
      link.href = data.buildUrl("model.html", {
        model: entry.model.name ?? data.modelKey(entry.model),
        size: state.size === "all" ? null : state.size,
      });
      link.setAttribute(
        "aria-label",
        _t("model.rankingAria", {
          rank: entry.rank === null
            ? _t("model.rankMissing")
            : _t("model.rankLabel", { rank: entry.rank }),
          model: modelName,
          score: data.formatScore(entry.score),
        }),
      );
      link.classList.toggle("is-active", isActive);
      if (isActive) {
        link.setAttribute("aria-current", "page");
      }

      const rank = document.createElement("span");
      rank.className = "ranking-entry-rank";
      rank.textContent = entry.rank === null ? "—" : String(entry.rank);
      const name = document.createElement("span");
      name.className = "ranking-entry-name";
      name.textContent = modelName;
      name.title = modelName;
      const score = document.createElement("span");
      score.className = "ranking-entry-score";
      score.textContent = data.formatScore(entry.score);
      if (entry.state === "partial" && Number.isFinite(entry.score)) {
        score.title = _t("model.provisionalTitle");
      }
      link.append(rank, name, score);
      return link;
    });
    elements.rankingList.replaceChildren(...links);

    const activeLink = elements.rankingList.querySelector("[aria-current='page']");
    if (activeLink) {
      requestAnimationFrame(() => {
        activeLink.scrollIntoView({ block: "nearest" });
      });
    }
  }

  /** @description Render the model's average score by maze size */
  function _renderSizeChart(analytics) {
    const scores = analytics.bySize;
    const finiteScores = scores.filter(({ meanScore }) => Number.isFinite(meanScore));
    if (finiteScores.length === 0) {
      const empty = document.createElement("p");
      empty.className = "chart-empty";
      empty.textContent = _t("common.noScoreData");
      elements.sizeScoreChart.replaceChildren(empty);
      return;
    }

    const chart = document.createElement("div");
    chart.className = "score-bar-chart";
    chart.setAttribute("role", "img");
    chart.setAttribute(
      "aria-label",
      _t("model.sizeChartAria", {
        model: _modelName(_selectedModel()),
        values: scores.map(({ size, meanScore }) => (
          _t("model.sizeChartEntry", {
            size: data.formatSize(size),
            score: data.formatScore(meanScore),
          })
        )).join(", "),
      }),
    );
    const axis = document.createElement("div");
    axis.className = "score-bar-axis";
    for (const tick of [100, 75, 50, 25, 0]) {
      const tickLabel = document.createElement("span");
      tickLabel.textContent = String(tick);
      axis.append(tickLabel);
    }

    const bars = document.createElement("div");
    bars.className = "score-bars";
    const developerColor = data.developerColor(_selectedModel());
    for (const { size, meanScore } of scores) {
      const item = document.createElement("div");
      item.className = "score-bar-item";
      const track = document.createElement("div");
      track.className = "score-bar-track";
      const scale = document.createElement("div");
      scale.className = "score-bar-scale";
      if (Number.isFinite(meanScore)) {
        const bar = document.createElement("div");
        bar.className = "score-bar-fill developer-score-bar";
        bar.style.backgroundColor = developerColor;
        bar.style.setProperty(
          "--bar-score",
          String(Math.min(100, Math.max(0, meanScore))),
        );
        const value = document.createElement("span");
        value.className = "score-bar-value";
        value.textContent = data.formatScore(meanScore);
        bar.append(value);
        scale.append(bar);
      } else {
        const missing = document.createElement("span");
        missing.className = "score-bar-missing";
        missing.textContent = "—";
        scale.append(missing);
      }
      track.append(scale);
      const sizeLabel = document.createElement("span");
      sizeLabel.className = "score-bar-label";
      sizeLabel.textContent = data.formatSize(size);
      item.append(track, sizeLabel);
      bars.append(item);
    }
    chart.append(axis, bars);
    elements.sizeScoreChart.replaceChildren(chart);
  }

  /** @description Return heatmap colors for a score */
  function _heatmapColors(score) {
    if (globalThis.MazeBenchTheme.getTheme() === "dark") {
      const lightness = 23 + score * 0.38;
      return {
        background: `hsl(218 40% ${lightness}%)`,
        foreground: "#ffffff",
      };
    }
    const lightness = 96 - score * 0.52;
    return {
      background: `hsl(220 34% ${lightness}%)`,
      foreground: score >= 62 ? "#ffffff" : "#26324d",
    };
  }

  /** @description Render average scores by maze size and entrance relation */
  function _renderHeatmap(analytics) {
    const scroll = document.createElement("div");
    scroll.className = "heatmap-scroll";
    const grid = document.createElement("div");
    grid.className = "heatmap-grid";

    const corner = document.createElement("span");
    corner.setAttribute("aria-hidden", "true");
    grid.append(corner);
    for (const relation of analytics.relations) {
      const label = document.createElement("span");
      label.className = "heatmap-column-label";
      label.textContent = relation.label;
      grid.append(label);
    }

    for (const row of analytics.heatmap) {
      const sizeLabel = document.createElement("span");
      sizeLabel.className = "heatmap-row-label";
      sizeLabel.textContent = data.formatSize(row.size);
      grid.append(sizeLabel);
      for (const cellData of row.cells) {
        const cell = document.createElement("div");
        cell.className = "heatmap-cell";
        if (Number.isFinite(cellData.meanScore)) {
          const colors = _heatmapColors(cellData.meanScore);
          cell.style.backgroundColor = colors.background;
          cell.style.color = colors.foreground;
          cell.textContent = data.formatScore(cellData.meanScore);
          cell.setAttribute(
            "aria-label",
            _t("model.heatmapValue", {
              size: data.formatSize(row.size),
              relation: cellData.label,
              score: data.formatScore(cellData.meanScore),
              results: cellData.sampleCount === 1
                ? _t("common.oneResult")
                : _t("common.resultsCount", {
                  count: cellData.sampleCount,
                }),
            }),
          );
        } else {
          cell.classList.add("is-empty");
          cell.textContent = "—";
          cell.setAttribute(
            "aria-label",
            _t("model.heatmapMissing", {
              size: data.formatSize(row.size),
              relation: cellData.label,
            }),
          );
        }
        grid.append(cell);
      }
    }
    scroll.append(grid);

    const legend = document.createElement("div");
    legend.className = "heatmap-legend";
    const low = document.createElement("span");
    low.textContent = "0";
    const bar = document.createElement("span");
    bar.className = "heatmap-legend-bar";
    bar.setAttribute("aria-hidden", "true");
    const high = document.createElement("span");
    high.textContent = "100";
    legend.append(low, bar, high);
    elements.scoreHeatmap.replaceChildren(scroll, legend);
  }

  /** @description Render the selected model's full-size performance analytics */
  function _renderAnalytics(model) {
    const analytics = data.aggregateModelScores(
      state.payload.results,
      model,
      data.getSizes(state.payload),
    );
    _renderSizeChart(analytics);
    _renderHeatmap(analytics);
    const modelName = _modelName(model);
    elements.exportModelSizesButton.dataset.exportFilename = (
      `maze-bench-model-size-scores-${modelName}.png`
    );
    elements.exportModelHeatmapButton.dataset.exportFilename = (
      `maze-bench-model-structure-heatmap-${modelName}.png`
    );
  }

  /** @description Create one per-maze result row */
  function _createResultRow(maze, fallbackIndex, model) {
    const result = state.resultIndex.get(
      `${data.modelKey(model)}\u001e${maze.maze_id}`,
    ) ?? null;
    const resultState = _resultState(result);
    const usage = result?.token_usage;
    const row = document.createElement("tr");

    const mazeCell = document.createElement("td");
    mazeCell.dataset.label = _t("model.mazeName");
    const mazeName = document.createElement("span");
    mazeName.className = "maze-name";
    mazeName.textContent = data.mazeDisplayName(maze, fallbackIndex);
    mazeName.title = maze.maze_id;
    mazeName.setAttribute(
      "aria-label",
      _t("common.originalId", {
        label: mazeName.textContent,
        id: maze.maze_id,
      }),
    );
    mazeCell.append(mazeName);

    const sizeCell = document.createElement("td");
    sizeCell.dataset.label = _t("common.mazeSize");
    sizeCell.textContent = data.formatSize(data.mazeSize(maze));

    const statusCell = document.createElement("td");
    statusCell.dataset.label = _t("model.status");
    statusCell.append(_createStatus(resultState));

    const values = [
      [_t("common.score"), data.formatScore(result?.score)],
      [_t("common.cost"), data.formatCost(data.calculateCost(usage, model.pricing))],
      [_t("common.input"), data.formatTokens(usage?.input_tokens)],
      [_t("common.output"), data.formatTokens(usage?.output_tokens)],
      [_t("common.reasoning"), data.formatTokens(usage?.reasoning_tokens)],
      [_t("common.totalTokens"), data.formatTokens(usage?.total_tokens)],
    ];
    const metricCells = values.map(([label, value]) => {
      const cell = document.createElement("td");
      cell.dataset.label = label;
      cell.textContent = value;
      return cell;
    });

    const replayCell = document.createElement("td");
    replayCell.className = "replay-cell";
    replayCell.dataset.label = _t("common.replay");
    const replayLink = document.createElement("a");
    replayLink.className = "replay-link";
    const desktopLabel = document.createElement("span");
    desktopLabel.className = "replay-label-desktop";
    desktopLabel.textContent = _t("model.view");
    const mobileLabel = document.createElement("span");
    mobileLabel.className = "replay-label-mobile";
    mobileLabel.textContent = _t("model.viewReplay");
    replayLink.append(desktopLabel, mobileLabel);
    if (resultState.replayable) {
      replayLink.href = data.buildUrl("index.html", {
        size: data.mazeSize(maze),
        maze: maze.maze_id,
        model: model.name,
      });
      replayLink.setAttribute(
        "aria-label",
        _t("model.replayAria", {
          maze: data.mazeDisplayName(maze, fallbackIndex),
        }),
      );
    } else {
      replayLink.classList.add("is-disabled");
      replayLink.setAttribute("aria-disabled", "true");
      replayLink.removeAttribute("href");
    }
    replayCell.append(replayLink);

    row.append(mazeCell, sizeCell, statusCell, ...metricCells, replayCell);
    return row;
  }

  /** @description Render selected model summary and maze rows */
  function _render() {
    const model = _selectedModel();
    if (!model) {
      return;
    }
    const stats = data.statsForModel(model, state.size);
    const aggregateState = data.aggregateState(stats);
    const score = aggregateState === "complete"
      ? stats?.official_mean_score
      : stats?.provisional_mean_score;
    const modelName = _modelName(model);

    elements.modelTitle.textContent = _t("model.detailTitle", { model: modelName });
    document.title = _t("model.detailDocumentTitle", { model: modelName });
    elements.scoreValue.textContent = data.formatScore(score);
    elements.costValue.textContent = _t("model.costAndTokens", {
      cost: data.formatCost(data.calculateCost(stats?.token_usage, model.pricing)),
      tokens: data.formatTokens(_totalTokens(stats?.token_usage)),
    });
    elements.tokenPriceValue.textContent = _t("model.price", {
      input: data.formatCost(model.pricing?.input_per_million),
      output: data.formatCost(model.pricing?.output_per_million),
    });
    elements.sizeSelect.value = state.size;

    const filteredMazes = state.mazes.filter(
      (maze) => state.size === "all" || data.mazeSize(maze) === state.size,
    );
    elements.resultBody.replaceChildren(
      ...filteredMazes.map((maze, index) => _createResultRow(maze, index, model)),
    );
    elements.emptyState.hidden = filteredMazes.length > 0;
    elements.resultTitle.textContent = _t("model.resultsTitle", {
      model: modelName,
    });
    _renderRanking();
    _renderAnalytics(model);
    _syncUrl();
  }

  /** @description Index the maze union and every model result */
  function _buildCatalog() {
    const mazeMap = new Map();
    for (const result of state.payload.results) {
      const maze = result.maze;
      if (!maze?.maze_id) {
        continue;
      }
      mazeMap.set(maze.maze_id, {
        maze_id: maze.maze_id,
        width: maze.width,
        height: maze.height,
      });
      state.resultIndex.set(
        `${data.modelKey(result)}\u001e${maze.maze_id}`,
        result,
      );
    }
    state.mazes = [...mazeMap.values()].sort((first, second) => (
      data.compareSizes(data.mazeSize(first), data.mazeSize(second))
      || first.maze_id.localeCompare(
        second.maze_id,
        i18n.getLocale(),
        { numeric: true },
      )
    ));
  }

  /** @description Restore valid model and maze-size URL selections */
  function _restoreSelection() {
    const query = new URLSearchParams(window.location.search);
    const queryModel = query.get("model");
    const querySize = query.get("size");
    const sizes = data.getSizes(state.payload);

    const preferredModel = state.payload.models.find(
      (model) => model.name === queryModel || data.modelKey(model) === queryModel,
    ) ?? state.payload.models[0];
    state.modelKey = preferredModel ? data.modelKey(preferredModel) : null;

    state.size = sizes.includes(querySize) ? querySize : "all";
  }

  /** @description Populate the model-detail maze-size selector */
  function _populateSizeSelect() {
    const options = [
      { value: "all", label: _t("common.all") },
      ...data.getSizes(state.payload).map((size) => ({
        value: size,
        label: data.formatSize(size),
      })),
    ].map(({ value, label }) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    });
    elements.sizeSelect.replaceChildren(...options);
    elements.sizeSelect.value = state.size;
    elements.sizeSelect.disabled = false;
  }

  /** @description Load and render model details */
  async function _load() {
    try {
      state.payload = await data.loadBenchmarkResults();
      _buildCatalog();
      _restoreSelection();
      _populateSizeSelect();
      if (state.payload.models.length === 0) {
        throw _error("common.noDisplayModels");
      }
      _render();
    } catch (error) {
      state.loadError = error;
      elements.messageBox.hidden = false;
      elements.messageBox.textContent = _t("common.publicLoadFailure", {
        detail: _errorText(error),
      });
      elements.rankingList.replaceChildren();
      const message = document.createElement("p");
      message.className = "ranking-list-message";
      message.textContent = _t("model.rankingLoadFailure");
      elements.rankingList.append(message);
    }
  }

  if (!data) {
    elements.messageBox.hidden = false;
    elements.messageBox.textContent = _t("common.dataModuleFailure");
    return;
  }

  elements.rankingToggle.addEventListener("click", () => {
    _setSidebarOpen(true);
  });
  elements.rankingClose.addEventListener("click", () => {
    _setSidebarOpen(false, true);
  });
  elements.sidebarBackdrop.addEventListener("click", () => {
    _setSidebarOpen(false, true);
  });
  elements.sizeSelect.addEventListener("change", () => {
    state.size = elements.sizeSelect.value;
    _render();
  });
  elements.tableScroll.addEventListener("wheel", _forwardBoundaryWheel, {
    passive: false,
  });
  elements.rankingResizeHandle.addEventListener("pointerdown", (event) => {
    if (sidebarMedia.matches || event.button !== 0) {
      return;
    }
    state.sidebarResizing = true;
    document.body.classList.add("is-resizing-sidebar");
    elements.rankingResizeHandle.setPointerCapture(event.pointerId);
    _setSidebarWidth(event.clientX);
    event.preventDefault();
  });
  elements.rankingResizeHandle.addEventListener("pointermove", (event) => {
    if (!state.sidebarResizing) {
      return;
    }
    _setSidebarWidth(event.clientX);
  });
  elements.rankingResizeHandle.addEventListener("pointerup", (event) => {
    if (elements.rankingResizeHandle.hasPointerCapture(event.pointerId)) {
      elements.rankingResizeHandle.releasePointerCapture(event.pointerId);
    }
    _finishSidebarResize();
  });
  elements.rankingResizeHandle.addEventListener(
    "pointercancel",
    _finishSidebarResize,
  );
  elements.rankingResizeHandle.addEventListener(
    "lostpointercapture",
    _finishSidebarResize,
  );
  elements.rankingResizeHandle.addEventListener("keydown", (event) => {
    const widthByKey = {
      ArrowLeft: state.sidebarWidth - 16,
      ArrowRight: state.sidebarWidth + 16,
      Home: MIN_SIDEBAR_WIDTH,
      End: _maximumSidebarWidth(),
    };
    if (!(event.key in widthByKey)) {
      return;
    }
    event.preventDefault();
    _setSidebarWidth(widthByKey[event.key], true);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.sidebarOpen) {
      _setSidebarOpen(false, true);
    }
  });
  sidebarMedia.addEventListener("change", _syncSidebarMode);
  globalThis.addEventListener(i18n.LOCALE_EVENT, () => {
    if (state.payload) {
      _populateSizeSelect();
      _render();
      return;
    }
    if (state.loadError !== null) {
      elements.messageBox.textContent = _t("common.publicLoadFailure", {
        detail: _errorText(state.loadError),
      });
      const message = document.createElement("p");
      message.className = "ranking-list-message";
      message.textContent = _t("model.rankingLoadFailure");
      elements.rankingList.replaceChildren(message);
    }
  });
  globalThis.addEventListener(
    globalThis.MazeBenchTheme.THEME_EVENT,
    () => {
      const model = state.payload ? _selectedModel() : null;
      if (model) {
        _renderAnalytics(model);
      }
    },
  );
  _restoreSidebarWidth();
  _syncSidebarMode();
  void _load();
}());
