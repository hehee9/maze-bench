/**
 * @file public/leaderboard.js
 * @description Render the Maze Bench model leaderboard
 */

(function initializeLeaderboard() {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  const i18n = globalThis.MazeBenchI18n;
  const data = globalThis.MazeBenchmarkData;
  const elements = {
    sizeButtons: document.querySelector("#sizeButtons"),
    scopeNote: document.querySelector("#scopeNote"),
    rankingBody: document.querySelector("#rankingBody"),
    emptyState: document.querySelector("#emptyState"),
    messageBox: document.querySelector("#messageBox"),
    tableScroll: document.querySelector("#tableScroll"),
    modelSortButton: document.querySelector(".model-sort-button"),
    modelReasoningHelp: document.querySelector(".model-reasoning-help"),
    modelReasoningTooltip: document.querySelector("#modelReasoningTooltip"),
    scoreSortButton: document.querySelector(".score-sort-button"),
    scoreFormulaHelp: document.querySelector(".score-formula-help"),
    scoreFormulaTooltip: document.querySelector("#scoreFormulaTooltip"),
    sortHeaders: document.querySelectorAll("[data-sort-key]"),
    mobileSortKey: document.querySelector("#mobileSortKey"),
    mobileSortDirection: document.querySelector("#mobileSortDirection"),
    modelPickers: document.querySelectorAll("[data-model-picker]"),
    modelPickerPanels: document.querySelectorAll(".model-picker-panel"),
    selectedModelCounts: document.querySelectorAll(".selected-model-count"),
    multiModelChart: document.querySelector("#multiModelChart"),
    leaderboardHeatmap: document.querySelector("#leaderboardHeatmap"),
    costScatter: document.querySelector("#costScatter"),
    scatterScaleButtons: document.querySelectorAll("[data-scale]"),
  };
  const state = {
    payload: null,
    sizes: [],
    selectedSizes: new Set(),
    selectedModelKeys: new Set(),
    collapsedDeveloperKeys: null,
    analytics: null,
    scatterScale: "linear",
    sortKey: "rank",
    sortDirection: "ascending",
    loadError: null,
  };

  /** @description Translate a leaderboard string */
  function _t(key, parameters = {}) {
    return i18n.t(key, parameters);
  }

  /** @description Translate a stored error in the active locale */
  function _errorText(error) {
    if (error?.translationKey) {
      return _t(error.translationKey, error.translationParameters);
    }
    return error instanceof Error ? error.message : String(error);
  }

  /** @description Return whether the current selection represents every maze size */
  function _usesOverallStats() {
    return (
      state.selectedSizes.size === 0
      || state.selectedSizes.size === state.sizes.length
    );
  }

  /** @description Return maze sizes represented by the current filter */
  function _activeSizes() {
    if (_usesOverallStats()) {
      return [...state.sizes];
    }
    return state.sizes.filter((size) => state.selectedSizes.has(size));
  }

  /** @description Return a total token value only when the selected range is complete */
  function _totalTokens(tokenUsage) {
    if (
      !Number.isFinite(tokenUsage?.totals?.total_tokens)
      || Number(tokenUsage?.missing_counts?.total_tokens) > 0
    ) {
      return null;
    }
    return tokenUsage.totals.total_tokens;
  }

  /** @description Combine aggregate statistics for the selected maze sizes */
  function _selectedStats(model) {
    if (_usesOverallStats()) {
      return model;
    }
    return data.combineModelStats(model, _activeSizes());
  }

  /** @description Return the single selected size for compatible detail links */
  function _singleSelectedSize() {
    if (_usesOverallStats() || state.selectedSizes.size !== 1) {
      return null;
    }
    return [...state.selectedSizes][0];
  }

  /** @description Update the current query without adding browser history */
  function _syncUrl() {
    const query = new URLSearchParams();
    if (state.selectedSizes.size === 0) {
      query.append("size", "none");
    } else if (state.selectedSizes.size < state.sizes.length) {
      for (const size of state.sizes) {
        if (state.selectedSizes.has(size)) {
          query.append("size", size);
        }
      }
    }
    const suffix = query.toString();
    window.history.replaceState(
      null,
      "",
      suffix ? `leaderboard.html?${suffix}` : "leaderboard.html",
    );
  }

  /** @description Synchronize desktop and mobile ranking sort controls */
  function _syncSortControls() {
    for (const heading of elements.sortHeaders) {
      const active = heading.dataset.sortKey === state.sortKey;
      const direction = active ? state.sortDirection : "none";
      heading.setAttribute("aria-sort", direction);
      heading.querySelector(".sort-indicator").textContent = active
        ? state.sortDirection === "ascending" ? "↑" : "↓"
        : "↕";
    }
    elements.mobileSortKey.value = state.sortKey;
    const nextDirection = state.sortDirection === "ascending"
      ? _t("leaderboard.changeDescending")
      : _t("leaderboard.changeAscending");
    elements.mobileSortDirection.textContent = state.sortDirection === "ascending"
      ? "↑"
      : "↓";
    elements.mobileSortDirection.setAttribute(
      "aria-label",
      nextDirection,
    );
    elements.mobileSortDirection.title = nextDirection;
  }

  /** @description Position a table-header tooltip above its help icon */
  function _positionHeaderTooltip(help, button, tooltip) {
    const anchorBounds = help.getBoundingClientRect();
    const headingBounds = button.getBoundingClientRect();
    const tooltipBounds = tooltip.getBoundingClientRect();
    const viewportMargin = 16;
    const gap = 8;
    const left = Math.min(
      globalThis.innerWidth - tooltipBounds.width - viewportMargin,
      Math.max(
        viewportMargin,
        anchorBounds.left + (anchorBounds.width - tooltipBounds.width) / 2,
      ),
    );
    const top = Math.max(
      viewportMargin,
      headingBounds.top - tooltipBounds.height - gap,
    );
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  /** @description Show a table-header tooltip at its current anchor position */
  function _showHeaderTooltip(help, button, tooltip) {
    _positionHeaderTooltip(help, button, tooltip);
    tooltip.classList.add("is-visible");
  }

  /** @description Hide a table-header tooltip when its icon and button are inactive */
  function _hideHeaderTooltip(help, button, tooltip) {
    const keyboardFocused = (
      document.activeElement === button
      && button.matches(":focus-visible")
    );
    if (!help.matches(":hover") && !keyboardFocused) {
      tooltip.classList.remove("is-visible");
    }
  }

  /** @description Bind pointer and keyboard behavior for a table-header tooltip */
  function _bindHeaderTooltip(help, button, tooltip) {
    help.addEventListener("pointerenter", () => {
      _showHeaderTooltip(help, button, tooltip);
    });
    help.addEventListener("pointerleave", () => {
      _hideHeaderTooltip(help, button, tooltip);
    });
    button.addEventListener("focus", () => {
      if (button.matches(":focus-visible")) {
        _showHeaderTooltip(help, button, tooltip);
      }
    });
    button.addEventListener("blur", () => {
      _hideHeaderTooltip(help, button, tooltip);
    });
  }

  /** @description Select a new sort key or toggle the active direction */
  function _changeSort(sortKey) {
    if (sortKey === state.sortKey) {
      state.sortDirection = state.sortDirection === "ascending"
        ? "descending"
        : "ascending";
    } else {
      state.sortKey = sortKey;
      state.sortDirection = "descending";
    }
    _renderRanking();
  }

  /** @description Create one ranked model row */
  function _createRow(entry) {
    const row = document.createElement("tr");
    row.className = `is-${entry.state}`;

    const rankCell = document.createElement("td");
    rankCell.className = "rank-cell";
    rankCell.dataset.label = _t("common.rank");
    rankCell.textContent = entry.rank === null ? "—" : String(entry.rank);

    const modelCell = document.createElement("td");
    modelCell.className = "model-cell";
    modelCell.dataset.label = _t("common.modelName");
    const mobileRank = document.createElement("span");
    mobileRank.className = "mobile-rank";
    mobileRank.textContent = entry.rank === null ? "—" : `${entry.rank}.`;
    const modelLink = document.createElement("a");
    const modelName = _modelName(entry.model);
    const developer = data.modelDeveloper(entry.model);
    modelLink.className = "model-link";
    modelLink.href = data.buildUrl("model.html", {
      model: entry.model.name,
      size: _singleSelectedSize(),
    });
    modelLink.setAttribute("aria-label", `${developer.label} ${modelName}`);
    const developerIcon = document.createElement("img");
    developerIcon.className = "developer-icon";
    developerIcon.src = developer.iconPath;
    developerIcon.alt = "";
    developerIcon.setAttribute("aria-hidden", "true");
    const modelNameText = document.createElement("span");
    modelNameText.textContent = modelName;
    modelLink.append(developerIcon, modelNameText);
    modelCell.append(mobileRank, modelLink);
    if (entry.state === "partial") {
      const badge = document.createElement("span");
      badge.className = "state-pill";
      badge.textContent = `${entry.processed}/${entry.expected}`;
      badge.title = _t("leaderboard.processedTitle");
      modelCell.append(badge);
    } else if (entry.state === "empty") {
      const badge = document.createElement("span");
      badge.className = "state-pill is-muted";
      badge.textContent = _t("common.waiting");
      modelCell.append(badge);
    }

    const scoreCell = document.createElement("td");
    scoreCell.className = "score-cell";
    scoreCell.dataset.label = _t("common.score");
    const score = entry.state === "complete"
      ? entry.stats.official_mean_score
      : entry.stats?.provisional_mean_score;
    const scoreStrong = document.createElement("strong");
    scoreStrong.textContent = Number.isFinite(score)
      ? `${data.formatScore(score)}%`
      : data.formatScore(score);
    scoreCell.append(scoreStrong);
    if (entry.state === "partial") {
      const meta = document.createElement("span");
      meta.className = "row-meta";
      meta.textContent = _t("leaderboard.provisionalScore");
      scoreCell.append(meta);
    }

    const costCell = document.createElement("td");
    costCell.dataset.label = _t("common.cost");
    costCell.textContent = data.formatCost(
      data.calculateCost(entry.stats?.token_usage, entry.model.pricing),
    );

    const tokenCell = document.createElement("td");
    tokenCell.dataset.label = _t("common.totalTokens");
    tokenCell.textContent = data.formatTokens(_totalTokens(entry.stats?.token_usage));

    row.append(rankCell, modelCell, scoreCell, costCell, tokenCell);
    return row;
  }

  /** @description Describe the selected maze-size range */
  function _selectedSizeLabel() {
    if (_usesOverallStats()) {
      return _t("leaderboard.allMazes");
    }
    if (state.selectedSizes.size === 1) {
      return _t("leaderboard.oneSizeMazes", {
        size: data.formatSize([...state.selectedSizes][0]),
      });
    }
    return _t("leaderboard.multipleSizeMazes", {
      count: state.selectedSizes.size,
    });
  }

  /** @description Return a readable model name */
  function _modelName(model) {
    return data.displayModelName(model);
  }

  /** @description Return the stable public index for one model */
  function _modelIndex(model) {
    return state.payload.models.findIndex(
      (candidate) => data.modelKey(candidate) === data.modelKey(model),
    );
  }

  /** @description Return the shared color for one model developer */
  function _modelColor(model) {
    return data.developerColor(model);
  }

  /** @description Create an SVG element with attributes and optional text */
  function _svgElement(tagName, attributes = {}, text = null) {
    const element = document.createElementNS(SVG_NS, tagName);
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, String(value));
    }
    if (text !== null) {
      element.textContent = text;
    }
    return element;
  }

  /** @description Order chart aggregates with the active official ranking rules */
  function _orderedAnalyticsModels(analytics) {
    const byKey = new Map(analytics.models.map((entry) => (
      [data.modelKey(entry.model), entry]
    )));
    return data.rankModels(
      state.payload.models,
      (model) => byKey.get(data.modelKey(model))?.stats,
    ).map((ranked) => byKey.get(data.modelKey(ranked.model))).filter(Boolean);
  }

  /** @description Add one delegated tooltip to a rendered chart */
  function _bindChartTooltip(container) {
    const tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip";
    tooltip.hidden = true;
    container.append(tooltip);

    const position = (clientX, clientY) => {
      const bounds = container.getBoundingClientRect();
      const maximumLeft = Math.max(8, bounds.width - tooltip.offsetWidth - 8);
      tooltip.style.left = `${Math.min(maximumLeft, Math.max(8, clientX - bounds.left + 12))}px`;
      tooltip.style.top = `${Math.max(8, clientY - bounds.top - tooltip.offsetHeight - 10)}px`;
    };
    const show = (target, clientX, clientY) => {
      tooltip.textContent = target.dataset.chartTooltip;
      tooltip.hidden = false;
      position(clientX, clientY);
    };
    const setModelHighlight = (modelIndex) => {
      for (const element of document.querySelectorAll(
        ".leaderboard-analytics [data-model-highlight]",
      )) {
        element.classList.toggle(
          "is-model-dimmed",
          element.dataset.modelHighlight !== modelIndex,
        );
      }
    };
    const clearModelHighlight = () => {
      for (const element of document.querySelectorAll(
        ".leaderboard-analytics .is-model-dimmed",
      )) {
        element.classList.remove("is-model-dimmed");
      }
    };

    container.onpointerover = (event) => {
      const target = event.target.closest?.("[data-chart-tooltip]");
      if (target) {
        show(target, event.clientX, event.clientY);
      }
      const modelTarget = event.target.closest?.("[data-model-highlight]");
      if (modelTarget) {
        setModelHighlight(modelTarget.dataset.modelHighlight);
      }
    };
    container.onpointermove = (event) => {
      if (!tooltip.hidden) {
        position(event.clientX, event.clientY);
      }
    };
    container.onpointerdown = (event) => {
      const target = event.target.closest?.("[data-chart-tooltip]");
      if (target) {
        show(target, event.clientX, event.clientY);
      }
    };
    container.onpointerout = (event) => {
      if (event.target.closest?.("[data-chart-tooltip]")) {
        tooltip.hidden = true;
      }
      const modelTarget = event.target.closest?.("[data-model-highlight]");
      const nextTarget = event.relatedTarget?.closest?.("[data-model-highlight]");
      if (
        modelTarget
        && modelTarget.dataset.modelHighlight
          !== nextTarget?.dataset.modelHighlight
      ) {
        clearModelHighlight();
      }
    };
    container.onfocusin = (event) => {
      const target = event.target.closest?.("[data-chart-tooltip]");
      if (!target) {
        return;
      }
      const bounds = target.getBoundingClientRect();
      show(target, bounds.left + bounds.width / 2, bounds.top);
      const modelTarget = event.target.closest?.("[data-model-highlight]");
      if (modelTarget) {
        setModelHighlight(modelTarget.dataset.modelHighlight);
      }
    };
    container.onfocusout = () => {
      tooltip.hidden = true;
      clearModelHighlight();
    };
  }

  /** @description Select default chart models by overall rank and developer */
  function _initializeChartModels() {
    state.selectedModelKeys = new Set(
      data.selectDefaultModels(state.payload.models).map((model) => (
        data.modelKey(model)
      )),
    );
  }

  /** @description Return the pressed state for a bulk model selection */
  function _bulkSelectionState(keys) {
    const selectedCount = keys.filter((key) => (
      state.selectedModelKeys.has(key)
    )).length;
    if (selectedCount === 0) {
      return "false";
    }
    return selectedCount === keys.length ? "true" : "mixed";
  }

  /** @description Render all charts affected by the shared model selection */
  function _renderSelectedModelCharts() {
    _renderMultiModelChart(state.analytics);
    _renderLeaderboardHeatmap(state.analytics);
    _renderCostScatter(state.analytics);
  }

  /** @description Toggle every model represented by one bulk control */
  function _toggleBulkModels(button) {
    const keys = button.modelKeys ?? [];
    const shouldSelect = _bulkSelectionState(keys) !== "true";
    for (const key of keys) {
      if (shouldSelect) {
        state.selectedModelKeys.add(key);
      } else {
        state.selectedModelKeys.delete(key);
      }
    }
    _syncModelPickerControls();
    _renderSelectedModelCharts();
  }

  /** @description Update one bulk control label and accessibility state */
  function _syncBulkButton(button) {
    const stateValue = _bulkSelectionState(button.modelKeys ?? []);
    const shouldSelect = stateValue !== "true";
    const developer = button.dataset.developerLabel;
    button.setAttribute("aria-pressed", stateValue);
    if (developer) {
      const actionLabel = _t(
        shouldSelect
          ? "selection.selectDeveloper"
          : "selection.clearDeveloper",
        { developer },
      );
      button.textContent = "";
      button.setAttribute("aria-label", actionLabel);
      button.title = actionLabel;
      return;
    }
    button.textContent = shouldSelect
      ? _t("selection.selectAll")
      : _t("selection.clearAll");
  }

  /** @description Create an accessible bulk model selection button */
  function _createBulkButton(keys, developer = null) {
    const button = document.createElement("button");
    button.type = "button";
    button.modelKeys = keys;
    if (developer) {
      button.className = "model-picker-group-toggle";
      button.dataset.developerLabel = developer.label;
    }
    button.addEventListener("click", () => _toggleBulkModels(button));
    _syncBulkButton(button);
    return button;
  }

  /** @description Synchronize every model picker with the shared selection */
  function _syncModelPickerControls() {
    for (const count of elements.selectedModelCounts) {
      count.textContent = String(state.selectedModelKeys.size);
    }
    for (const checkbox of document.querySelectorAll(
      ".model-picker-option input[type='checkbox']",
    )) {
      const model = state.payload.models[Number(checkbox.dataset.modelIndex)];
      checkbox.checked = state.selectedModelKeys.has(data.modelKey(model));
    }
    for (const button of document.querySelectorAll(
      ".model-picker-master button, .model-picker-group-toggle",
    )) {
      _syncBulkButton(button);
    }
  }

  /** @description Synchronize one developer disclosure with shared collapsed state */
  function _syncDeveloperDisclosure(button) {
    const collapsed = state.collapsedDeveloperKeys.has(button.dataset.developerKey);
    const options = button
      .closest(".model-picker-group")
      .querySelector(".model-picker-options");
    options.hidden = collapsed;
    button.setAttribute("aria-expanded", String(!collapsed));
    const actionLabel = _t(
      collapsed
        ? "selection.expandDeveloper"
        : "selection.collapseDeveloper",
      { developer: button.dataset.developerLabel },
    );
    button.setAttribute("aria-label", actionLabel);
    button.title = actionLabel;
  }

  /** @description Synchronize developer disclosures across all model pickers */
  function _syncDeveloperDisclosures() {
    for (const button of document.querySelectorAll(".model-picker-disclosure")) {
      _syncDeveloperDisclosure(button);
    }
  }

  /** @description Render the manual model selection panel */
  function _renderModelPicker() {
    const groups = new Map();
    for (const entry of data.rankModels(state.payload.models)) {
      const developer = data.modelDeveloper(entry.model);
      if (!groups.has(developer.key)) {
        groups.set(developer.key, { developer, entries: [] });
      }
      groups.get(developer.key).entries.push(entry);
    }
    const sortedGroups = [...groups.values()].sort((left, right) => (
      right.entries.length - left.entries.length
      || left.developer.label.localeCompare(
        right.developer.label,
        i18n.getLocale(),
        { sensitivity: "base" },
      )
    ));

    for (const [panelIndex, panel] of [...elements.modelPickerPanels].entries()) {
      const master = document.createElement("div");
      master.className = "model-picker-master";
      const masterLabel = document.createElement("strong");
      masterLabel.textContent = _t("selection.allModels");
      master.append(
        masterLabel,
        _createBulkButton(
          state.payload.models.map((model) => data.modelKey(model)),
        ),
      );
      const groupList = document.createElement("div");
      groupList.className = "model-picker-groups";
      if (state.collapsedDeveloperKeys === null) {
        state.collapsedDeveloperKeys = new Set(
          sortedGroups
            .filter(({ entries }) => entries.every(
              (entry) => !state.selectedModelKeys.has(data.modelKey(entry.model)),
            ))
            .map(({ developer }) => developer.key),
        );
      }
      let groupIndex = 0;
      for (const { developer, entries } of sortedGroups) {
        const group = document.createElement("section");
        group.className = "model-picker-group";
        const labelId = `modelPickerDeveloper${panelIndex}-${groupIndex}`;
        const optionsId = `${labelId}Options`;
        group.setAttribute("role", "group");
        group.setAttribute("aria-labelledby", labelId);
        const heading = document.createElement("div");
        heading.className = "model-picker-group-heading";
        const disclosure = document.createElement("button");
        disclosure.type = "button";
        disclosure.className = "model-picker-disclosure";
        disclosure.dataset.developerKey = developer.key;
        disclosure.dataset.developerLabel = developer.label;
        disclosure.setAttribute("aria-controls", optionsId);
        const headingLabel = document.createElement("strong");
        headingLabel.id = labelId;
        headingLabel.textContent = developer.label;
        const count = document.createElement("span");
        count.className = "model-picker-group-count";
        count.textContent = `(${entries.length})`;
        const developerSwatch = document.createElement("span");
        developerSwatch.className = "model-picker-developer-swatch";
        developerSwatch.style.backgroundColor = developer.color;
        developerSwatch.setAttribute("aria-hidden", "true");
        heading.append(
          disclosure,
          _createBulkButton(
            entries.map((entry) => data.modelKey(entry.model)),
            developer,
          ),
          developerSwatch,
          headingLabel,
          count,
        );
        const options = document.createElement("div");
        options.id = optionsId;
        options.className = "model-picker-options";
        disclosure.addEventListener("click", () => {
          if (state.collapsedDeveloperKeys.has(developer.key)) {
            state.collapsedDeveloperKeys.delete(developer.key);
          } else {
            state.collapsedDeveloperKeys.add(developer.key);
          }
          _syncDeveloperDisclosures();
        });
        for (const entry of entries) {
          const key = data.modelKey(entry.model);
          const label = document.createElement("label");
          label.className = "model-picker-option";
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.dataset.modelIndex = String(
            state.payload.models.indexOf(entry.model),
          );
          checkbox.checked = state.selectedModelKeys.has(key);
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
              state.selectedModelKeys.add(key);
            } else {
              state.selectedModelKeys.delete(key);
            }
            _syncModelPickerControls();
            _renderSelectedModelCharts();
          });
          const name = document.createElement("span");
          name.textContent = _modelName(entry.model);
          name.title = name.textContent;
          label.append(checkbox, name);
          options.append(label);
        }
        group.append(heading, options);
        groupList.append(group);
        _syncDeveloperDisclosure(disclosure);
        groupIndex += 1;
      }
      panel.replaceChildren(master, groupList);
    }
    _syncModelPickerControls();
  }

  /** @description Render grouped score bars for selected models and maze sizes */
  function _renderMultiModelChart(analytics) {
    const models = _orderedAnalyticsModels(analytics).filter((entry) => (
      state.selectedModelKeys.has(data.modelKey(entry.model))
    ));
    if (models.length === 0 || analytics.sizes.length === 0) {
      const empty = document.createElement("p");
      empty.className = "chart-empty";
      empty.textContent = _t("common.noScoreData");
      elements.multiModelChart.replaceChildren(empty);
      return;
    }

    const height = 390;
    const margin = { top: 20, right: 18, bottom: 58, left: 48 };
    const groupWidth = Math.max(116, models.length * 15 + 28);
    const width = Math.max(
      760,
      margin.left + margin.right + analytics.sizes.length * groupWidth,
    );
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const svg = _svgElement("svg", {
      class: "multi-model-svg",
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
      role: "img",
      "aria-label": _t("leaderboard.chartBars"),
    });
    svg.style.minWidth = `${width}px`;
    const barElements = [];
    const sizeLabelElements = [];

    for (const tick of [0, 25, 50, 75, 100]) {
      const y = margin.top + plotHeight - (tick / 100) * plotHeight;
      svg.append(
        _svgElement("line", {
          x1: margin.left,
          x2: width - margin.right,
          y1: y,
          y2: y,
          class: "chart-grid-line",
        }),
        _svgElement("text", {
          x: margin.left - 9,
          y: y + 4,
          class: "chart-axis-tick",
          "text-anchor": "end",
        }, tick),
      );
    }

    const barGap = 2;
    const availableBarWidth = Math.max(
      8,
      Math.min(18, (groupWidth - 24) / models.length - barGap),
    );
    analytics.sizes.forEach((size, sizeIndex) => {
      const groupStart = margin.left + sizeIndex * groupWidth;
      const barsWidth = models.length * (availableBarWidth + barGap) - barGap;
      const barsStart = groupStart + (groupWidth - barsWidth) / 2;
      models.forEach((entry, modelIndex) => {
        const score = entry.bySize.find((item) => item.size === size)?.meanScore;
        if (!Number.isFinite(score)) {
          return;
        }
        const barHeight = Math.max(2, (Math.max(0, Math.min(100, score)) / 100) * plotHeight);
        const x = barsStart + modelIndex * (availableBarWidth + barGap);
        const y = margin.top + plotHeight - barHeight;
        const tooltip = (
          `${_modelName(entry.model)} · ${data.formatSize(size)} · `
          + _t("common.points", { score: data.formatScore(score) })
        );
        const rect = _svgElement("rect", {
          x,
          y,
          width: availableBarWidth,
          height: barHeight,
          rx: 3,
          class: "developer-mark",
          fill: _modelColor(entry.model),
          tabindex: 0,
          role: "img",
          "aria-label": tooltip,
          "data-chart-tooltip": tooltip,
          "data-model-highlight": _modelIndex(entry.model),
        });
        barElements.push({ element: rect, modelIndex, sizeIndex });
        svg.append(rect);
      });
      const sizeLabel = _svgElement("text", {
        x: groupStart + groupWidth / 2,
        y: height - 25,
        class: "chart-axis-label",
        "text-anchor": "middle",
      }, data.formatSize(size));
      sizeLabelElements.push(sizeLabel);
      svg.append(sizeLabel);
    });

    const usesCompactScreenLayout = models.length >= 10;
    const exportSvg = svg.cloneNode(true);
    const screenWidth = Math.max(
      320,
      Math.round(elements.multiModelChart.clientWidth || 760),
    );
    svg.setAttribute("viewBox", `0 0 ${screenWidth} ${height}`);
    svg.setAttribute("width", screenWidth);
    svg.style.minWidth = "0";

    if (usesCompactScreenLayout) {
      svg.classList.add("is-compact");

      const compactPlotWidth = screenWidth - margin.left - margin.right;
      const compactGroupWidth = (
        compactPlotWidth / analytics.sizes.length
      ) * 0.95;
      const compactGroupsOffset = (
        compactPlotWidth - compactGroupWidth * analytics.sizes.length
      ) / 2;
      const compactGroupPadding = Math.min(8, compactGroupWidth * 0.12);
      const compactGroupInnerWidth = compactGroupWidth - compactGroupPadding;
      const compactBarGap = Math.min(
        1,
        compactGroupInnerWidth / (models.length * 4),
      );
      const compactBarWidth = Math.min(
        13,
        Math.max(
          0.25,
          (
            compactGroupInnerWidth
            - compactBarGap * (models.length - 1)
          ) / models.length,
        ),
      );

      for (const line of svg.querySelectorAll(".chart-grid-line")) {
        line.setAttribute("x2", screenWidth - margin.right);
      }
      for (const { element, modelIndex, sizeIndex } of barElements) {
        const compactGroupStart = (
          margin.left
          + compactGroupsOffset
          + sizeIndex * compactGroupWidth
        );
        const compactBarsWidth = (
          models.length * (compactBarWidth + compactBarGap) - compactBarGap
        );
        const compactBarsStart = (
          compactGroupStart + (compactGroupWidth - compactBarsWidth) / 2
        );
        element.setAttribute(
          "x",
          compactBarsStart + modelIndex * (compactBarWidth + compactBarGap),
        );
        element.setAttribute("width", compactBarWidth);
        element.setAttribute("rx", Math.min(2, compactBarWidth / 3));
      }
      sizeLabelElements.forEach((label, sizeIndex) => {
        label.setAttribute(
          "x",
          (
            margin.left
            + compactGroupsOffset
            + sizeIndex * compactGroupWidth
            + compactGroupWidth / 2
          ),
        );
      });
    } else {
      const horizontalScale = screenWidth / width;
      for (const line of svg.querySelectorAll(".chart-grid-line")) {
        line.setAttribute(
          "x1",
          Number(line.getAttribute("x1")) * horizontalScale,
        );
        line.setAttribute(
          "x2",
          Number(line.getAttribute("x2")) * horizontalScale,
        );
      }
      for (const tick of svg.querySelectorAll(".chart-axis-tick")) {
        tick.setAttribute(
          "x",
          Number(tick.getAttribute("x")) * horizontalScale,
        );
      }
      for (const { element } of barElements) {
        element.setAttribute(
          "x",
          Number(element.getAttribute("x")) * horizontalScale,
        );
        element.setAttribute(
          "width",
          Number(element.getAttribute("width")) * horizontalScale,
        );
      }
      for (const label of sizeLabelElements) {
        label.setAttribute(
          "x",
          Number(label.getAttribute("x")) * horizontalScale,
        );
      }
    }

    const scroll = document.createElement("div");
    scroll.className = "chart-horizontal-scroll multi-model-screen-scroll";
    scroll.dataset.exportHide = "true";
    scroll.append(svg);
    const exportScroll = document.createElement("div");
    exportScroll.className = "chart-horizontal-scroll multi-model-export-scroll";
    exportScroll.dataset.exportShow = "true";
    exportScroll.style.display = "none";
    exportScroll.setAttribute("aria-hidden", "true");
    exportScroll.append(exportSvg);
    const legend = document.createElement("div");
    legend.className = "model-chart-legend";
    for (const entry of models) {
      const item = document.createElement("span");
      item.dataset.modelHighlight = String(_modelIndex(entry.model));
      const swatch = document.createElement("i");
      swatch.style.backgroundColor = _modelColor(entry.model);
      const name = document.createElement("span");
      name.textContent = _modelName(entry.model);
      item.append(swatch, name);
      legend.append(item);
    }
    elements.multiModelChart.replaceChildren(
      scroll,
      exportScroll,
      legend,
    );
    _bindChartTooltip(elements.multiModelChart);
  }

  /** @description Return a discrete score band for heatmap cells */
  function _scoreBand(score) {
    return Math.min(4, Math.max(0, Math.floor(score / 20)));
  }

  /** @description Render all model scores for each selected individual maze */
  function _renderLeaderboardHeatmap(analytics) {
    const models = _orderedAnalyticsModels(analytics).filter((entry) => (
      state.selectedModelKeys.has(data.modelKey(entry.model))
    ));
    if (analytics.mazes.length === 0 || models.length === 0) {
      const empty = document.createElement("p");
      empty.className = "chart-empty";
      empty.textContent = _t("common.noScoreData");
      elements.leaderboardHeatmap.replaceChildren(empty);
      return;
    }

    const scroll = document.createElement("div");
    scroll.className = "full-heatmap-scroll";
    const table = document.createElement("table");
    table.className = "full-heatmap-table";
    const head = document.createElement("thead");
    const sizeRow = document.createElement("tr");
    const modelHeading = document.createElement("th");
    modelHeading.className = "full-heatmap-model-heading";
    modelHeading.rowSpan = 2;
    modelHeading.scope = "col";
    modelHeading.textContent = _t("common.model");
    sizeRow.append(modelHeading);

    for (let index = 0; index < analytics.mazes.length;) {
      const size = data.mazeSize(analytics.mazes[index]);
      let count = 1;
      while (
        index + count < analytics.mazes.length
        && data.mazeSize(analytics.mazes[index + count]) === size
      ) {
        count += 1;
      }
      const sizeHeading = document.createElement("th");
      sizeHeading.colSpan = count;
      sizeHeading.scope = "colgroup";
      sizeHeading.textContent = data.formatSize(size);
      sizeRow.append(sizeHeading);
      index += count;
    }

    const mazeRow = document.createElement("tr");
    for (const maze of analytics.mazes) {
      const heading = document.createElement("th");
      const mazeName = data.mazeDisplayName(maze);
      const mazeNumber = Number(/_(\d+)$/.exec(maze.maze_id)?.[1]);
      heading.scope = "col";
      heading.textContent = Number.isFinite(mazeNumber) ? String(mazeNumber) : "—";
      heading.dataset.chartTooltip = (
        `${data.formatSize(data.mazeSize(maze))} · ${mazeName}`
      );
      heading.setAttribute("aria-label", heading.dataset.chartTooltip);
      heading.tabIndex = 0;
      mazeRow.append(heading);
    }
    head.append(sizeRow, mazeRow);

    const body = document.createElement("tbody");
    for (const entry of models) {
      const row = document.createElement("tr");
      row.dataset.modelHighlight = String(_modelIndex(entry.model));
      const modelHeadingCell = document.createElement("th");
      modelHeadingCell.className = "full-heatmap-model-cell";
      modelHeadingCell.scope = "row";
      const developerMark = document.createElement("i");
      developerMark.className = "developer-color-mark";
      developerMark.style.backgroundColor = _modelColor(entry.model);
      const modelName = document.createElement("span");
      modelName.textContent = _modelName(entry.model);
      modelHeadingCell.append(developerMark, modelName);
      modelHeadingCell.title = _modelName(entry.model);
      row.append(modelHeadingCell);
      for (const maze of analytics.mazes) {
        const score = entry.scoresByMaze[maze.maze_id];
        const cell = document.createElement("td");
        if (Number.isFinite(score)) {
          cell.className = `score-band-${_scoreBand(score)}`;
          cell.textContent = String(Math.round(score));
          cell.dataset.chartTooltip = (
            `${_modelName(entry.model)} · ${data.mazeDisplayName(maze)} · `
            + _t("common.points", { score: data.formatScore(score) })
          );
        } else {
          cell.className = "is-empty";
          cell.textContent = "—";
          cell.dataset.chartTooltip = (
            `${_modelName(entry.model)} · ${data.mazeDisplayName(maze)} · `
            + _t("common.scoreMissing")
          );
        }
        cell.setAttribute("aria-label", cell.dataset.chartTooltip);
        cell.tabIndex = 0;
        row.append(cell);
      }
      body.append(row);
    }
    table.append(head, body);
    scroll.append(table);

    const legend = document.createElement("div");
    legend.className = "full-heatmap-legend";
    const bands = [
      ["0–19", 0],
      ["20–39", 1],
      ["40–59", 2],
      ["60–79", 3],
      ["80–100", 4],
    ];
    for (const [label, band] of bands) {
      const item = document.createElement("span");
      const swatch = document.createElement("i");
      swatch.className = `score-band-${band}`;
      item.append(swatch, document.createTextNode(label));
      legend.append(item);
    }
    const missing = document.createElement("span");
    const missingSwatch = document.createElement("i");
    missingSwatch.className = "is-empty";
    missing.append(missingSwatch, document.createTextNode("—"));
    legend.append(missing);
    elements.leaderboardHeatmap.replaceChildren(scroll, legend);
    _bindChartTooltip(elements.leaderboardHeatmap);
  }

  /** @description Format scatter-axis cost ticks */
  function _formatCostTick(value) {
    if (value >= 10) {
      return `$${value.toFixed(0)}`;
    }
    if (value >= 1) {
      return `$${value.toFixed(1)}`;
    }
    return `$${value.toFixed(2)}`;
  }

  /** @description Calculate a padded axis range with readable tick intervals */
  function _niceAxisRange(values, {
    floor = -Infinity,
    ceiling = Infinity,
    tickCount = 4,
  } = {}) {
    const dataMinimum = Math.min(...values);
    const dataMaximum = Math.max(...values);
    const dataSpan = dataMaximum - dataMinimum;
    const padding = dataSpan > 0
      ? dataSpan * 0.1
      : Math.max(Math.abs(dataMaximum) * 0.1, 1);
    const paddedMinimum = Math.max(floor, dataMinimum - padding);
    const paddedMaximum = Math.min(ceiling, dataMaximum + padding);
    const rawInterval = Math.max(
      Number.EPSILON,
      (paddedMaximum - paddedMinimum) / tickCount,
    );
    const magnitude = 10 ** Math.floor(Math.log10(rawInterval));
    const normalized = rawInterval / magnitude;
    const interval = (
      normalized <= 1
        ? 1
        : normalized <= 2
          ? 2
          : normalized <= 2.5
            ? 2.5
            : normalized <= 5
              ? 5
              : 10
    ) * magnitude;
    let minimum = Math.max(floor, Math.floor(paddedMinimum / interval) * interval);
    let maximum = Math.min(ceiling, Math.ceil(paddedMaximum / interval) * interval);
    if (maximum <= minimum) {
      minimum = Math.max(floor, minimum - interval);
      maximum = Math.min(ceiling, maximum + interval);
    }
    const ticks = [];
    for (
      let tick = minimum;
      tick <= maximum + interval * 0.001;
      tick += interval
    ) {
      ticks.push(Number(tick.toPrecision(12)));
    }
    return { min: minimum, max: maximum, interval, ticks };
  }

  /** @description Format score-axis values without unnecessary decimals */
  function _formatScoreTick(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }

  /** @description Render score against selected-range cost */
  function _renderCostScatter(analytics) {
    const points = _orderedAnalyticsModels(analytics).filter((entry) => (
      state.selectedModelKeys.has(data.modelKey(entry.model))
      &&
      Number.isFinite(entry.score)
      && Number.isFinite(entry.cost)
      && entry.cost > 0
    ));
    if (points.length === 0) {
      const empty = document.createElement("p");
      empty.className = "chart-empty";
      empty.textContent = _t("leaderboard.noCostData");
      elements.costScatter.replaceChildren(empty);
      return;
    }

    const width = 1040;
    const height = 420;
    const margin = { top: 20, right: 24, bottom: 56, left: 66 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const costs = points.map(({ cost }) => cost);
    const scores = points.map(({ score }) => score);
    const dataMinimum = Math.min(...costs);
    const dataMaximum = Math.max(...costs);
    const linearRange = _niceAxisRange(costs, { floor: 0 });
    const scoreRange = _niceAxisRange(scores, { floor: 0, ceiling: 100 });
    const logMinimum = dataMinimum * 0.9;
    const logMaximum = dataMaximum * 1.1;
    const logSpan = Math.log10(logMaximum) - Math.log10(logMinimum);
    const xPosition = (cost) => {
      if (state.scatterScale === "log") {
        const ratio = logSpan === 0
          ? 0.5
          : (Math.log10(cost) - Math.log10(logMinimum)) / logSpan;
        return margin.left + ratio * plotWidth;
      }
      return (
        margin.left
        + ((cost - linearRange.min) / (linearRange.max - linearRange.min))
        * plotWidth
      );
    };
    const yPosition = (score) => (
      margin.top
      + plotHeight
      - ((score - scoreRange.min) / (scoreRange.max - scoreRange.min))
      * plotHeight
    );
    const svg = _svgElement("svg", {
      class: "cost-scatter-svg",
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
      role: "img",
      "aria-label": _t("leaderboard.chartCost", {
        scale: state.scatterScale === "log"
          ? _t("leaderboard.log")
          : _t("leaderboard.linear"),
      }),
    });
    svg.style.minWidth = "720px";

    svg.append(
      _svgElement("rect", {
        x: margin.left,
        y: margin.top,
        width: plotWidth / 2,
        height: plotHeight / 2,
        class: "scatter-good-area",
      }),
      _svgElement("rect", {
        x: margin.left + plotWidth / 2,
        y: margin.top + plotHeight / 2,
        width: plotWidth / 2,
        height: plotHeight / 2,
        class: "scatter-poor-area",
      }),
    );

    scoreRange.ticks.forEach((tick) => {
      const y = yPosition(tick);
      svg.append(
        _svgElement("line", {
          x1: margin.left,
          x2: width - margin.right,
          y1: y,
          y2: y,
          class: "chart-grid-line",
        }),
        _svgElement("text", {
          x: margin.left - 11,
          y: y + 4,
          class: "chart-axis-tick",
          "text-anchor": "end",
        }, _formatScoreTick(tick)),
      );
    });

    const xTicks = state.scatterScale === "log"
      ? []
      : linearRange.ticks;
    if (state.scatterScale === "log") {
      for (let index = 0; index <= 4; index += 1) {
        const value = 10 ** (
          Math.log10(logMinimum) + (logSpan * index) / 4
        );
        xTicks.push(value);
      }
    }
    xTicks.forEach((tick, index) => {
      const x = state.scatterScale === "log"
        ? margin.left + (plotWidth * index) / 4
        : xPosition(tick);
      svg.append(
        _svgElement("line", {
          x1: x,
          x2: x,
          y1: margin.top,
          y2: height - margin.bottom,
          class: "chart-grid-line",
        }),
        _svgElement("text", {
          x,
          y: height - margin.bottom + 24,
          class: "chart-axis-tick",
          "text-anchor": "middle",
        }, _formatCostTick(tick)),
      );
    });
    svg.append(
      _svgElement("line", {
        x1: margin.left + plotWidth / 2,
        x2: margin.left + plotWidth / 2,
        y1: margin.top,
        y2: height - margin.bottom,
        class: "chart-reference-line",
      }),
      _svgElement("line", {
        x1: margin.left,
        x2: width - margin.right,
        y1: margin.top + plotHeight / 2,
        y2: margin.top + plotHeight / 2,
        class: "chart-reference-line",
      }),
    );
    svg.append(
      _svgElement("text", {
        x: margin.left + plotWidth / 2,
        y: height - 8,
        class: "chart-axis-title",
        "text-anchor": "middle",
      }, _t("leaderboard.totalCostAxis")),
      _svgElement("text", {
        x: 17,
        y: margin.top + plotHeight / 2,
        class: "chart-axis-title",
        "text-anchor": "middle",
        transform: `rotate(-90 17 ${margin.top + plotHeight / 2})`,
      }, _t("leaderboard.averageScoreAxis")),
    );

    for (const entry of points) {
      const pointX = xPosition(entry.cost);
      const pointY = yPosition(entry.score);
      const tooltip = (
        `${_modelName(entry.model)} · `
        + `${_t("common.points", { score: data.formatScore(entry.score) })} · `
        + `${data.formatCost(entry.cost)}`
        + (entry.state === "partial"
          ? ` · ${_t("leaderboard.aggregating")}`
          : "")
      );
      const circleAttributes = {
        cx: pointX,
        cy: pointY,
        r: 7,
        class: entry.state === "partial"
          ? "scatter-partial-point"
          : "developer-mark",
        fill: entry.state === "partial" ? "#ffffff" : _modelColor(entry.model),
        ...(entry.state === "partial" ? {
          stroke: _modelColor(entry.model),
          "stroke-width": 2.5,
        } : {}),
        tabindex: 0,
        role: "img",
        "aria-label": tooltip,
        "data-chart-tooltip": tooltip,
        "data-model-highlight": _modelIndex(entry.model),
      };
      if (entry.state === "partial") {
        svg.append(_svgElement("circle", {
          cx: circleAttributes.cx,
          cy: circleAttributes.cy,
          r: 7.8,
          class: "developer-mark scatter-point-outline",
          fill: "none",
        }));
      }
      const circle = _svgElement("circle", circleAttributes);
      const exportLabel = _svgElement("text", {
        x: pointX,
        y: pointY - 16,
        class: "scatter-export-label",
        "text-anchor": "middle",
        "aria-hidden": "true",
        "data-export-show": "true",
        "data-cost-scatter-label": "true",
        "data-point-x": pointX,
        "data-point-y": pointY,
      }, _modelName(entry.model));
      svg.append(circle, exportLabel);
    }

    const scroll = document.createElement("div");
    scroll.className = "chart-horizontal-scroll scatter-scroll";
    scroll.append(svg);
    elements.costScatter.replaceChildren(scroll);
    _bindChartTooltip(elements.costScatter);
  }

  /** @description Render every leaderboard analytics card */
  function _renderAnalytics() {
    state.analytics = data.aggregateLeaderboardModels(
      state.payload,
      _activeSizes(),
    );
    _renderMultiModelChart(state.analytics);
    _renderLeaderboardHeatmap(state.analytics);
    _renderCostScatter(state.analytics);
  }

  /** @description Forward boundary wheel movement from the ranking table to the page */
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

  /** @description Render ranking for the selected maze sizes */
  function _renderRanking() {
    if (!state.payload) {
      return;
    }
    const rankedEntries = data.rankModels(state.payload.models, _selectedStats);
    const entries = data.sortRankedEntries(
      rankedEntries,
      state.sortKey,
      state.sortDirection,
    );
    elements.rankingBody.replaceChildren(...entries.map(_createRow));
    elements.emptyState.hidden = entries.length > 0;
    elements.tableScroll.scrollTop = 0;

    const completeCount = rankedEntries.filter(
      (entry) => entry.state === "complete",
    ).length;
    const partialCount = rankedEntries.filter(
      (entry) => entry.state === "partial",
    ).length;
    elements.scopeNote.textContent = _t("leaderboard.selectedSizeScope", {
      scope: _selectedSizeLabel(),
      complete: completeCount,
      partial: partialCount
        ? _t("leaderboard.partialScope", { count: partialCount })
        : "",
    });
    _syncSortControls();
  }

  /** @description Render ranking and analytics for the selected maze sizes */
  function _render() {
    _renderRanking();
    _renderAnalytics();
    _syncUrl();
  }

  /** @description Synchronize size-button selection styles and accessibility state */
  function _renderSizeButtons() {
    const allSelected = state.selectedSizes.size === state.sizes.length;
    for (const button of elements.sizeButtons.querySelectorAll("button")) {
      const size = button.dataset.size;
      const pressed = size === "all"
        ? allSelected
        : state.selectedSizes.has(size);
      button.setAttribute("aria-pressed", String(pressed));
      button.classList.toggle(
        "is-partial",
        size === "all" && state.selectedSizes.size > 0 && !allSelected,
      );
    }
  }

  /** @description Toggle all or one maze-size selection */
  function _toggleSize(size) {
    if (size === "all") {
      state.selectedSizes = state.selectedSizes.size === state.sizes.length
        ? new Set()
        : new Set(state.sizes);
    } else if (state.selectedSizes.has(size)) {
      state.selectedSizes.delete(size);
    } else {
      state.selectedSizes.add(size);
    }
    _renderSizeButtons();
    _render();
  }

  /** @description Populate size buttons and restore valid query values */
  function _populateSizes() {
    state.sizes = data.getSizes(state.payload);
    const requestedSizes = new URLSearchParams(window.location.search).getAll("size");
    const validRequestedSizes = requestedSizes.filter((size) => state.sizes.includes(size));
    if (requestedSizes.includes("none")) {
      state.selectedSizes = new Set();
    } else if (requestedSizes.length === 0) {
      state.selectedSizes = new Set(state.sizes);
    } else if (validRequestedSizes.length > 0) {
      state.selectedSizes = new Set(validRequestedSizes);
    } else {
      state.selectedSizes = new Set(state.sizes);
    }

    const buttonDefinitions = [
      { value: "all", label: _t("common.all") },
      ...state.sizes.map((size) => ({ value: size, label: data.formatSize(size) })),
    ];
    const buttons = buttonDefinitions.map(({ value, label }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.size = value;
      button.textContent = label;
      button.addEventListener("click", () => _toggleSize(value));
      return button;
    });
    elements.sizeButtons.replaceChildren(...buttons);
    _renderSizeButtons();
  }

  /** @description Load and render the leaderboard */
  async function _load() {
    try {
      state.payload = await data.loadBenchmarkResults();
      _populateSizes();
      _initializeChartModels();
      _renderModelPicker();
      _render();
    } catch (error) {
      state.loadError = error;
      elements.messageBox.hidden = false;
      elements.messageBox.textContent = _t("common.publicLoadFailure", {
        detail: _errorText(error),
      });
      elements.scopeNote.textContent = _t("leaderboard.loadFailed");
    }
  }

  if (!data) {
    elements.messageBox.hidden = false;
    elements.messageBox.textContent = _t("common.dataModuleFailure");
    return;
  }

  elements.tableScroll.addEventListener("wheel", _forwardBoundaryWheel, {
    passive: false,
  });
  document.addEventListener("pointerdown", (event) => {
    for (const picker of elements.modelPickers) {
      if (picker.open && !picker.contains(event.target)) {
        picker.removeAttribute("open");
      }
    }
  });
  for (const heading of elements.sortHeaders) {
    heading.querySelector("button").addEventListener("click", () => {
      _changeSort(heading.dataset.sortKey);
    });
  }
  const headerTooltips = [
    [
      elements.modelReasoningHelp,
      elements.modelSortButton,
      elements.modelReasoningTooltip,
    ],
    [
      elements.scoreFormulaHelp,
      elements.scoreSortButton,
      elements.scoreFormulaTooltip,
    ],
  ];
  for (const tooltipElements of headerTooltips) {
    _bindHeaderTooltip(...tooltipElements);
  }
  globalThis.addEventListener("resize", () => {
    for (const [help, button, tooltip] of headerTooltips) {
      if (tooltip.classList.contains("is-visible")) {
        _positionHeaderTooltip(help, button, tooltip);
      }
    }
  });
  globalThis.addEventListener("scroll", () => {
    for (const [help, button, tooltip] of headerTooltips) {
      if (tooltip.classList.contains("is-visible")) {
        _positionHeaderTooltip(help, button, tooltip);
      }
    }
  }, true);
  elements.mobileSortKey.addEventListener("change", () => {
    state.sortKey = elements.mobileSortKey.value;
    state.sortDirection = "descending";
    _renderRanking();
  });
  elements.mobileSortDirection.addEventListener("click", () => {
    _changeSort(state.sortKey);
  });
  for (const button of elements.scatterScaleButtons) {
    button.addEventListener("click", () => {
      state.scatterScale = state.scatterScale === "linear" ? "log" : "linear";
      for (const candidate of elements.scatterScaleButtons) {
        candidate.setAttribute(
          "aria-pressed",
          String(candidate.dataset.scale === state.scatterScale),
        );
      }
      if (state.analytics) {
        _renderCostScatter(state.analytics);
      }
    });
  }

  globalThis.addEventListener(i18n.LOCALE_EVENT, () => {
    if (state.payload) {
      _populateSizes();
      _renderModelPicker();
      _render();
      return;
    }
    if (state.loadError !== null) {
      elements.messageBox.textContent = _t("common.publicLoadFailure", {
        detail: _errorText(state.loadError),
      });
      elements.scopeNote.textContent = _t("leaderboard.loadFailed");
    }
  });
  globalThis.addEventListener(
    globalThis.MazeBenchTheme.THEME_EVENT,
    () => {
      if (state.analytics) {
        _renderSelectedModelCharts();
      }
    },
  );

  void _load();
}());
