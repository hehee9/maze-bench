/**
 * @file public/replay.js
 * @description Render and control the Maze Bench replay page
 */

(function initializeReplayPage() {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const ARROW_ROTATIONS = { E: 0, S: 90, W: 180, N: 270 };
  const VIEW_MARGIN = 1.45;
  const i18n = globalThis.MazeBenchI18n;
  const data = globalThis.MazeBenchmarkData;
  const core = globalThis.MazeReplayCore;
  const portraitLayout = window.matchMedia(
    "(max-width: 900px) and (orientation: portrait)",
  );

  const state = {
    results: [],
    models: [],
    mazes: [],
    mazeByKey: new Map(),
    mazeLabels: new Map(),
    resultIndex: new Map(),
    entries: new Map(),
    maze: null,
    selectedMaze: null,
    optimalReplay: null,
    selectedModelKeys: [],
    activeModelKey: null,
    selectionInitialized: false,
    payloadStatus: null,
    cursor: 0,
    timer: null,
    loadSequence: 0,
    message: null,
    resultLoadError: null,
    initialQuery: {
      size: new URLSearchParams(window.location.search).get("size"),
      maze: new URLSearchParams(window.location.search).get("maze"),
      model: new URLSearchParams(window.location.search).get("model"),
    },
  };

  const elements = {
    sizeSelect: document.querySelector("#sizeSelect"),
    replaySelect: document.querySelector("#replaySelect"),
    modelSearch: document.querySelector("#modelSearch"),
    allModelsBulkButton: document.querySelector("#allModelsBulkButton"),
    developerPicker: document.querySelector("#developerPicker"),
    developerBulkButtons: document.querySelector("#developerBulkButtons"),
    modelList: document.querySelector("#modelList"),
    optimalToggle: document.querySelector("#optimalToggle"),
    controlPanel: document.querySelector(".control-panel"),
    replayPanel: document.querySelector(".replay-panel"),
    panelToggle: document.querySelector("#panelToggle"),
    outcomeBadge: document.querySelector("#outcomeBadge"),
    activeModelName: document.querySelector("#activeModelName"),
    scoreValue: document.querySelector("#scoreValue"),
    executedValue: document.querySelector("#executedValue"),
    optimalValue: document.querySelector("#optimalValue"),
    firstButton: document.querySelector("#firstButton"),
    previousButton: document.querySelector("#previousButton"),
    playButton: document.querySelector("#playButton"),
    nextButton: document.querySelector("#nextButton"),
    lastButton: document.querySelector("#lastButton"),
    speedSelect: document.querySelector("#speedSelect"),
    stepInput: document.querySelector("#stepInput"),
    stepTotal: document.querySelector("#stepTotal"),
    stepRange: document.querySelector("#stepRange"),
    messageBox: document.querySelector("#messageBox"),
    modelRouteTooltip: document.querySelector("#modelRouteTooltip"),
    mazeSvg: document.querySelector("#mazeSvg"),
    mazeTitle: document.querySelector("#mazeTitle"),
    mazeDescription: document.querySelector("#mazeDescription"),
    mazeLayer: document.querySelector("#mazeLayer"),
    optimalLayer: document.querySelector("#optimalLayer"),
    routeLayer: document.querySelector("#routeLayer"),
    markerLayer: document.querySelector("#markerLayer"),
    commandLogFrame: document.querySelector("#commandLogFrame"),
    commandLog: document.querySelector("#commandLog"),
    logLeftButton: document.querySelector("#logLeftButton"),
    logRightButton: document.querySelector("#logRightButton"),
    exportReplayButton: document.querySelector("#exportReplayButton"),
  };

  /** @description Translate a replay string */
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

  /** @description Create an SVG element with optional attributes */
  function _svgElement(name, attributes = {}) {
    const element = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) {
      element.setAttribute(key, String(value));
    }
    return element;
  }

  /** @description Remove all children from a DOM node */
  function _clear(element) {
    element.replaceChildren();
  }

  /** @description Build a stable key for a model configuration */
  function _modelKey(value) {
    const model = value?.model ?? value ?? {};
    return [
      model.provider,
      model.model_id,
      model.reasoning_label,
      model.name,
    ].join("\u001f");
  }

  /** @description Return a readable model name */
  function _modelName(model) {
    return data.displayModelName(model);
  }

  /** @description Build a stable key for a maze */
  function _mazeKey(maze) {
    return `${maze.width}x${maze.height}\u001f${maze.maze_id}`;
  }

  /** @description Build a lookup key for one model result on one maze */
  function _resultKey(maze, modelKey) {
    return `${_mazeKey(maze)}\u001e${modelKey}`;
  }

  /** @description Format a score for compact display */
  function _formatScore(score) {
    return Number.isFinite(score) ? score.toFixed(2) : "—";
  }

  /** @description Return the official or provisional overall model score */
  function _overallScore(model) {
    if (Number.isFinite(model?.official_mean_score)) {
      return model.official_mean_score;
    }
    return Number.isFinite(model?.provisional_mean_score)
      ? model.provisional_mean_score
      : null;
  }

  /** @description Sort numeric scores descending with missing values last */
  function _compareScoresDescending(first, second) {
    const firstAvailable = Number.isFinite(first);
    const secondAvailable = Number.isFinite(second);
    if (firstAvailable !== secondAvailable) {
      return firstAvailable ? -1 : 1;
    }
    if (!firstAvailable) {
      return 0;
    }
    return second - first;
  }

  /** @description Return a readable replay name */
  function _mazeDisplayName(maze, fallbackIndex) {
    const match = /^maze_\d+x\d+_(adjacent|opposite|same)_(\d+)$/i.exec(
      maze.maze_id,
    );
    if (match) {
      return _t("common.mazeNamed", {
        number: Number(match[2]),
        relation: _t(`relation.${match[1].toLowerCase()}`),
      });
    }
    return _t("common.mazeFallback", { number: fallbackIndex + 1 });
  }

  /** @description Keep the current replay selection in the address bar */
  function _syncUrl() {
    if (!state.selectedMaze) {
      return;
    }
    const activeModel = state.models.find(
      (item) => item.key === state.activeModelKey,
    )?.model;
    const query = new URLSearchParams({
      size: `${state.selectedMaze.width}x${state.selectedMaze.height}`,
      maze: state.selectedMaze.maze_id,
    });
    if (activeModel?.name) {
      query.set("model", activeModel.name);
    }
    window.history.replaceState(null, "", `index.html?${query}`);
  }

  /** @description Show a blocking replay message */
  function _showMessage(key, parameters = {}) {
    state.message = { key, parameters };
    _renderMessage();
    elements.messageBox.hidden = false;
  }

  /** @description Show a translated wrapper around a stored error */
  function _showErrorMessage(key, error) {
    state.message = { key, parameters: {}, error };
    _renderMessage();
    elements.messageBox.hidden = false;
  }

  /** @description Render the active replay message in the current locale */
  function _renderMessage() {
    if (!state.message) {
      return;
    }
    const parameters = { ...state.message.parameters };
    if (state.message.error) {
      parameters.detail = _errorText(state.message.error);
    }
    elements.messageBox.textContent = _t(state.message.key, parameters);
  }

  /** @description Hide the replay message */
  function _hideMessage() {
    state.message = null;
    elements.messageBox.hidden = true;
    elements.messageBox.textContent = "";
  }

  /** @description Enable or disable controls that require selected models */
  function _setReplayControlsEnabled(enabled) {
    const controls = [
      elements.firstButton,
      elements.previousButton,
      elements.playButton,
      elements.nextButton,
      elements.lastButton,
      elements.stepInput,
      elements.stepRange,
      elements.speedSelect,
    ];
    for (const control of controls) {
      control.disabled = !enabled;
    }
  }

  /** @description Stop automatic playback */
  function _pause() {
    if (state.timer !== null) {
      window.clearInterval(state.timer);
      state.timer = null;
    }
    elements.playButton.setAttribute("aria-pressed", "false");
    elements.playButton.setAttribute("aria-label", _t("replay.autoPlay"));
    elements.playButton.textContent = `▶ ${_t("replay.play")}`;
  }

  /** @description Expand or collapse mobile replay options */
  function _setPanelExpanded(expanded) {
    elements.controlPanel.classList.toggle("is-collapsed", !expanded);
    elements.panelToggle.setAttribute("aria-expanded", String(expanded));
    const label = expanded
      ? _t("replay.collapse")
      : _t("replay.expand");
    elements.panelToggle.textContent = expanded ? "▴" : "▾";
    elements.panelToggle.setAttribute("aria-label", label);
    elements.panelToggle.title = label;
  }

  /** @description Match the option panel to the current responsive layout */
  function _syncResponsivePanel(event) {
    _setPanelExpanded(!event.matches);
  }

  /** @description Replace select options while preserving a valid value */
  function _setOptions(select, options, preferredValue) {
    _clear(select);
    for (const optionData of options) {
      const option = document.createElement("option");
      option.value = optionData.value;
      option.textContent = optionData.label;
      if (optionData.title) {
        option.title = optionData.title;
        option.setAttribute(
          "aria-label",
          _t("common.originalId", {
            label: optionData.label,
            id: optionData.title,
          }),
        );
      }
      select.append(option);
    }

    if (options.some((option) => option.value === preferredValue)) {
      select.value = preferredValue;
    }
  }

  /** @description Index public models, mazes, and results */
  function _buildCatalog(payload) {
    const modelMap = new Map();
    for (const model of payload.models ?? []) {
      modelMap.set(_modelKey(model), model);
    }
    for (const result of payload.results) {
      const key = _modelKey(result);
      if (!modelMap.has(key)) {
        modelMap.set(key, result.model ?? {});
      }
    }

    const mazeMap = new Map();
    const resultIndex = new Map();
    for (const result of payload.results) {
      const maze = result.maze;
      if (!maze?.maze_id) {
        continue;
      }
      const mazeKey = _mazeKey(maze);
      if (!mazeMap.has(mazeKey)) {
        mazeMap.set(mazeKey, {
          maze_id: maze.maze_id,
          width: maze.width,
          height: maze.height,
        });
      }
      resultIndex.set(_resultKey(maze, _modelKey(result)), result);
    }

    state.results = payload.results;
    state.models = [...modelMap].map(([key, model]) => ({ key, model }));
    state.mazes = [...mazeMap.values()];
    state.mazeByKey = mazeMap;
    state.resultIndex = resultIndex;
    state.payloadStatus = payload.status ?? null;
  }

  /** @description Populate maze size choices from every result */
  function _populateSizes() {
    const sizeSet = new Set(
      state.mazes.map((maze) => `${maze.width}x${maze.height}`),
    );
    const sizes = [...sizeSet].sort((first, second) => {
      const [firstWidth, firstHeight] = first.split("x").map(Number);
      const [secondWidth, secondHeight] = second.split("x").map(Number);
      return firstWidth * firstHeight - secondWidth * secondHeight;
    });

    _setOptions(
      elements.sizeSelect,
      sizes.map((size) => ({ value: size, label: size.replace("x", " × ") })),
      sizes.includes(state.initialQuery.size)
        ? state.initialQuery.size
        : elements.sizeSelect.value,
    );
    _populateReplays();
  }

  /** @description Populate model-independent replay choices */
  function _populateReplays() {
    const mazes = state.mazes
      .filter((maze) => `${maze.width}x${maze.height}` === elements.sizeSelect.value)
      .sort((first, second) => first.maze_id.localeCompare(
        second.maze_id,
        "ko",
        { numeric: true },
      ));

    state.mazeLabels = new Map(
      mazes.map((maze, index) => [_mazeKey(maze), _mazeDisplayName(maze, index)]),
    );
    const requestedMaze = mazes.find(
      (maze) => maze.maze_id === state.initialQuery.maze,
    );
    _setOptions(
      elements.replaySelect,
      mazes.map((maze) => ({
        value: _mazeKey(maze),
        label: state.mazeLabels.get(_mazeKey(maze)),
        title: maze.maze_id,
      })),
      requestedMaze
        ? _mazeKey(requestedMaze)
        : elements.replaySelect.value,
    );
    void _loadSelectedMaze();
  }

  /** @description Return the public result for a model on the selected maze */
  function _selectedResult(modelKey) {
    if (!state.selectedMaze) {
      return null;
    }
    return state.resultIndex.get(_resultKey(state.selectedMaze, modelKey)) ?? null;
  }

  /** @description Describe whether one result can be replayed */
  function _resultAvailability(result, entry) {
    if (entry?.loading) {
      return { label: _t("common.loading"), replayable: false };
    }
    if (entry?.error) {
      return { label: _t("replay.replayError"), replayable: false };
    }
    if (!result) {
      return {
        label: state.payloadStatus === "running"
          ? _t("common.waiting")
          : _t("common.noResults"),
        replayable: false,
      };
    }
    if (result.status === "api_failure") {
      return { label: _t("common.apiFailure"), replayable: false };
    }
    if (result.status !== "success") {
      return { label: _t("common.unavailable"), replayable: false };
    }
    if (result.format_valid !== true) {
      return { label: _t("common.formatError"), replayable: false };
    }
    if (!String(result.output ?? "").trim()) {
      return { label: _t("replay.emptyOutput"), replayable: false };
    }

    const grading = result.grading ?? {};
    return {
      label: grading.success
        ? _t("common.completed")
        : grading.death
          ? _t("common.collision")
          : _t("common.unreached"),
      replayable: Boolean(entry?.replay),
    };
  }

  /** @description Return shared developer metadata for one replay model */
  function _modelDeveloper(modelKey) {
    const model = state.models.find((item) => item.key === modelKey)?.model;
    return data.modelDeveloper(model);
  }

  /** @description Return the shared color for one model developer */
  function _modelColor(modelKey) {
    return _modelDeveloper(modelKey).color;
  }

  /** @description Hide the model name tooltip above the replay */
  function _hideModelRouteTooltip() {
    elements.modelRouteTooltip.hidden = true;
    delete elements.modelRouteTooltip.dataset.modelKey;
  }

  /** @description Keep the model name tooltip within the replay panel */
  function _positionModelRouteTooltip(clientX, clientY) {
    const panelBounds = elements.replayPanel.getBoundingClientRect();
    const tooltip = elements.modelRouteTooltip;
    const margin = 8;
    const gap = 12;
    const maximumLeft = Math.max(
      margin,
      panelBounds.width - tooltip.offsetWidth - margin,
    );
    const left = Math.min(
      maximumLeft,
      Math.max(margin, clientX - panelBounds.left + gap),
    );
    const maximumTop = Math.max(
      margin,
      panelBounds.height - tooltip.offsetHeight - margin,
    );
    const preferredTop = clientY - panelBounds.top - tooltip.offsetHeight - gap;
    const fallbackTop = clientY - panelBounds.top + gap;
    const top = Math.min(
      maximumTop,
      Math.max(margin, preferredTop < margin ? fallbackTop : preferredTop),
    );
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  /** @description Show the model name represented by one rendered route group */
  function _showModelRouteTooltip(target, clientX, clientY) {
    elements.modelRouteTooltip.textContent = target.dataset.modelName;
    elements.modelRouteTooltip.dataset.modelKey = target.dataset.modelKey;
    elements.modelRouteTooltip.hidden = false;
    _positionModelRouteTooltip(clientX, clientY);
  }

  /** @description Return the rendered model route group below one pointer target */
  function _modelRouteTarget(target) {
    return target?.closest?.(".model-route[data-model-name]") ?? null;
  }

  /** @description Return every replayable model key for the selected maze */
  function _availableModelKeys() {
    return state.models
      .map((item) => item.key)
      .filter((key) => state.entries.get(key)?.replay);
  }

  /** @description Return the pressed state for a replay bulk selection */
  function _bulkSelectionState(keys) {
    const selectedCount = keys.filter((key) => (
      state.selectedModelKeys.includes(key)
    )).length;
    if (selectedCount === 0) {
      return "false";
    }
    return selectedCount === keys.length ? "true" : "mixed";
  }

  /** @description Toggle every replayable model in one bulk selection */
  function _toggleBulkModels(keys) {
    const shouldSelect = _bulkSelectionState(keys) !== "true";
    if (shouldSelect) {
      const selected = new Set([...state.selectedModelKeys, ...keys]);
      state.selectedModelKeys = state.models
        .map((item) => item.key)
        .filter((key) => selected.has(key));
      state.activeModelKey = state.activeModelKey ?? keys[0] ?? null;
    } else {
      const removed = new Set(keys);
      state.selectedModelKeys = state.selectedModelKeys.filter(
        (key) => !removed.has(key),
      );
      if (removed.has(state.activeModelKey)) {
        state.activeModelKey = state.selectedModelKeys[0] ?? null;
      }
    }
    _refreshComparison();
  }

  /** @description Create one icon button for a developer-wide model selection */
  function _createDeveloperBulkButton(keys, developer) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "developer-bulk-button";
    button.dataset.developerKey = developer.key;
    const selectionState = _bulkSelectionState(keys);
    const shouldSelect = selectionState !== "true";
    button.setAttribute("aria-pressed", selectionState);
    button.disabled = keys.length === 0;
    button.title = developer.label;
    button.style.setProperty("--developer-color", developer.color);
    button.setAttribute(
      "aria-label",
      _t(
        shouldSelect
          ? "selection.selectDeveloper"
          : "selection.clearDeveloper",
        { developer: developer.label },
      ),
    );

    const icon = document.createElement("img");
    icon.src = developer.iconPath;
    icon.alt = "";
    icon.setAttribute("aria-hidden", "true");
    button.append(icon);
    button.addEventListener("click", () => {
      _toggleBulkModels(keys);
      elements.developerBulkButtons.querySelector(
        `[data-developer-key="${developer.key}"]`,
      )?.focus();
    });
    return button;
  }

  /** @description Render replay-wide and developer-wide model controls */
  function _renderBulkControls() {
    const availableKeys = _availableModelKeys();
    const groups = new Map();
    for (const item of state.models) {
      if (!availableKeys.includes(item.key)) {
        continue;
      }
      const developer = data.modelDeveloper(item.model);
      if (!groups.has(developer.key)) {
        groups.set(developer.key, { developer, keys: [] });
      }
      groups.get(developer.key).keys.push(item.key);
    }
    const allSelectionState = _bulkSelectionState(availableKeys);
    elements.allModelsBulkButton.disabled = availableKeys.length === 0;
    elements.allModelsBulkButton.setAttribute(
      "aria-pressed",
      allSelectionState,
    );
    elements.allModelsBulkButton.textContent = allSelectionState === "true"
      ? _t("selection.clearAll")
      : _t("selection.selectAll");

    elements.developerPicker.hidden = groups.size === 0;
    if (groups.size === 0) {
      elements.developerPicker.removeAttribute("open");
    }
    elements.developerBulkButtons.replaceChildren(
      ...[...groups.values()].map(({ developer, keys }) => (
        _createDeveloperBulkButton(keys, developer)
      )),
    );
  }

  /** @description Return all selected replay entries */
  function _selectedEntries() {
    return state.selectedModelKeys
      .map((key) => state.entries.get(key))
      .filter((entry) => entry?.replay);
  }

  /** @description Return the active replay entry */
  function _activeEntry() {
    const entry = state.entries.get(state.activeModelKey);
    return entry?.replay ? entry : null;
  }

  /** @description Return the shared terminal position */
  function _replayEnd() {
    return _selectedEntries().reduce(
      (maximum, entry) => Math.max(maximum, entry.replay.terminalCursor),
      0,
    );
  }

  /** @description Render model comparison choices and statuses */
  function _renderModelList() {
    _renderBulkControls();
    _clear(elements.modelList);
    if (state.models.length === 0) {
      const empty = document.createElement("p");
      empty.className = "model-list-empty";
      empty.textContent = _t("common.noDisplayModels");
      elements.modelList.append(empty);
      return;
    }

    const searchQuery = elements.modelSearch.value.trim().toLocaleLowerCase(
      i18n.getLocale(),
    );
    const fragment = document.createDocumentFragment();
    const displayItems = state.models
      .map((item, index) => {
        const entry = state.entries.get(item.key);
        const result = entry?.result ?? _selectedResult(item.key);
        return {
          item,
          index,
          entry,
          result,
          availability: _resultAvailability(result, entry),
        };
      })
      .filter(({ item }) => {
        if (!searchQuery) {
          return true;
        }
        return [item.model.name, item.model.model_id].some(
          (value) => String(value ?? "")
            .toLocaleLowerCase(i18n.getLocale())
            .includes(searchQuery),
        );
      })
      .sort((first, second) => (
        _compareScoresDescending(first.result?.score, second.result?.score)
        || _compareScoresDescending(
          _overallScore(first.item.model),
          _overallScore(second.item.model),
        )
        || first.index - second.index
      ));

    if (displayItems.length === 0) {
      const empty = document.createElement("p");
      empty.className = "model-list-empty";
      empty.textContent = _t("replay.noSearchResults");
      elements.modelList.append(empty);
      return;
    }

    for (const displayItem of displayItems) {
      const {
        item,
        entry,
        result,
        availability,
      } = displayItem;
      const row = document.createElement("div");
      row.className = "model-row";
      row.classList.toggle("is-active", state.activeModelKey === item.key);
      row.classList.toggle("is-unavailable", !availability.replayable);

      const checkLabel = document.createElement("label");
      checkLabel.className = "model-check";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.selectedModelKeys.includes(item.key);
      checkbox.disabled = !availability.replayable;
      checkbox.setAttribute(
        "aria-label",
        _t("replay.routeVisible", {
          model: _modelName(item.model),
        }),
      );
      checkbox.addEventListener("change", () => {
        _pause();
        if (checkbox.checked) {
          if (!state.selectedModelKeys.includes(item.key)) {
            state.selectedModelKeys.push(item.key);
          }
          state.activeModelKey = item.key;
        } else {
          state.selectedModelKeys = state.selectedModelKeys.filter(
            (key) => key !== item.key,
          );
          if (state.activeModelKey === item.key) {
            state.activeModelKey = state.selectedModelKeys[0] ?? null;
          }
        }
        _refreshComparison();
      });
      checkLabel.append(checkbox);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "model-activate";
      button.disabled = !availability.replayable;
      button.setAttribute(
        "aria-pressed",
        String(state.activeModelKey === item.key),
      );
      button.title = availability.replayable
        ? _t("replay.modelLogTitle")
        : availability.label;
      button.addEventListener("click", () => {
        if (!state.selectedModelKeys.includes(item.key)) {
          state.selectedModelKeys.push(item.key);
        }
        state.activeModelKey = item.key;
        _refreshComparison({ pause: false });
      });

      const swatch = document.createElement("i");
      swatch.className = "model-color";
      swatch.style.backgroundColor = _modelColor(item.key);
      const text = document.createElement("span");
      text.className = "model-label";
      const name = document.createElement("strong");
      name.textContent = _modelName(item.model);
      const meta = document.createElement("small");
      meta.textContent = Number.isFinite(result?.score)
        ? `${availability.label} · ${_t("common.points", {
          score: _formatScore(result.score),
        })}`
        : availability.label;
      text.append(name, meta);
      button.append(swatch, text);
      row.append(checkLabel, button);
      fragment.append(row);
    }
    elements.modelList.append(fragment);
  }

  /** @description Update the active model outcome and score summary */
  function _renderResultSummary() {
    const entry = _activeEntry();
    const result = entry?.result ?? null;
    const grading = result?.grading ?? {};
    let badgeClass = "badge-unfinished";
    let badgeText = _t("replay.noModelSelected");

    if (result) {
      if (result.status !== "success") {
        badgeClass = "badge-error";
        badgeText = _t("common.unavailable");
      } else if (result.format_valid === false) {
        badgeClass = "badge-error";
        badgeText = _t("common.formatError");
      } else if (grading.success) {
        badgeClass = "badge-success";
        badgeText = _t("common.completed");
      } else if (grading.death) {
        badgeClass = "badge-death";
        badgeText = _t("common.collision");
      } else {
        badgeText = _t("common.unreached");
      }
    }

    elements.outcomeBadge.className = `badge ${badgeClass}`;
    elements.outcomeBadge.textContent = badgeText;
    elements.activeModelName.textContent = entry
      ? _modelName(entry.model)
      : _t("replay.chooseModel");
    const mazeId = state.selectedMaze?.maze_id ?? "maze";
    const modelName = entry?.model.name ?? entry?.model.model_id ?? "models";
    elements.exportReplayButton.dataset.exportFilename = (
      `maze-bench-replay-${mazeId}-${modelName}.png`
    );
    elements.scoreValue.textContent = _formatScore(result?.score);
    elements.executedValue.textContent = Number.isInteger(
      grading.actual_action_count,
    )
      ? String(grading.actual_action_count)
      : "—";
    elements.optimalValue.textContent = Number.isInteger(
      grading.optimal_action_count,
    )
      ? String(grading.optimal_action_count)
      : "—";
  }

  /** @description Load one maze and reconstruct every available model replay */
  async function _loadSelectedMaze() {
    _pause();
    const sequence = ++state.loadSequence;
    const selectedMaze = state.mazeByKey.get(elements.replaySelect.value);
    const previousSelection = [...state.selectedModelKeys];
    const previousActive = state.activeModelKey;
    state.selectedMaze = selectedMaze ?? null;
    state.maze = null;
    state.optimalReplay = null;
    state.cursor = 0;
    state.entries = new Map(
      state.models.map((item) => [
        item.key,
        {
          key: item.key,
          model: item.model,
          result: _selectedResult(item.key),
          replay: null,
          loading: true,
          error: null,
        },
      ]),
    );
    _hideMessage();
    _clear(elements.mazeLayer);
    _clear(elements.optimalLayer);
    _clear(elements.routeLayer);
    _clear(elements.markerLayer);
    _renderModelList();
    _renderResultSummary();
    _renderCommandLog();
    _setReplayControlsEnabled(false);
    elements.optimalToggle.disabled = true;

    if (!selectedMaze) {
      _showMessage("replay.noSelectableMaze");
      return;
    }

    try {
      const sizeDirectory = `${selectedMaze.width}x${selectedMaze.height}`;
      const mazeUrl = `../maze_sets/${sizeDirectory}/${selectedMaze.maze_id}.json`;
      const response = await fetch(mazeUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const maze = await response.json();
      if (sequence !== state.loadSequence) {
        return;
      }

      const entries = new Map();
      for (const item of state.models) {
        const result = _selectedResult(item.key);
        let replay = null;
        let error = null;
        if (
          result?.status === "success"
          && result.format_valid === true
          && String(result.output ?? "").trim()
        ) {
          try {
            replay = core.simulateReplay(maze, result.output);
            const expectedMoves = result.grading?.actual_action_count;
            if (
              Number.isInteger(expectedMoves)
              && replay.successfulMoves !== expectedMoves
            ) {
              throw _error("replay.moveMismatch", {
                expected: expectedMoves,
                actual: replay.successfulMoves,
              });
            }
          } catch (replayError) {
            error = replayError instanceof Error
              ? replayError.message
              : String(replayError);
            replay = null;
          }
        }
        entries.set(item.key, {
          key: item.key,
          model: item.model,
          result,
          replay,
          loading: false,
          error,
        });
      }

      if (!Array.isArray(maze.answer_actions)) {
        throw _error("replay.noShortestCommands");
      }
      const optimalReplay = core.simulateReplay(maze, maze.answer_actions);
      if (
        optimalReplay.collision
        || optimalReplay.finalEvent !== "GOAL_OUT"
      ) {
        throw _error("replay.shortestDoesNotReach");
      }

      state.maze = maze;
      state.entries = entries;
      state.optimalReplay = optimalReplay;
      const availableKeys = state.models
        .map((item) => item.key)
        .filter((key) => entries.get(key)?.replay);
      let selectedKeys = previousSelection.filter((key) => availableKeys.includes(key));
      if (!state.selectionInitialized) {
        const requestedModelKey = state.models.find(
          (item) => (
            item.model.name === state.initialQuery.model
            && availableKeys.includes(item.key)
          ),
        )?.key;
        selectedKeys = requestedModelKey
          ? [requestedModelKey]
          : availableKeys.slice(0, 1);
      } else if (previousSelection.length > 0 && selectedKeys.length === 0) {
        selectedKeys = availableKeys.slice(0, 1);
      }
      state.selectionInitialized = true;
      state.selectedModelKeys = selectedKeys;
      state.activeModelKey = (
        previousActive
        && selectedKeys.includes(previousActive)
      )
        ? previousActive
        : selectedKeys[0] ?? null;

      _renderMaze();
      _renderOptimalRoute();
      _renderModelList();
      _renderResultSummary();
      _renderCommandLog();
      _setReplayControlsEnabled(selectedKeys.length > 0);
      elements.optimalToggle.disabled = false;
      _setCursor(0, false);
      _syncUrl();
      state.initialQuery = { size: null, maze: null, model: null };
      if (availableKeys.length === 0) {
        _showMessage("replay.noReplayableResults");
      }
    } catch (error) {
      if (sequence !== state.loadSequence) {
        return;
      }
      for (const entry of state.entries.values()) {
        entry.loading = false;
        entry.error = _errorText(error);
      }
      _renderModelList();
      _showErrorMessage("replay.mazeLoadFailure", error);
    }
  }

  /** @description Refresh route, log, and summary after model selection changes */
  function _refreshComparison(options = {}) {
    if (options.pause !== false) {
      _pause();
    }
    if (!state.selectedModelKeys.includes(state.activeModelKey)) {
      state.activeModelKey = state.selectedModelKeys[0] ?? null;
    }
    _renderModelList();
    _renderResultSummary();
    _renderCommandLog();
    _setReplayControlsEnabled(_selectedEntries().length > 0);
    _setCursor(state.cursor, false);
    _syncUrl();
  }

  /** @description Check whether a boundary is an exterior opening */
  function _isExteriorOpening(maze, x, y, side) {
    const matches = (cell, exteriorSide) => (
      Array.isArray(cell)
      && cell[0] === x
      && cell[1] === y
      && exteriorSide === side
    );
    return matches(maze.start_cell, maze.start_side)
      || matches(maze.goal_cell, maze.goal_side);
  }

  /** @description Add a wall line to the maze layer */
  function _appendWall(x1, y1, x2, y2) {
    elements.mazeLayer.append(_svgElement("line", {
      x1,
      y1,
      x2,
      y2,
      class: "maze-wall",
    }));
  }

  /** @description Draw an outside arrow */
  function _appendArrow(point, direction, className) {
    const rotation = ARROW_ROTATIONS[direction];
    elements.mazeLayer.append(_svgElement("polygon", {
      points: "0.46,0 -0.05,-0.36 -0.05,-0.16 -0.46,-0.16 "
        + "-0.46,0.16 -0.05,0.16 -0.05,0.36",
      class: `maze-arrow ${className}`,
      transform: `translate(${point[0]} ${point[1]}) rotate(${rotation})`,
    }));
  }

  /** @description Draw maze walls and outside arrows from structured JSON */
  function _renderMaze() {
    const maze = state.maze;
    _hideModelRouteTooltip();
    _clear(elements.mazeLayer);
    _clear(elements.optimalLayer);
    _clear(elements.routeLayer);
    _clear(elements.markerLayer);

    elements.mazeSvg.setAttribute(
      "viewBox",
      `${-VIEW_MARGIN} ${-VIEW_MARGIN} `
      + `${maze.width + VIEW_MARGIN * 2} ${maze.height + VIEW_MARGIN * 2}`,
    );
    elements.mazeLayer.append(_svgElement("rect", {
      x: -VIEW_MARGIN,
      y: -VIEW_MARGIN,
      width: maze.width + VIEW_MARGIN * 2,
      height: maze.height + VIEW_MARGIN * 2,
      class: "maze-background",
    }));

    for (let y = 0; y < maze.height; y += 1) {
      for (let x = 0; x < maze.width; x += 1) {
        const openings = new Set(maze.openings[`${x},${y}`] ?? []);
        if (
          y === 0
          && !openings.has("N")
          && !_isExteriorOpening(maze, x, y, "N")
        ) {
          _appendWall(x, y, x + 1, y);
        }
        if (
          x === 0
          && !openings.has("W")
          && !_isExteriorOpening(maze, x, y, "W")
        ) {
          _appendWall(x, y, x, y + 1);
        }
        if (
          !openings.has("E")
          && !_isExteriorOpening(maze, x, y, "E")
        ) {
          _appendWall(x + 1, y, x + 1, y + 1);
        }
        if (
          !openings.has("S")
          && !_isExteriorOpening(maze, x, y, "S")
        ) {
          _appendWall(x, y + 1, x + 1, y + 1);
        }
      }
    }

    _appendArrow(
      core.outsidePoint(maze.start_cell, maze.start_side),
      maze.initial_facing,
      "start-arrow",
    );
    _appendArrow(
      core.outsidePoint(maze.goal_cell, maze.goal_side),
      maze.goal_side,
      "goal-arrow",
    );
    const label = state.mazeLabels.get(_mazeKey(state.selectedMaze))
      ?? state.selectedMaze.maze_id;
    elements.mazeTitle.textContent = _t("replay.renderTitle", { label });
    elements.mazeDescription.textContent = _t("replay.renderDescription", {
      width: maze.width,
      height: maze.height,
    });
  }

  /** @description Draw or hide the full shortest route */
  function _renderOptimalRoute() {
    _clear(elements.optimalLayer);
    if (
      !elements.optimalToggle.checked
      || !state.optimalReplay
    ) {
      return;
    }
    for (const segment of state.optimalReplay.segments) {
      elements.optimalLayer.append(_svgElement("line", {
        x1: segment.from[0],
        y1: segment.from[1],
        x2: segment.to[0],
        y2: segment.to[1],
        class: "optimal-segment",
      }));
    }
  }

  /** @description Draw one model route at the shared command cursor */
  function _appendModelRoute(entry, isActive) {
    const replay = entry.replay;
    const cursor = Math.min(state.cursor, replay.terminalCursor);
    const color = _modelColor(entry.key);
    const modelName = _modelName(entry.model);
    const isDarkDeveloper = ["x-ai", "moonshotai"].includes(
      _modelDeveloper(entry.key).key,
    );
    const className = `${isActive
      ? "model-route is-active"
      : "model-route is-comparison"}${
      isDarkDeveloper ? " has-dark-developer-color" : ""
    }`;
    const routeGroup = _svgElement("g", {
      class: className,
      "data-model-key": entry.key,
      "data-model-name": modelName,
      style: `--model-route-color: ${color}`,
    });
    const markerGroup = _svgElement("g", {
      class: className,
      "data-model-key": entry.key,
      "data-model-name": modelName,
      style: `--model-route-color: ${color}`,
    });
    const visibleSegments = replay.segments.filter(
      (segment) => segment.index < cursor,
    );

    for (const segment of visibleSegments) {
      if (isDarkDeveloper) {
        routeGroup.append(_svgElement("line", {
          x1: segment.from[0],
          y1: segment.from[1],
          x2: segment.to[0],
          y2: segment.to[1],
          class: "model-route-halo",
        }));
      }
      routeGroup.append(_svgElement("line", {
        x1: segment.from[0],
        y1: segment.from[1],
        x2: segment.to[0],
        y2: segment.to[1],
        class: segment.goal
          ? "model-route-segment model-route-goal"
          : "model-route-segment",
      }));
    }

    const collision = replay.collision;
    const reachedCollision = collision && collision.index < cursor;
    if (reachedCollision) {
      const [x, y] = collision.point;
      const size = 0.22;
      routeGroup.append(_svgElement("line", {
        x1: collision.from[0],
        y1: collision.from[1],
        x2: x,
        y2: y,
        class: "model-route-segment model-route-collision",
      }));
      markerGroup.append(
        _svgElement("line", {
          x1: x - size,
          y1: y - size,
          x2: x + size,
          y2: y + size,
          class: "collision-mark",
        }),
        _svgElement("line", {
          x1: x + size,
          y1: y - size,
          x2: x - size,
          y2: y + size,
          class: "collision-mark",
        }),
      );
    } else {
      const lastVisible = visibleSegments.at(-1);
      const currentPoint = lastVisible?.to
        ?? core.eventPoint(state.maze, "START_OUT");
      markerGroup.append(_svgElement("circle", {
        cx: currentPoint[0],
        cy: currentPoint[1],
        r: 0.12,
        class: lastVisible?.goal
          ? "model-position-marker model-position-goal"
          : "model-position-marker",
      }));
    }

    elements.routeLayer.append(routeGroup);
    elements.markerLayer.append(markerGroup);
  }

  /** @description Draw every selected model route */
  function _renderRoutes() {
    _hideModelRouteTooltip();
    _clear(elements.routeLayer);
    _clear(elements.markerLayer);
    if (!state.maze) {
      return;
    }
    const entries = _selectedEntries().sort((first, second) => (
      Number(first.key === state.activeModelKey)
      - Number(second.key === state.activeModelKey)
    ));
    for (const entry of entries) {
      _appendModelRoute(entry, entry.key === state.activeModelKey);
    }
  }

  /** @description Return the display class for one command */
  function _commandStateClass(replay, index) {
    if (replay.collision) {
      if (index === replay.collision.index) {
        return "is-death";
      }
      if (index > replay.collision.index) {
        return "is-ignored";
      }
    }
    if (replay.successIndex !== null) {
      if (index === replay.successIndex) {
        return "is-goal";
      }
      if (index > replay.successIndex) {
        return "is-ignored";
      }
    }
    return "";
  }

  /** @description Render the active model command log */
  function _renderCommandLog() {
    const previousScrollBehavior = elements.commandLog.style.scrollBehavior;
    elements.commandLog.style.scrollBehavior = "auto";
    elements.commandLog.scrollLeft = 0;
    elements.commandLog.style.scrollBehavior = previousScrollBehavior;
    _clear(elements.commandLog);
    const entry = _activeEntry();
    const replay = entry?.replay;
    const actions = replay?.actions ?? [];
    if (actions.length === 0) {
      const empty = document.createElement("span");
      empty.className = "empty-log";
      empty.textContent = entry
        ? _t("replay.noCommands")
        : _t("replay.chooseModel");
      elements.commandLog.append(empty);
      window.requestAnimationFrame(_updateLogOverflow);
      return;
    }

    const fragment = document.createDocumentFragment();
    const individuallyRenderedCount = Math.min(
      actions.length,
      replay.terminalCursor ?? actions.length,
    );
    actions.slice(0, individuallyRenderedCount).forEach((action, index) => {
      const token = document.createElement("span");
      token.className = `command-token ${_commandStateClass(replay, index)}`.trim();
      token.dataset.index = String(index);
      token.textContent = action;
      token.title = _t("replay.moveTitle", {
        index: index + 1,
        action,
      });
      fragment.append(token);
    });
    if (individuallyRenderedCount < actions.length) {
      const ignoredTail = document.createElement("span");
      ignoredTail.className = "command-tail is-ignored";
      ignoredTail.textContent = actions.slice(individuallyRenderedCount).join(" ");
      fragment.append(ignoredTail);
    }
    elements.commandLog.append(fragment);
    window.requestAnimationFrame(_updateLogOverflow);
  }

  /** @description Show fades and arrow states only where more log content exists */
  function _updateLogOverflow() {
    const maximumScroll = Math.max(
      0,
      elements.commandLog.scrollWidth - elements.commandLog.clientWidth,
    );
    const canScrollLeft = elements.commandLog.scrollLeft > 1;
    const canScrollRight = elements.commandLog.scrollLeft < maximumScroll - 1;
    elements.commandLogFrame.classList.toggle("can-scroll-left", canScrollLeft);
    elements.commandLogFrame.classList.toggle("can-scroll-right", canScrollRight);
    elements.logLeftButton.disabled = !canScrollLeft;
    elements.logRightButton.disabled = !canScrollRight;
  }

  /** @description Keep the active command visible in a long log */
  function _scrollCurrentCommand() {
    const active = elements.commandLog.querySelector(".is-current");
    if (active) {
      active.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "center",
      });
    }
    window.requestAnimationFrame(_updateLogOverflow);
  }

  /** @description Set the shared command cursor */
  function _setCursor(nextCursor, scrollLog = true) {
    const total = _replayEnd();
    state.cursor = Math.min(total, Math.max(0, Math.trunc(Number(nextCursor) || 0)));
    elements.stepInput.value = String(state.cursor);
    elements.stepInput.max = String(total);
    elements.stepRange.value = String(state.cursor);
    elements.stepRange.max = String(total);
    elements.stepTotal.textContent = `/ ${total}`;

    const activeReplay = _activeEntry()?.replay;
    const activeCursor = activeReplay
      ? Math.min(state.cursor, activeReplay.terminalCursor)
      : 0;
    for (const token of elements.commandLog.querySelectorAll(".command-token")) {
      const index = Number(token.dataset.index);
      token.classList.toggle(
        "is-current",
        activeCursor > 0 && index === activeCursor - 1,
      );
    }

    _renderRoutes();
    if (scrollLog) {
      _scrollCurrentCommand();
    } else {
      _updateLogOverflow();
    }
    if (total === 0 || state.cursor >= total) {
      _pause();
    }
  }

  /** @description Start automatic playback at the selected speed */
  function _play() {
    const replayEnd = _replayEnd();
    if (replayEnd === 0) {
      return;
    }
    _pause();
    if (state.cursor >= replayEnd) {
      _setCursor(0);
    }

    const commandsPerSecond = Number(elements.speedSelect.value) || 2;
    state.timer = window.setInterval(() => {
      _setCursor(state.cursor + 1);
    }, 1000 / commandsPerSecond);
    elements.playButton.setAttribute("aria-pressed", "true");
    elements.playButton.setAttribute("aria-label", _t("replay.stop"));
    elements.playButton.textContent = `Ⅱ ${_t("replay.stop")}`;
  }

  /** @description Toggle automatic playback */
  function _togglePlayback() {
    if (state.timer === null) {
      _play();
    } else {
      _pause();
    }
  }

  /** @description Handle replay keyboard shortcuts outside editable controls */
  function _handleReplayShortcut(event) {
    const target = event.target;
    const isEditable = target instanceof HTMLElement
      && (
        target.matches("input, select, textarea")
        || target.isContentEditable
      );
    if (
      _replayEnd() === 0
      || isEditable
      || event.defaultPrevented
      || event.altKey
      || event.metaKey
    ) {
      return;
    }

    if (event.code === "Space") {
      event.preventDefault();
      if (!event.repeat) {
        _togglePlayback();
      }
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    _pause();
    if (event.ctrlKey) {
      _setCursor(event.key === "ArrowLeft" ? 0 : _replayEnd());
    } else {
      _setCursor(state.cursor + (event.key === "ArrowLeft" ? -1 : 1));
    }
  }

  /** @description Load and validate the public benchmark result file */
  async function _loadResults() {
    _setReplayControlsEnabled(false);
    try {
      const response = await fetch("benchmark_results.json", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      if (!Array.isArray(payload.results)) {
        throw _error("replay.resultsMissing");
      }
      if (payload.results.length === 0) {
        throw _error("replay.resultsEmpty");
      }

      _buildCatalog(payload);
      _populateSizes();
    } catch (error) {
      state.resultLoadError = error;
      elements.outcomeBadge.className = "badge badge-error";
      elements.outcomeBadge.textContent = _t("replay.loadFailure");
      elements.activeModelName.textContent = "benchmark_results.json";
      _showErrorMessage("replay.publicAutoLoadFailure", error);
    }
  }

  /** @description Refresh translated replay labels without reloading result data */
  function _renderLocale() {
    const expanded = elements.panelToggle.getAttribute("aria-expanded") === "true";
    _setPanelExpanded(expanded);

    const visibleMazes = state.mazes
      .filter((maze) => (
        `${maze.width}x${maze.height}` === elements.sizeSelect.value
      ))
      .sort((first, second) => first.maze_id.localeCompare(
        second.maze_id,
        i18n.getLocale(),
        { numeric: true },
      ));
    state.mazeLabels = new Map(
      visibleMazes.map((maze, index) => (
        [_mazeKey(maze), _mazeDisplayName(maze, index)]
      )),
    );
    for (const option of elements.replaySelect.options) {
      const maze = state.mazeByKey.get(option.value);
      if (!maze) {
        continue;
      }
      const label = state.mazeLabels.get(option.value);
      option.textContent = label;
      option.setAttribute("aria-label", _t("common.originalId", {
        label,
        id: maze.maze_id,
      }));
    }

    _renderModelList();
    _renderResultSummary();
    _renderCommandLog();
    if (state.maze) {
      _renderMaze();
      _renderOptimalRoute();
      _setCursor(state.cursor, false);
    }
    if (state.timer === null) {
      _pause();
    } else {
      elements.playButton.setAttribute("aria-label", _t("replay.stop"));
      elements.playButton.textContent = `Ⅱ ${_t("replay.stop")}`;
    }
    _renderMessage();
    if (state.resultLoadError !== null) {
      elements.outcomeBadge.textContent = _t("replay.loadFailure");
    }
  }

  /** @description Register all replay interactions */
  function _bindEvents() {
    elements.panelToggle.addEventListener("click", () => {
      const expanded = elements.panelToggle.getAttribute("aria-expanded") === "true";
      _setPanelExpanded(!expanded);
    });
    portraitLayout.addEventListener("change", _syncResponsivePanel);
    elements.sizeSelect.addEventListener("change", _populateReplays);
    elements.replaySelect.addEventListener("change", () => void _loadSelectedMaze());
    elements.modelSearch.addEventListener("input", _renderModelList);
    elements.allModelsBulkButton.addEventListener("click", () => {
      _toggleBulkModels(_availableModelKeys());
    });
    document.addEventListener("pointerdown", (event) => {
      if (
        elements.developerPicker.open
        && !elements.developerPicker.contains(event.target)
      ) {
        elements.developerPicker.removeAttribute("open");
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && elements.developerPicker.open) {
        elements.developerPicker.removeAttribute("open");
        elements.developerPicker.querySelector("summary").focus();
      }
    });
    elements.optimalToggle.addEventListener("change", _renderOptimalRoute);
    elements.mazeSvg.addEventListener("pointerover", (event) => {
      const target = _modelRouteTarget(event.target);
      if (target) {
        _showModelRouteTooltip(target, event.clientX, event.clientY);
      }
    });
    elements.mazeSvg.addEventListener("pointermove", (event) => {
      if (!elements.modelRouteTooltip.hidden) {
        _positionModelRouteTooltip(event.clientX, event.clientY);
      }
    });
    elements.mazeSvg.addEventListener("pointerout", (event) => {
      const currentTarget = _modelRouteTarget(event.target);
      if (!currentTarget) {
        return;
      }
      const nextTarget = _modelRouteTarget(event.relatedTarget);
      if (nextTarget?.dataset.modelKey !== currentTarget.dataset.modelKey) {
        _hideModelRouteTooltip();
      }
    });
    elements.mazeSvg.addEventListener("pointerleave", _hideModelRouteTooltip);
    elements.firstButton.addEventListener("click", () => {
      _pause();
      _setCursor(0);
    });
    elements.previousButton.addEventListener("click", () => {
      _pause();
      _setCursor(state.cursor - 1);
    });
    elements.playButton.addEventListener("click", _togglePlayback);
    elements.nextButton.addEventListener("click", () => {
      _pause();
      _setCursor(state.cursor + 1);
    });
    elements.lastButton.addEventListener("click", () => {
      _pause();
      _setCursor(_replayEnd());
    });
    elements.speedSelect.addEventListener("change", () => {
      if (state.timer !== null) {
        _play();
      }
    });
    elements.stepInput.addEventListener("change", () => {
      _pause();
      _setCursor(elements.stepInput.value);
    });
    elements.stepRange.addEventListener("input", () => {
      _pause();
      _setCursor(elements.stepRange.value);
    });
    elements.logLeftButton.addEventListener("click", () => {
      elements.commandLog.scrollBy({ left: -280, behavior: "smooth" });
    });
    elements.logRightButton.addEventListener("click", () => {
      elements.commandLog.scrollBy({ left: 280, behavior: "smooth" });
    });
    elements.commandLog.addEventListener("scroll", _updateLogOverflow);
    elements.commandLog.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }
      elements.commandLog.dataset.dragPointer = String(event.pointerId);
      elements.commandLog.dataset.dragStartX = String(event.clientX);
      elements.commandLog.dataset.dragStartScroll = String(
        elements.commandLog.scrollLeft,
      );
      elements.commandLog.classList.add("is-dragging");
      elements.commandLog.setPointerCapture(event.pointerId);
    });
    elements.commandLog.addEventListener("pointermove", (event) => {
      if (elements.commandLog.dataset.dragPointer !== String(event.pointerId)) {
        return;
      }
      const startX = Number(elements.commandLog.dataset.dragStartX);
      const startScroll = Number(elements.commandLog.dataset.dragStartScroll);
      elements.commandLog.scrollLeft = startScroll - (event.clientX - startX);
    });
    const finishLogDrag = (event) => {
      if (elements.commandLog.dataset.dragPointer !== String(event.pointerId)) {
        return;
      }
      delete elements.commandLog.dataset.dragPointer;
      delete elements.commandLog.dataset.dragStartX;
      delete elements.commandLog.dataset.dragStartScroll;
      elements.commandLog.classList.remove("is-dragging");
    };
    elements.commandLog.addEventListener("pointerup", finishLogDrag);
    elements.commandLog.addEventListener("pointercancel", finishLogDrag);
    elements.commandLog.addEventListener("lostpointercapture", finishLogDrag);
    document.addEventListener("keydown", _handleReplayShortcut);
    window.addEventListener("resize", _updateLogOverflow);
    if ("ResizeObserver" in window) {
      const logResizeObserver = new ResizeObserver(_updateLogOverflow);
      logResizeObserver.observe(elements.commandLogFrame);
    }
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        _pause();
      }
    });
    globalThis.addEventListener(i18n.LOCALE_EVENT, _renderLocale);
  }

  if (!data) {
    _showMessage("common.dataModuleFailure");
    return;
  }
  if (!core) {
    _showMessage("replay.coreFailure");
    return;
  }

  _syncResponsivePanel(portraitLayout);
  _bindEvents();
  void _loadResults();
}());
