/**
 * @file human-site/web/app.js
 * @description 사람 플레이 화면과 세션 상태 관리
 */

(() => {
  "use strict";

  const BROWSER_ID_KEY = "maze-bench-human-browser-id";
  const LOCALE_KEY = "maze-bench-locale";
  const THEME_KEY = "maze-bench-theme";
  const LEGACY_PENDING_REQUEST_KEY = "maze-bench-human-pending-request";
  const DRAFT_KEY_PREFIX = "maze-bench-human-draft:";
  const TUTORIAL_KEY = "maze-bench-human-tutorial-seen";
  const MAX_ZOOM = 3;
  const MIN_ZOOM = 0.7;
  const REPLAY_INTERVAL_MS = 520;
  const TUTORIAL_SCENE_INTERVAL_MS = 3200;
  const TUTORIAL_SCENES = [
    { key: "tutorial.sceneStart", action: "S", from: [44, 160, 90], to: [112, 160, 90] },
    { key: "tutorial.sceneLeft", action: "L", from: [112, 160, 90], to: [112, 110, 0] },
    { key: "tutorial.sceneRight", action: "R", from: [112, 110, 0], to: [204, 110, 90] },
    { key: "tutorial.sceneDeadEnd", action: "R", from: [204, 110, 90], to: [204, 170, 180] },
    { key: "tutorial.sceneBack", action: "B", from: [204, 170, 180], to: [204, 110, 0] },
    { key: "tutorial.sceneCollision", action: "S", from: [204, 170, 180], to: [204, 170, 180], collision: true },
    { key: "tutorial.sceneExitTurn", action: "R", from: [204, 52, 0], to: [326, 52, 90] },
    { key: "tutorial.sceneExit", action: "S", from: [326, 52, 90], to: [346, 52, 90] },
  ];
  const ACTIONS = {
    S: { symbol: "↑", labelKey: "action.straight", key: "ArrowUp" },
    B: { symbol: "↓", labelKey: "action.back", key: "ArrowDown" },
    L: { symbol: "←", labelKey: "action.left", key: "ArrowLeft" },
    R: { symbol: "→", labelKey: "action.right", key: "ArrowRight" },
  };
  const KEY_ACTIONS = {
    ArrowUp: "S",
    ArrowDown: "B",
    ArrowLeft: "L",
    ArrowRight: "R",
  };
  const COPY = {
    ko: {
      "brand.eyebrow": "MAZE BENCH",
      "brand.repository": "Maze Bench GitHub 저장소 (새 탭)",
      "brand.leaderboard": "Maze Bench 리더보드",
      "page.title": "사람 플레이",
      "language.group": "언어 선택",
      "language.switchKo": "한국어로 전환",
      "language.switchEn": "영어로 전환",
      "theme.switchDark": "어두운 테마로 전환",
      "theme.switchLight": "밝은 테마로 전환",
      "maze.label": "미로",
      "replay.label": "경로 재생",
      "maze.alt": "사람이 직접 풀 미로",
      "maze.zoomGroup": "미로 확대/축소",
      "zoom.in": "미로 확대",
      "zoom.out": "미로 축소",
      "zoom.reset": "확대 초기화",
      "placeholder.loadingTitle": "진행 상태를 불러오는 중입니다",
      "placeholder.loadingText": "잠시만 기다려 주세요.",
      "placeholder.startTitle": "AI와 같은 조건으로 도전하기",
      "placeholder.startTextPrefix": "화면에 손가락을 대거나 포인터·메모로 위치를 표시하지 않고, ",
      "placeholder.startTextEmphasis": "머릿속으로만",
      "placeholder.startTextSuffix": " 위치와 방향을 따라가기를 권장해요.",
      "placeholder.exhaustedTitle": "플레이할 미로를 모두 완료했습니다",
      "placeholder.exhaustedText": "모든 미로에 도전해 주셔서 감사합니다.",
      "placeholder.errorTitle": "진행 상태를 불러오지 못했습니다",
      "placeholder.errorText": "연결을 복구하고 상태를 다시 불러오려면 조작 패널을 이용해 주세요.",
      "attempt.active": "진행 중",
      "attempt.success": "성공",
      "attempt.collision": "충돌",
      "attempt.quit": "종료",
      "counter.label": "이동 횟수",
      "controls.hint": "방향 버튼이나 키보드 화살표로 입력하세요.",
      "controls.group": "이동 입력",
      "controls.panel": "미로 조작",
      "action.straight": "전진",
      "action.back": "후진",
      "action.left": "좌회전",
      "action.right": "우회전",
      "rules.title": "기본 규칙",
      "rules.irreversible": "입력은 되돌릴 수 없습니다.",
      "rules.oneAttempt": "미로마다 한 번만 도전할 수 있습니다.",
      "rules.resume": "도중에 나가도 진행 상태가 저장되어 이어서 풀 수 있습니다.",
      "tutorial.open": "조작 방법 보기",
      "tutorial.title": "조작 방법",
      "tutorial.intro": "실제 플레이에서는 현재 위치가 표시되지 않아요.",
      "tutorial.illustration": "설명용 미로",
      "tutorial.mazeAlt": "이동 입력을 설명하는 예시 미로",
      "tutorial.actions": "조작 예시",
      "tutorial.skip": "건너뛰기",
      "tutorial.replay": "다시 보기",
      "tutorial.close": "닫기",
      "tutorial.previous": "이전 장면",
      "tutorial.next": "다음 장면",
      "tutorial.sceneStart": "파란 화살표에서 다음 모퉁이까지 한 번에 전진해요.",
      "tutorial.sceneLeft": "바라보는 방향에서 왼쪽으로 꺾어 이동해요.",
      "tutorial.sceneRight": "바라보는 방향에서 오른쪽으로 꺾어 이동해요.",
      "tutorial.sceneDeadEnd": "갈림길에서 우회전하면 아래쪽 통로를 따라 막다른 곳까지 가요.",
      "tutorial.sceneBack": "후진하면 반대 방향으로 돌아서 다음 갈림길까지 이동해요.",
      "tutorial.sceneCollision": "충돌 예시예요. 벽을 향해 입력하면 도전이 끝나요.",
      "tutorial.sceneExitTurn": "탈출 예시예요. 오른쪽 출구로 방향을 틀어 이동해요.",
      "tutorial.sceneExit": "빨간 화살표가 가리키는 바깥쪽 출구에 도착하면 성공이에요.",
      "status.starting": "새 미로를 준비하고 있어요…",
      "actionStatus.processing": "{action} 입력을 처리하고 있습니다…",
      "actionStatus.accepted": "입력을 반영했습니다.",
      "actionStatus.quitProcessing": "종료 요청을 처리하고 있습니다…",
      "actionStatus.uncertain": "서버 응답을 확인하지 못했습니다. 연결 상태를 복구해 주세요.",
      "finalStatus.saving": "결과를 저장하고 있어요…",
      "finalStatus.saved": "결과를 저장했어요.",
      "finalStatus.retry": "결과를 저장하지 못했어요. 같은 결과를 다시 저장해 주세요.",
      "actionStatus.idle": "",
      "history.title": "입력 기록",
      "history.empty": "입력한 이동이 여기에 표시됩니다.",
      "history.label": "누적 입력 기록",
      "button.start": "미로 시작",
      "button.quit": "그만두기",
      "button.next": "다음 미로",
      "button.exhausted": "모든 미로 완료",
      "button.restore": "상태 다시 불러오기",
      "button.retrySame": "같은 요청 다시 보내기",
      "button.replayFirst": "처음으로",
      "button.replayPrevious": "이전 이동",
      "button.replayPlay": "경로 재생",
      "button.replayPause": "재생 멈춤",
      "button.replayNext": "다음 이동",
      "button.replayLast": "마지막으로",
      "button.replayRange": "경로 위치",
      "status.network": "서버에 연결하지 못했습니다. 연결을 확인한 뒤 상태를 다시 불러오거나 같은 요청을 다시 보내 주세요.",
      "status.invalidResponse": "서버 응답을 읽지 못했습니다. 상태를 다시 불러와 결과를 확인해 주세요.",
      "status.http": "서버가 요청을 처리하지 못했습니다 (HTTP {status}). 상태를 다시 불러와 주세요.",
      "status.conflict": "다른 탭의 입력으로 진행 상태가 바뀌었습니다. 기록을 확인한 뒤 이어서 진행해 주세요.",
      "status.conflictCode": "다른 탭의 입력으로 진행 상태가 바뀌었습니다. 오류 코드: {code}",
      "status.changedElsewhere": "다른 탭에서 미로가 바뀌었습니다. 현재 미로와 입력 기록을 확인해 주세요.",
      "status.imageLoading": "미로 이미지를 불러오는 중입니다…",
      "status.imageError": "미로 이미지를 불러오지 못했습니다. 연결을 확인하고 상태를 다시 불러와 주세요.",
      "status.replayProgress": "{current} / {total}",
      "terminal.title.success": "출구에 도착했습니다",
      "terminal.title.collision": "벽에 부딪혔습니다",
      "terminal.title.quit": "플레이를 종료했습니다",
      "terminal.score": "점수 {score}",
      "terminal.successfulMoves": "성공한 이동",
      "terminal.remainingMoves": "남은 최단 이동",
      "confirm.quit": "현재 플레이를 종료할까요? 종료하면 이 미로를 이어서 풀 수 없습니다.",
    },
    en: {
      "brand.eyebrow": "MAZE BENCH",
      "brand.repository": "Maze Bench GitHub repository (new tab)",
      "brand.leaderboard": "Maze Bench leaderboard",
      "page.title": "Play a maze",
      "language.group": "Choose language",
      "language.switchKo": "Switch to Korean",
      "language.switchEn": "Switch to English",
      "theme.switchDark": "Switch to dark theme",
      "theme.switchLight": "Switch to light theme",
      "maze.label": "Maze",
      "replay.label": "Path replay",
      "maze.alt": "Maze to solve",
      "maze.zoomGroup": "Zoom controls",
      "zoom.in": "Zoom in on maze",
      "zoom.out": "Zoom out on maze",
      "zoom.reset": "Reset zoom",
      "placeholder.loadingTitle": "Restoring your progress",
      "placeholder.loadingText": "Please wait a moment.",
      "placeholder.startTitle": "Challenge the maze on the same terms as the AI",
      "placeholder.startTextPrefix": "To match the AI's conditions, follow positions and directions ",
      "placeholder.startTextEmphasis": "in your head",
      "placeholder.startTextSuffix": " without touching the screen or marking them with a pointer or notes.",
      "placeholder.exhaustedTitle": "You have completed every available maze",
      "placeholder.exhaustedText": "Thank you for taking on every maze.",
      "placeholder.errorTitle": "Couldn't restore your progress",
      "placeholder.errorText": "Use the control panel to restore your progress after checking the connection.",
      "attempt.active": "In progress",
      "attempt.success": "Success",
      "attempt.collision": "Collision",
      "attempt.quit": "Quit",
      "counter.label": "Moves",
      "controls.hint": "Use the direction buttons or keyboard arrow keys.",
      "controls.group": "Move controls",
      "controls.panel": "Maze controls",
      "action.straight": "Forward",
      "action.back": "Back",
      "action.left": "Turn left",
      "action.right": "Turn right",
      "rules.title": "Essentials",
      "rules.irreversible": "Commands cannot be undone.",
      "rules.oneAttempt": "Each maze gives you one attempt.",
      "rules.resume": "Your progress is saved, so you can resume later.",
      "tutorial.open": "How to play",
      "tutorial.title": "How to play",
      "tutorial.intro": "Your current position stays hidden during the actual game.",
      "tutorial.illustration": "Illustrative maze",
      "tutorial.mazeAlt": "Example maze illustrating movement commands",
      "tutorial.actions": "Movement examples",
      "tutorial.skip": "Skip",
      "tutorial.replay": "Replay",
      "tutorial.close": "Close",
      "tutorial.previous": "Previous scene",
      "tutorial.next": "Next scene",
      "tutorial.sceneStart": "Move from the blue arrow to the next corner with one Forward command.",
      "tutorial.sceneLeft": "Turn left from the direction you face, then move along the corridor.",
      "tutorial.sceneRight": "Turn right from the direction you face, then move along the corridor.",
      "tutorial.sceneDeadEnd": "Turn right at the junction and follow the corridor to its dead end.",
      "tutorial.sceneBack": "Back turns you around and moves to the next junction.",
      "tutorial.sceneCollision": "Collision example: a command into a wall ends the attempt.",
      "tutorial.sceneExitTurn": "Exit example: turn right and move toward the exit.",
      "tutorial.sceneExit": "The red arrow marks the exit. Move outside in its direction to finish.",
      "status.starting": "Preparing a maze…",
      "actionStatus.processing": "Processing {action}…",
      "actionStatus.accepted": "Input accepted.",
      "actionStatus.quitProcessing": "Processing the quit request…",
      "actionStatus.uncertain": "The server response is unknown. Restore the connection to continue.",
      "finalStatus.saving": "Saving result…",
      "finalStatus.saved": "Result saved.",
      "finalStatus.retry": "Couldn't save the result. Retry saving the same result.",
      "actionStatus.idle": "",
      "history.title": "Input history",
      "history.empty": "Your accepted moves will appear here.",
      "history.label": "Accepted move history",
      "button.start": "Start maze",
      "button.quit": "Quit",
      "button.next": "Next maze",
      "button.exhausted": "All mazes completed",
      "button.restore": "Restore server state",
      "button.retrySame": "Retry the same request",
      "button.replayFirst": "Go to start",
      "button.replayPrevious": "Previous move",
      "button.replayPlay": "Play path",
      "button.replayPause": "Pause playback",
      "button.replayNext": "Next move",
      "button.replayLast": "Go to end",
      "button.replayRange": "Path position",
      "status.network": "Couldn't connect to the server. Check your connection, then restore the server state or resend the same request.",
      "status.invalidResponse": "Couldn't read the server response. Restore the server state to check the result.",
      "status.http": "The server couldn't process the request (HTTP {status}). Restore the server state.",
      "status.conflict": "Progress changed in another tab. Check the input history before continuing.",
      "status.conflictCode": "Progress changed in another tab. Error code: {code}",
      "status.changedElsewhere": "Another tab changed the maze. Check the current maze and input history.",
      "status.imageLoading": "Loading the maze image…",
      "status.imageError": "Couldn't load the maze image. Check the connection and restore the server state.",
      "status.replayProgress": "{current} / {total}",
      "terminal.title.success": "You reached the exit",
      "terminal.title.collision": "You hit a wall",
      "terminal.title.quit": "You quit this maze",
      "terminal.score": "Score {score}",
      "terminal.successfulMoves": "Successful moves",
      "terminal.remainingMoves": "Shortest moves remaining",
      "confirm.quit": "Quit this attempt? You won't be able to resume this maze.",
    },
  };

  const state = {
    locale: "ko",
    theme: "light",
    browserId: "",
    attempt: null,
    hiddenCompletedAttemptId: null,
    exhausted: false,
    sessionLoaded: false,
    syncing: false,
    starting: false,
    sendingLegacyRequest: false,
    savingCompletion: false,
    completionFailed: false,
    uncertain: false,
    pendingLegacyRequest: null,
    pendingCompletion: null,
    draftRecord: null,
    actionStatus: null,
    replay: null,
    replayCursor: 0,
    replayTimer: null,
    tutorialSceneIndex: 0,
    tutorialTimer: null,
    tutorialFrame: null,
    renderedMoveCount: 0,
    counterFrame: null,
    counterAnimationCount: null,
    counterTransitionHandler: null,
    zoom: 1,
    imageFailed: false,
    loadFailed: false,
  };

  const elements = {
    githubLink: document.querySelector("#githubLink"),
    leaderboardLink: document.querySelector("#leaderboardLink"),
    pageTitle: document.querySelector("#pageTitle"),
    localeButtons: [...document.querySelectorAll("[data-locale]")],
    themeToggle: document.querySelector("#themeToggle"),
    mazeToolbar: document.querySelector("#mazeToolbar"),
    mazeViewport: document.querySelector("#mazeViewport"),
    mazePlaceholder: document.querySelector("#mazePlaceholder"),
    placeholderTitle: document.querySelector("#placeholderTitle"),
    placeholderText: document.querySelector("#placeholderText"),
    mazeCanvas: document.querySelector("#mazeCanvas"),
    mazeImage: document.querySelector("#mazeImage"),
    routeSvg: document.querySelector("#routeSvg"),
    terminalSummary: document.querySelector("#terminalSummary"),
    terminalTitle: document.querySelector("#terminalTitle"),
    terminalScore: document.querySelector("#terminalScore"),
    terminalDetails: document.querySelector("#terminalDetails"),
    replayFirst: document.querySelector("#replayFirst"),
    replayPrevious: document.querySelector("#replayPrevious"),
    replayPlay: document.querySelector("#replayPlay"),
    replayNext: document.querySelector("#replayNext"),
    replayLast: document.querySelector("#replayLast"),
    replayRange: document.querySelector("#replayRange"),
    replayPosition: document.querySelector("#replayPosition"),
    languageGroup: document.querySelector(".language-switch"),
    zoomGroup: document.querySelector(".zoom-controls"),
    replayGroup: document.querySelector("#replayControls"),
    moveLabel: document.querySelector("#moveLabel"),
    moveCount: document.querySelector("#moveCount"),
    actionPad: document.querySelector("#actionPad"),
    controlPanel: document.querySelector(".control-panel"),
    actionButtons: [...document.querySelectorAll("[data-action]")],
    actionStatus: document.querySelector("#actionStatus"),
    historyTitle: document.querySelector("#historyTitle"),
    historyScroll: document.querySelector("#historyScroll"),
    historyList: document.querySelector("#historyList"),
    historyEmpty: document.querySelector("#historyEmpty"),
    historyTotal: document.querySelector("#historyTotal"),
    startButton: document.querySelector("#startButton"),
    tutorialOpen: document.querySelector("#tutorialOpen"),
    tutorialDialog: document.querySelector("#controlTutorial"),
    tutorialCaption: document.querySelector("#tutorialCaption"),
    tutorialActionGroup: document.querySelector("#tutorialActionGroup"),
    tutorialMarker: document.querySelector("#tutorialMarker"),
    tutorialCollision: document.querySelector("#tutorialCollision"),
    tutorialProgress: document.querySelector("#tutorialProgress"),
    tutorialPrevious: document.querySelector("#tutorialPrevious"),
    tutorialNext: document.querySelector("#tutorialNext"),
    tutorialSkip: document.querySelector("#tutorialSkip"),
    tutorialReplay: document.querySelector("#tutorialReplay"),
    tutorialClose: document.querySelector("#tutorialClose"),
    moveCountWindow: document.querySelector("#moveCountWindow"),
    quitButton: document.querySelector("#quitButton"),
    nextButton: document.querySelector("#nextButton"),
    recoveryActions: document.querySelector("#recoveryActions"),
    restoreButton: document.querySelector("#restoreButton"),
    retryButton: document.querySelector("#retryButton"),
    zoomOut: document.querySelector("#zoomOut"),
    zoomReset: document.querySelector("#zoomReset"),
    zoomIn: document.querySelector("#zoomIn"),
  };

  /** @description Return translated copy with named values substituted */
  function _t(key, parameters = {}) {
    const template = COPY[state.locale][key];
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
      Object.hasOwn(parameters, name) ? String(parameters[name]) : match
    ));
  }

  /** @description Load the browser identifier shared by this browser's tabs */
  function _loadBrowserId() {
    let browserId = localStorage.getItem(BROWSER_ID_KEY);
    if (!browserId) {
      browserId = crypto.randomUUID();
      localStorage.setItem(BROWSER_ID_KEY, browserId);
    }
    return browserId;
  }

  /** @description Restore an unresolved legacy request from the previous page flow */
  function _loadLegacyPendingRequest() {
    const saved = sessionStorage.getItem(LEGACY_PENDING_REQUEST_KEY);
    state.pendingLegacyRequest = saved ? JSON.parse(saved) : null;
  }

  /** @description Return the local draft key scoped to this browser and attempt */
  function _draftKey(attemptId) {
    return DRAFT_KEY_PREFIX + state.browserId + ":" + attemptId;
  }

  /** @description Load one attempt draft from local storage */
  function _loadDraft(attemptId) {
    const saved = localStorage.getItem(_draftKey(attemptId));
    return saved ? JSON.parse(saved) : null;
  }

  /** @description Restore a final payload left unresolved by a reload */
  function _loadPendingCompletion() {
    const prefix = DRAFT_KEY_PREFIX + state.browserId + ":";
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key.startsWith(prefix)) continue;
      const record = JSON.parse(localStorage.getItem(key));
      if (!record.finalPayload) continue;
      state.draftRecord = record;
      state.pendingCompletion = {
        attemptId: record.attemptId,
        payload: record.finalPayload,
      };
      state.attempt = _localAttempt(record);
      state.replay = MazeReplayCore.simulateReplay(state.attempt.problem, state.attempt.actions);
      state.replayCursor = state.replay.terminalCursor;
      return;
    }
  }

  /** @description Persist the current accepted actions and optional final payload */
  function _saveDraft(attempt, actions, finalPayload = null) {
    const record = {
      attemptId: attempt.id,
      actions,
      problem: attempt.problem,
      finalPayload,
    };
    localStorage.setItem(_draftKey(attempt.id), JSON.stringify(record));
    state.draftRecord = record;
    return record;
  }

  /** @description Build the locally visible terminal attempt from its saved payload */
  function _localAttempt(record) {
    const replay = MazeReplayCore.simulateReplay(record.problem, record.actions);
    const status = record.finalPayload.quit
      ? "quit"
      : replay.successIndex !== null
        ? "success"
        : "collision";
    return {
      id: record.attemptId,
      actions: record.actions,
      status,
      problem: record.problem,
    };
  }

  /** @description Apply the selected language and its accessible labels */
  function _applyLocale() {
    document.documentElement.lang = state.locale;
    document.title = "Maze Bench — " + _t("page.title");
    elements.githubLink.setAttribute("aria-label", _t("brand.repository"));
    elements.leaderboardLink.setAttribute("aria-label", _t("brand.leaderboard"));
    for (const element of document.querySelectorAll("[data-copy]")) {
      element.textContent = _t(element.dataset.copy);
    }
    for (const button of elements.localeButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.locale === state.locale));
      button.setAttribute(
        "aria-label",
        _t(button.dataset.locale === "ko" ? "language.switchKo" : "language.switchEn"),
      );
    }
    elements.themeToggle.setAttribute(
      "aria-label",
      _t(state.theme === "dark" ? "theme.switchLight" : "theme.switchDark"),
    );
    elements.themeToggle.title = _t(
      state.theme === "dark" ? "theme.switchLight" : "theme.switchDark",
    );
    elements.themeToggle.setAttribute("aria-pressed", String(state.theme === "dark"));
    elements.themeToggle.querySelector("[data-theme-icon]").textContent = (
      state.theme === "dark" ? "☀" : "☾"
    );
    elements.mazeViewport.setAttribute("aria-label", _t("maze.label"));
    elements.actionPad.setAttribute("aria-label", _t("controls.group"));
    elements.controlPanel.setAttribute("aria-label", _t("controls.panel"));
    elements.historyScroll.setAttribute("aria-label", _t("history.label"));
    elements.tutorialActionGroup.setAttribute("aria-label", _t("tutorial.actions"));
    elements.languageGroup.setAttribute("aria-label", _t("language.group"));
    elements.zoomGroup.setAttribute("aria-label", _t("maze.zoomGroup"));
    elements.replayGroup.setAttribute("aria-label", _t("replay.label"));
    elements.mazeImage.alt = _t("maze.alt");
    elements.zoomIn.setAttribute("aria-label", _t("zoom.in"));
    elements.zoomIn.title = _t("zoom.in");
    elements.zoomOut.setAttribute("aria-label", _t("zoom.out"));
    elements.zoomOut.title = _t("zoom.out");
    elements.zoomReset.setAttribute("aria-label", _t("zoom.reset"));
    elements.zoomReset.title = _t("zoom.reset");
    elements.startButton.textContent = _t("button.start");
    elements.quitButton.textContent = _t("button.quit");
    elements.nextButton.textContent = state.exhausted
      ? _t("button.exhausted")
      : _t("button.next");
    elements.restoreButton.textContent = _t("button.restore");
    elements.retryButton.textContent = _t("button.retrySame");
    elements.replayFirst.setAttribute("aria-label", _t("button.replayFirst"));
    elements.replayPrevious.setAttribute("aria-label", _t("button.replayPrevious"));
    elements.replayPlay.setAttribute(
      "aria-label",
      state.replayTimer === null ? _t("button.replayPlay") : _t("button.replayPause"),
    );
    elements.replayNext.setAttribute("aria-label", _t("button.replayNext"));
    elements.replayLast.setAttribute("aria-label", _t("button.replayLast"));
    elements.replayRange.setAttribute("aria-label", _t("button.replayRange"));
    for (const element of document.querySelectorAll("[data-action-label]")) {
      element.textContent = _t(ACTIONS[element.dataset.actionLabel].labelKey);
    }
    for (const button of elements.actionButtons) {
      button.setAttribute("aria-label", _t(ACTIONS[button.dataset.action].labelKey));
    }
    elements.tutorialCaption.textContent = _t(TUTORIAL_SCENES[state.tutorialSceneIndex].key);
  }

  /** @description Apply a supported language and save it for the next visit */
  function _setLocale(locale) {
    state.locale = locale;
    localStorage.setItem(LOCALE_KEY, locale);
    _render();
  }

  /** @description Apply a supported theme and save it for the next visit */
  function _setTheme(theme) {
    state.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    _render();
  }

  /** @description Read one JSON response at the API boundary */
  async function _apiRequest(path, method = "GET", body = undefined) {
    const headers = { "X-Browser-ID": state.browserId };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    let response;
    try {
      response = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: method === "GET" ? "no-store" : "default",
      });
    } catch {
      return { failure: "network" };
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      return { failure: "invalidResponse" };
    }
    return { response, payload };
  }

  /** @description Reconcile the server prefix with a locally saved attempt draft */
  function _mergeDraftActions(serverActions, draftActions) {
    if (serverActions.every((action, index) => action === draftActions[index])) {
      return draftActions;
    }
    if (draftActions.every((action, index) => action === serverActions[index])) {
      return serverActions;
    }
    return serverActions;
  }

  /** @description Store server progress and restore a matching local draft */
  function _applyServerState(payload) {
    const previous = state.attempt;
    const serverAttempt = payload.attempt;
    if (state.pendingCompletion && serverAttempt?.id !== state.pendingCompletion.attemptId) {
      state.exhausted = payload.exhausted;
      state.sessionLoaded = true;
      state.syncing = false;
      state.starting = false;
      state.loadFailed = false;
      _render();
      return;
    }
    const storedDraft = serverAttempt ? _loadDraft(serverAttempt.id) : null;
    const draft = state.pendingCompletion?.attemptId === serverAttempt?.id
      ? state.draftRecord
      : storedDraft;
    if (draft?.finalPayload) {
      state.pendingCompletion = {
        attemptId: draft.attemptId,
        payload: draft.finalPayload,
      };
    }
    const hasPendingFinal = state.pendingCompletion?.attemptId === serverAttempt?.id;
    if (
      !state.sessionLoaded
      && serverAttempt
      && serverAttempt.status !== "active"
      && !hasPendingFinal
    ) {
      state.hiddenCompletedAttemptId = serverAttempt.id;
    }
    let attempt = serverAttempt?.id === state.hiddenCompletedAttemptId && !hasPendingFinal
      ? null
      : serverAttempt;
    if (attempt && draft) {
      if (draft.finalPayload) {
        attempt = _localAttempt(draft);
      } else if (attempt.status === "active") {
        attempt = {
          ...attempt,
          actions: _mergeDraftActions(attempt.actions, draft.actions),
        };
      }
    }
    const changedAttempt = previous?.id !== attempt?.id;
    const changedStatus = previous?.status !== attempt?.status;
    const changedCount = previous?.actions.length !== attempt?.actions.length;
    if (state.imageFailed && attempt && previous?.id === attempt.id) {
      elements.mazeImage.removeAttribute("src");
    }
    state.attempt = attempt;
    state.draftRecord = draft;
    state.exhausted = payload.exhausted;
    state.sessionLoaded = true;
    state.syncing = false;
    state.starting = false;
    state.loadFailed = false;
    state.imageFailed = false;
    state.counterAnimationCount = changedAttempt || changedStatus || changedCount
      ? null
      : state.counterAnimationCount;
    if (attempt && attempt.status !== "active") {
      if (changedAttempt || changedStatus || changedCount || !state.replay) {
        state.replay = MazeReplayCore.simulateReplay(attempt.problem, attempt.actions);
        state.replayCursor = state.replay.terminalCursor;
        _pauseReplay();
      }
    } else {
      state.replay = null;
      state.replayCursor = 0;
      _pauseReplay();
    }
    _render();
  }

  /** @description Format a server conflict with its latest state */
  function _conflictStatus(payload) {
    return payload.error
      ? { kind: "error", key: "status.conflictCode", parameters: { code: payload.error } }
      : { kind: "error", key: "status.conflict" };
  }

  /** @description Clear a conclusively resolved legacy request */
  function _clearLegacyPendingRequest() {
    state.pendingLegacyRequest = null;
    state.sendingLegacyRequest = false;
    state.uncertain = false;
    sessionStorage.removeItem(LEGACY_PENDING_REQUEST_KEY);
  }

  /** @description Show an unresolved external request without changing its ID */
  function _markUncertain(failure, status) {
    state.sendingLegacyRequest = false;
    state.savingCompletion = false;
    state.syncing = false;
    state.starting = false;
    if (state.pendingCompletion) {
      _markCompletionFailed();
      return;
    }
    state.uncertain = true;
    state.loadFailed = !state.sessionLoaded;
    state.actionStatus = failure === "network"
      ? { kind: "error", key: "status.network" }
      : failure === "invalidResponse"
        ? { kind: "error", key: "status.invalidResponse" }
        : { kind: "error", key: "status.http", parameters: { status } };
    _render();
  }

  /** @description Recover one request persisted by the previous page flow */
  async function _sendLegacyPendingRequest(pending) {
    if (state.sendingLegacyRequest) {
      return;
    }
    state.sendingLegacyRequest = true;
    state.uncertain = false;
    state.actionStatus = pending.kind === "quit"
      ? { kind: "processing", key: "actionStatus.quitProcessing" }
      : {
        kind: "processing",
        key: "actionStatus.processing",
        parameters: { action: _t(ACTIONS[pending.action].labelKey) },
      };
    _render();

    const path = "/api/attempts/" + encodeURIComponent(pending.attemptId)
      + (pending.kind === "quit" ? "/quit" : "/actions");
    const body = pending.kind === "quit"
      ? { sequence: pending.sequence, request_id: pending.request_id }
      : {
        sequence: pending.sequence,
        request_id: pending.request_id,
        action: pending.action,
      };
    const result = await _apiRequest(path, "POST", body);
    if (result.failure) {
      _markUncertain(result.failure);
      return;
    }
    if (result.response.status === 409) {
      _clearLegacyPendingRequest();
      state.actionStatus = _conflictStatus(result.payload);
      _applyServerState(result.payload);
      return;
    }
    if (!result.response.ok) {
      _markUncertain("http", result.response.status);
      return;
    }

    _clearLegacyPendingRequest();
    state.actionStatus = pending.kind === "quit"
      ? null
      : { kind: "success", key: "actionStatus.accepted" };
    _applyServerState(result.payload);
  }

  /** @description Keep a failed final save and its exact payload available for retry */
  function _markCompletionFailed() {
    state.savingCompletion = false;
    state.completionFailed = true;
    state.syncing = false;
    state.uncertain = false;
    state.actionStatus = { kind: "error", key: "finalStatus.retry" };
    _render();
  }

  /** @description Submit the saved final action list or quit decision */
  async function _sendCompletion() {
    if (state.savingCompletion || !state.pendingCompletion) {
      return;
    }
    const pending = state.pendingCompletion;
    state.savingCompletion = true;
    state.completionFailed = false;
    state.uncertain = false;
    state.actionStatus = { kind: "processing", key: "finalStatus.saving" };
    _render();

    const result = await _apiRequest(
      "/api/attempts/" + encodeURIComponent(pending.attemptId) + "/complete",
      "POST",
      pending.payload,
    );
    if (result.failure) {
      _markCompletionFailed();
      return;
    }
    if (result.response.status === 409) {
      localStorage.removeItem(_draftKey(pending.attemptId));
      state.pendingCompletion = null;
      state.draftRecord = null;
      state.savingCompletion = false;
      state.completionFailed = false;
      state.uncertain = false;
      state.actionStatus = _conflictStatus(result.payload);
      _applyServerState(result.payload);
      return;
    }
    if (!result.response.ok) {
      _markCompletionFailed();
      return;
    }

    localStorage.removeItem(_draftKey(pending.attemptId));
    state.pendingCompletion = null;
    state.draftRecord = null;
    state.savingCompletion = false;
    state.completionFailed = false;
    state.uncertain = false;
    state.actionStatus = { kind: "success", key: "finalStatus.saved" };
    _applyServerState(result.payload);
  }

  /** @description Start a maze or request the next random maze */
  async function _startMaze() {
    if (
      state.starting
      || state.syncing
      || state.sendingLegacyRequest
      || state.savingCompletion
      || state.pendingLegacyRequest
      || state.pendingCompletion
      || elements.tutorialDialog.open
    ) {
      return;
    }
    state.starting = true;
    state.actionStatus = { kind: "processing", key: "status.starting" };
    _render();
    const result = await _apiRequest("/api/start", "POST", {});
    if (result.failure) {
      _markUncertain(result.failure);
      return;
    }
    if (result.response.status === 409) {
      state.actionStatus = _conflictStatus(result.payload);
      _applyServerState(result.payload);
      return;
    }
    if (!result.response.ok) {
      _markUncertain("http", result.response.status);
      return;
    }
    state.actionStatus = null;
    _applyServerState(result.payload);
  }

  /** @description Fetch the latest session and resolve a saved request safely */
  async function _restoreSession() {
    if (
      state.syncing
      || state.sendingLegacyRequest
      || state.savingCompletion
      || state.starting
      || (state.pendingCompletion && state.sessionLoaded)
    ) {
      return;
    }
    state.syncing = true;
    state.uncertain = false;
    state.actionStatus = null;
    state.loadFailed = false;
    _render();
    const result = await _apiRequest("/api/session");
    if (result.failure) {
      _markUncertain(result.failure);
      return;
    }
    if (!result.response.ok) {
      _markUncertain("http", result.response.status);
      return;
    }

    const pending = state.pendingLegacyRequest;
    const matchingAttempt = pending
      && result.payload.attempt
      && result.payload.attempt.id === pending.attemptId;
    if (pending && !matchingAttempt) {
      _clearLegacyPendingRequest();
      state.actionStatus = { kind: "error", key: "status.changedElsewhere" };
      _applyServerState(result.payload);
      return;
    }
    if (pending && matchingAttempt) {
      _applyServerState(result.payload);
      await _sendLegacyPendingRequest(pending);
      return;
    }

    if (state.pendingCompletion) {
      if (result.payload.attempt?.id === state.pendingCompletion.attemptId) {
        _applyServerState(result.payload);
      } else {
        state.syncing = false;
        state.sessionLoaded = true;
        state.exhausted = result.payload.exhausted;
        _render();
      }
      await _sendCompletion();
      return;
    }

    _applyServerState(result.payload);
  }

  /** @description Accept one local move and finish immediately on a terminal event */
  function _acceptAction(action) {
    const attempt = state.attempt;
    if (
      !attempt
      || attempt.status !== "active"
      || state.starting
      || state.sendingLegacyRequest
      || state.pendingLegacyRequest
      || elements.tutorialDialog.open
      || state.imageFailed
      || elements.mazeImage.naturalWidth === 0
    ) {
      return;
    }
    const actions = [...attempt.actions, action];
    const replay = MazeReplayCore.simulateReplay(attempt.problem, actions);
    const terminalStatus = replay.successIndex !== null
      ? "success"
      : replay.collision
        ? "collision"
        : null;
    const finalPayload = terminalStatus ? { actions, quit: false } : null;
    const record = _saveDraft(attempt, actions, finalPayload);
    state.counterAnimationCount = actions.length;
    state.attempt = terminalStatus ? _localAttempt(record) : { ...attempt, actions };
    state.replay = terminalStatus ? replay : null;
    state.replayCursor = terminalStatus ? replay.terminalCursor : 0;
    state.actionStatus = null;
    if (terminalStatus) {
      state.pendingCompletion = {
        attemptId: attempt.id,
        payload: finalPayload,
      };
      _pauseReplay();
    }
    _render();
    if (terminalStatus) {
      void _sendCompletion();
    }
  }

  /** @description Confirm quit without adding another move */
  function _quitMaze() {
    if (
      !state.attempt
      || state.attempt.status !== "active"
      || state.pendingLegacyRequest
      || state.sendingLegacyRequest
      || elements.tutorialDialog.open
    ) {
      return;
    }
    if (!window.confirm(_t("confirm.quit"))) {
      return;
    }
    const attempt = state.attempt;
    const actions = [...attempt.actions];
    const finalPayload = { actions, quit: true };
    const record = _saveDraft(attempt, actions, finalPayload);
    state.pendingCompletion = {
      attemptId: attempt.id,
      payload: finalPayload,
    };
    state.attempt = _localAttempt(record);
    state.replay = MazeReplayCore.simulateReplay(attempt.problem, actions);
    state.replayCursor = state.replay.terminalCursor;
    state.actionStatus = null;
    _pauseReplay();
    _render();
    void _sendCompletion();
  }

  /** @description Return the translated label for one move action */
  function _actionLabel(action) {
    return _t(ACTIONS[action].labelKey);
  }

  /** @description Stop the finite tutorial animation */
  function _stopTutorialPlayback() {
    if (state.tutorialTimer !== null) {
      clearTimeout(state.tutorialTimer);
      state.tutorialTimer = null;
    }
    if (state.tutorialFrame !== null) {
      cancelAnimationFrame(state.tutorialFrame);
      state.tutorialFrame = null;
    }
    elements.tutorialMarker.classList.remove("is-moving");
  }

  /** @description Render one illustrative tutorial scene */
  function _renderTutorialScene(animate = false) {
    const scene = TUTORIAL_SCENES[state.tutorialSceneIndex];
    _stopTutorialPlayback();
    elements.tutorialCaption.textContent = _t(scene.key);
    elements.tutorialProgress.textContent = `${state.tutorialSceneIndex + 1} / ${TUTORIAL_SCENES.length}`;
    elements.tutorialPrevious.disabled = state.tutorialSceneIndex === 0;
    elements.tutorialNext.disabled = state.tutorialSceneIndex === TUTORIAL_SCENES.length - 1;
    elements.tutorialCollision.toggleAttribute("hidden", !scene.collision);
    for (const item of document.querySelectorAll("[data-demo-action]")) {
      const highlighted = item.dataset.demoAction === scene.action;
      item.classList.toggle("is-highlighted", highlighted);
      item.setAttribute("aria-current", String(highlighted));
    }

    const [fromX, fromY, fromAngle] = animate ? scene.from : scene.to;
    elements.tutorialMarker.setAttribute(
      "transform",
      `translate(${fromX} ${fromY}) rotate(${fromAngle})`,
    );
    if (animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      state.tutorialFrame = requestAnimationFrame(() => {
        elements.tutorialMarker.classList.add("is-moving");
        const [toX, toY, toAngle] = scene.to;
        elements.tutorialMarker.setAttribute(
          "transform",
          `translate(${toX} ${toY}) rotate(${toAngle})`,
        );
        state.tutorialFrame = null;
      });
    }
  }

  /** @description Play the tutorial once without looping */
  function _playTutorial() {
    _stopTutorialPlayback();
    state.tutorialSceneIndex = 0;
    _renderTutorialScene(true);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || document.hidden) {
      return;
    }
    const advance = () => {
      if (!elements.tutorialDialog.open || document.hidden) {
        _stopTutorialPlayback();
        return;
      }
      if (state.tutorialSceneIndex >= TUTORIAL_SCENES.length - 1) {
        state.tutorialTimer = null;
        return;
      }
      state.tutorialSceneIndex += 1;
      _renderTutorialScene(true);
      state.tutorialTimer = setTimeout(advance, TUTORIAL_SCENE_INTERVAL_MS);
    };
    state.tutorialTimer = setTimeout(advance, TUTORIAL_SCENE_INTERVAL_MS);
  }

  /** @description Open the tutorial without starting a maze attempt */
  function _openTutorial() {
    if (elements.tutorialDialog.open) {
      return;
    }
    localStorage.setItem(TUTORIAL_KEY, "seen");
    elements.tutorialDialog.showModal();
    _playTutorial();
  }

  /** @description Move between tutorial scenes without submitting a game input */
  function _stepTutorial(direction) {
    _stopTutorialPlayback();
    state.tutorialSceneIndex = Math.max(
      0,
      Math.min(TUTORIAL_SCENES.length - 1, state.tutorialSceneIndex + direction),
    );
    _renderTutorialScene(false);
  }

  /** @description Keep the displayed move count aligned with acknowledged server state */
  function _renderMoveCounter() {
    const count = state.attempt?.actions.length ?? 0;
    if (count === state.renderedMoveCount) {
      state.counterAnimationCount = null;
      return;
    }

    const animate = state.counterAnimationCount === count
      && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    state.counterAnimationCount = null;
    _finishMoveCounter();
    state.renderedMoveCount = count;
    if (!animate) {
      elements.moveCount.textContent = String(count);
      return;
    }

    const oldValue = elements.moveCount;
    oldValue.removeAttribute("id");
    oldValue.className = "move-count-value move-count-outgoing";
    oldValue.dataset.countOutgoing = "true";
    oldValue.setAttribute("aria-hidden", "true");
    const newValue = document.createElement("strong");
    newValue.id = "moveCount";
    newValue.className = "move-count-value move-count-incoming";
    newValue.textContent = String(count);
    elements.moveCountWindow.replaceChildren(oldValue, newValue);
    elements.moveCount = newValue;
    state.counterTransitionHandler = (event) => {
      if (event.propertyName === "transform") {
        _finishMoveCounter();
      }
    };
    elements.moveCountWindow.addEventListener(
      "transitionend",
      state.counterTransitionHandler,
    );
    state.counterFrame = requestAnimationFrame(() => {
      elements.moveCountWindow.classList.add("is-animating");
      state.counterFrame = null;
    });
  }

  /** @description Settle an interrupted counter transition on its current value */
  function _finishMoveCounter() {
    if (state.counterFrame !== null) {
      cancelAnimationFrame(state.counterFrame);
      state.counterFrame = null;
    }
    if (state.counterTransitionHandler !== null) {
      elements.moveCountWindow.removeEventListener(
        "transitionend",
        state.counterTransitionHandler,
      );
      state.counterTransitionHandler = null;
    }
    elements.moveCountWindow.classList.remove("is-animating");
    const currentValue = elements.moveCountWindow.querySelector("#moveCount");
    if (currentValue) {
      currentValue.className = "move-count-value";
      currentValue.removeAttribute("aria-hidden");
      elements.moveCountWindow.replaceChildren(currentValue);
      elements.moveCount = currentValue;
    }
  }

  /** @description Update accepted input history without replacing controls */
  function _renderHistory() {
    const actions = state.attempt?.actions ?? [];
    const replay = state.replay;
    const previousScroll = elements.historyScroll.scrollTop;
    const wasAtBottom = previousScroll + elements.historyScroll.clientHeight
      >= elements.historyScroll.scrollHeight - 8;
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      const item = document.createElement("li");
      item.className = "history-item";
      if (replay?.collision?.index === index) {
        item.classList.add("is-collision");
      }
      if (replay?.successIndex === index) {
        item.classList.add("is-success");
      }
      const symbol = document.createElement("span");
      symbol.className = "history-symbol";
      symbol.setAttribute("aria-hidden", "true");
      symbol.textContent = ACTIONS[action].symbol;
      const label = document.createElement("span");
      label.textContent = _actionLabel(action);
      item.append(symbol, label);
      fragment.append(item);
    }
    elements.historyList.replaceChildren(fragment);
    elements.historyTotal.textContent = String(actions.length);
    elements.historyEmpty.hidden = actions.length > 0;
    elements.historyList.hidden = actions.length === 0;
    if (wasAtBottom || actions.length <= 1) {
      elements.historyScroll.scrollTop = elements.historyScroll.scrollHeight;
    } else {
      elements.historyScroll.scrollTop = previousScroll;
    }
  }

  /** @description Return an accessible label for the server attempt state */
  function _attemptLabel(attempt) {
    const keys = {
      active: "attempt.active",
      success: "attempt.success",
      collision: "attempt.collision",
      quit: "attempt.quit",
    };
    return _t(keys[attempt.status]);
  }

  /** @description Render terminal score details from the completed attempt */
  function _renderTerminal(attempt) {
    const titleKeys = {
      success: "terminal.title.success",
      collision: "terminal.title.collision",
      quit: "terminal.title.quit",
    };
    elements.terminalTitle.textContent = _t(titleKeys[attempt.status]);
    elements.terminalScore.hidden = !attempt.result;
    elements.terminalDetails.hidden = !attempt.result;
    if (!attempt.result) {
      elements.terminalScore.textContent = "";
      elements.terminalDetails.replaceChildren();
      return;
    }
    elements.terminalScore.textContent = _t("terminal.score", {
      score: Number(attempt.result.score).toFixed(2),
    });
    const details = [
      {
        label: _t("terminal.successfulMoves"),
        value: attempt.result.successful_moves,
      },
      {
        label: _t("terminal.remainingMoves"),
        value: attempt.result.remaining_moves,
      },
    ];
    const fragment = document.createDocumentFragment();
    for (const detail of details) {
      const wrapper = document.createElement("div");
      wrapper.className = "terminal-detail";
      const label = document.createElement("dt");
      label.textContent = detail.label;
      const value = document.createElement("dd");
      value.textContent = String(detail.value);
      wrapper.append(label, value);
      fragment.append(wrapper);
    }
    elements.terminalDetails.replaceChildren(fragment);
  }

  /** @description Add one SVG child with the provided geometry */
  function _svgElement(name, attributes) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attributes)) {
      element.setAttribute(key, String(value));
    }
    return element;
  }

  /** @description Convert maze coordinates to original maze-image pixels */
  function _mazeImageGeometry(maze) {
    const imageSize = maze.image_size;
    const edgePadding = Math.max(16, Math.round(imageSize * 0.01));
    const arrowClearance = 1.2;
    const available = imageSize - edgePadding * 2;
    const cellSize = Math.min(
      available / (maze.width + arrowClearance * 2),
      available / (maze.height + arrowClearance * 2),
    );
    return {
      cellSize,
      originX: (imageSize - cellSize * maze.width) / 2,
      originY: (imageSize - cellSize * maze.height) / 2,
      imageSize,
    };
  }

  /** @description Convert one replay point to the original image coordinate space */
  function _imagePoint(point, geometry) {
    return [
      geometry.originX + point[0] * geometry.cellSize,
      geometry.originY + point[1] * geometry.cellSize,
    ];
  }

  /** @description 재생 위치까지의 종료 경로를 한 번에 그리기 */
  function _renderRoute() {
    const attempt = state.attempt;
    if (!attempt || attempt.status === "active" || !state.replay) {
      elements.routeSvg.setAttribute("hidden", "");
      elements.routeSvg.setAttribute("aria-hidden", "true");
      elements.routeSvg.replaceChildren();
      return;
    }
    const maze = attempt.problem;
    const geometry = _mazeImageGeometry(maze);
    const cursor = Math.min(state.replayCursor, state.replay.terminalCursor);
    elements.routeSvg.removeAttribute("hidden");
    elements.routeSvg.setAttribute("aria-hidden", "false");
    elements.routeSvg.setAttribute("viewBox", "0 0 " + geometry.imageSize + " " + geometry.imageSize);
    elements.routeSvg.setAttribute("role", "img");
    elements.routeSvg.setAttribute("aria-label", _t("page.title") + " — " + _attemptLabel(attempt));
    elements.routeSvg.style.setProperty("--route-width", geometry.cellSize * 0.14 + "px");
    elements.routeSvg.style.setProperty("--collision-width", geometry.cellSize * 0.22 + "px");
    const fragment = document.createDocumentFragment();
    const visibleSegments = state.replay.segments.filter((segment) => segment.index < cursor);
    if (visibleSegments.length > 0) {
      const points = [visibleSegments[0].from, ...visibleSegments.map((segment) => segment.to)];
      const pathData = points.map((point, index) => {
        const [x, y] = _imagePoint(point, geometry);
        return (index === 0 ? "M " : "L ") + x + " " + y;
      }).join(" ");
      fragment.append(_svgElement("path", {
        d: pathData,
        class: attempt.status === "success" ? "route-path route-success" : "route-path",
      }));
    }

    const collision = state.replay.collision;
    const reachedCollision = collision && collision.index < cursor;
    if (reachedCollision) {
      const from = _imagePoint(collision.from, geometry);
      const point = _imagePoint(collision.point, geometry);
      const size = geometry.cellSize * 0.15;
      fragment.append(
        _svgElement("line", {
          x1: from[0],
          y1: from[1],
          x2: point[0],
          y2: point[1],
          class: "route-collision",
        }),
        _svgElement("line", {
          x1: point[0] - size,
          y1: point[1] - size,
          x2: point[0] + size,
          y2: point[1] + size,
          class: "route-collision",
        }),
        _svgElement("line", {
          x1: point[0] + size,
          y1: point[1] - size,
          x2: point[0] - size,
          y2: point[1] + size,
          class: "route-collision",
        }),
      );
    } else {
      const lastVisible = visibleSegments.at(-1);
      const point = _imagePoint(
        lastVisible ? lastVisible.to : MazeReplayCore.eventPoint(maze, "START_OUT"),
        geometry,
      );
      fragment.append(_svgElement("circle", {
        cx: point[0],
        cy: point[1],
        r: geometry.cellSize * 0.12,
        class: "replay-marker",
      }));
    }
    elements.routeSvg.replaceChildren(fragment);
    elements.replayRange.max = String(state.replay.terminalCursor);
    elements.replayRange.value = String(cursor);
    elements.replayPosition.textContent = _t("status.replayProgress", {
      current: cursor,
      total: state.replay.terminalCursor,
    });
    const hasSteps = state.replay.terminalCursor > 0;
    elements.replayFirst.disabled = !hasSteps || cursor === 0;
    elements.replayPrevious.disabled = !hasSteps || cursor === 0;
    elements.replayNext.disabled = !hasSteps || cursor >= state.replay.terminalCursor;
    elements.replayLast.disabled = !hasSteps || cursor >= state.replay.terminalCursor;
    elements.replayPlay.disabled = !hasSteps;
  }

  /** @description Stop automatic route playback */
  function _pauseReplay() {
    if (state.replayTimer !== null) {
      window.clearInterval(state.replayTimer);
      state.replayTimer = null;
    }
    elements.replayPlay.setAttribute("aria-pressed", "false");
    elements.replayPlay.textContent = "▶";
  }

  /** @description Move the replay cursor and redraw only terminal overlays */
  function _setReplayCursor(cursor) {
    if (!state.replay) {
      return;
    }
    state.replayCursor = Math.max(0, Math.min(cursor, state.replay.terminalCursor));
    _renderRoute();
  }

  /** @description Play or pause the terminal route one accepted move at a time */
  function _toggleReplay() {
    if (!state.replay || state.replay.terminalCursor === 0) {
      return;
    }
    if (state.replayTimer !== null) {
      _pauseReplay();
      _applyLocale();
      return;
    }
    if (state.replayCursor >= state.replay.terminalCursor) {
      _setReplayCursor(0);
    }
    elements.replayPlay.setAttribute("aria-pressed", "true");
    elements.replayPlay.textContent = "Ⅱ";
    _applyLocale();
    state.replayTimer = window.setInterval(() => {
      if (state.replayCursor >= state.replay.terminalCursor) {
        _pauseReplay();
        _applyLocale();
        return;
      }
      _setReplayCursor(state.replayCursor + 1);
    }, REPLAY_INTERVAL_MS);
  }

  /** @description Fit the original maze image and overlay within the viewport */
  function _applyZoom() {
    if (
      elements.mazeCanvas.hidden
      || !elements.mazeImage.complete
      || elements.mazeImage.naturalWidth === 0
    ) {
      return;
    }
    const availableWidth = Math.max(120, elements.mazeViewport.clientWidth - 24);
    const availableHeight = Math.max(120, elements.mazeViewport.clientHeight - 24);
    const fitScale = Math.min(
      1,
      availableWidth / elements.mazeImage.naturalWidth,
      availableHeight / elements.mazeImage.naturalHeight,
    );
    const width = Math.max(
      1,
      Math.round(elements.mazeImage.naturalWidth * fitScale * state.zoom),
    );
    const height = Math.round(width * elements.mazeImage.naturalHeight / elements.mazeImage.naturalWidth);
    elements.mazeCanvas.style.width = width + "px";
    elements.mazeCanvas.style.height = height + "px";
    elements.zoomReset.textContent = Math.round(state.zoom * 100) + "%";
    elements.zoomOut.disabled = state.zoom <= MIN_ZOOM;
    elements.zoomIn.disabled = state.zoom >= MAX_ZOOM;
  }

  /** @description Render the current action feedback */
  function _renderActionStatus() {
    const feedback = state.actionStatus
      ?? (state.uncertain
        ? { kind: "error", key: "actionStatus.uncertain" }
        : state.attempt?.status === "active" && elements.mazeImage.naturalWidth === 0
          ? { kind: "processing", key: "status.imageLoading" }
          : null);
    elements.actionStatus.textContent = feedback ? _t(feedback.key, feedback.parameters) : "";
    elements.actionStatus.dataset.tone = feedback?.kind ?? "";
  }

  /** @description Update buttons, image, history, and terminal-only content */
  function _render() {
    _applyLocale();
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.style.colorScheme = state.theme;
    const attempt = state.attempt;
    const hasAttempt = Boolean(attempt);
    const active = attempt?.status === "active";
    const terminal = hasAttempt && !active;
    const canStart = state.sessionLoaded && !hasAttempt && !state.exhausted;
    const hasPendingLegacy = Boolean(state.pendingLegacyRequest);
    const hasPendingCompletion = Boolean(state.pendingCompletion);

    elements.mazePlaceholder.hidden = hasAttempt;
    elements.mazeCanvas.hidden = !hasAttempt;
    elements.mazeToolbar.hidden = !hasAttempt;
    if (!hasAttempt) {
      const titleKey = !state.sessionLoaded
        ? state.loadFailed ? "placeholder.errorTitle" : "placeholder.loadingTitle"
        : state.exhausted
          ? "placeholder.exhaustedTitle"
          : "placeholder.startTitle";
      const textKey = !state.sessionLoaded
        ? state.loadFailed ? "placeholder.errorText" : "placeholder.loadingText"
        : state.exhausted
          ? "placeholder.exhaustedText"
          : "placeholder.startText";
      elements.placeholderTitle.textContent = _t(titleKey);
      if (textKey === "placeholder.startText") {
        const emphasis = document.createElement("strong");
        emphasis.textContent = _t("placeholder.startTextEmphasis");
        elements.placeholderText.replaceChildren(
          document.createTextNode(_t("placeholder.startTextPrefix")),
          emphasis,
          document.createTextNode(_t("placeholder.startTextSuffix")),
        );
      } else {
        elements.placeholderText.textContent = _t(textKey);
      }
    }
    if (hasAttempt) {
      const imageUrl = "/mazes/" + encodeURIComponent(attempt.problem.problem_id) + ".png";
      if (elements.mazeImage.getAttribute("src") !== imageUrl) {
        state.imageFailed = false;
        elements.mazeImage.setAttribute("src", imageUrl);
      }
    } else {
      elements.routeSvg.setAttribute("hidden", "");
      elements.routeSvg.setAttribute("aria-hidden", "true");
      elements.routeSvg.replaceChildren();
    }

    elements.moveLabel.textContent = _t("counter.label");
    _renderMoveCounter();
    elements.actionPad.hidden = !active;
    elements.quitButton.hidden = !active;
    elements.startButton.hidden = !canStart;
    elements.nextButton.hidden = !terminal;
    elements.nextButton.disabled = !terminal
      || state.exhausted
      || state.starting
      || state.syncing
      || state.savingCompletion
      || hasPendingCompletion;
    elements.startButton.disabled = !canStart || state.starting || state.syncing || state.uncertain;
    elements.quitButton.disabled = state.sendingLegacyRequest || state.starting || hasPendingLegacy;
    for (const button of elements.actionButtons) {
      const pressed = state.pendingLegacyRequest?.action === button.dataset.action;
      button.disabled = !active
        || state.starting
        || state.sendingLegacyRequest
        || hasPendingLegacy
        || state.imageFailed
        || elements.mazeImage.naturalWidth === 0;
      button.classList.toggle("is-pressed", Boolean(pressed));
      button.setAttribute("aria-pressed", String(Boolean(pressed)));
    }

    elements.terminalSummary.hidden = !terminal;
    if (terminal) {
      _renderTerminal(attempt);
      _renderRoute();
    } else {
      elements.terminalScore.textContent = "";
      elements.terminalScore.hidden = true;
      elements.terminalDetails.replaceChildren();
      elements.terminalDetails.hidden = true;
      elements.routeSvg.setAttribute("hidden", "");
      elements.routeSvg.setAttribute("aria-hidden", "true");
      elements.routeSvg.replaceChildren();
    }

    elements.recoveryActions.hidden = !state.uncertain && !state.completionFailed;
    elements.restoreButton.disabled = state.syncing || state.sendingLegacyRequest || state.starting;
    elements.restoreButton.hidden = hasPendingCompletion;
    elements.retryButton.hidden = !state.pendingLegacyRequest
      && !(hasPendingCompletion && state.completionFailed);
    elements.retryButton.disabled = (!state.pendingLegacyRequest && !hasPendingCompletion)
      || state.sendingLegacyRequest || state.savingCompletion || state.syncing;
    _renderActionStatus();
    _renderHistory();
    if (hasAttempt) {
      _applyZoom();
    }
  }

  /** @description Change image magnification while keeping the current maze */
  function _changeZoom(delta) {
    state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.zoom + delta));
    _applyZoom();
  }

  /** @description Ignore movement keys while focus is inside the scrollable history */
  function _isHistoryFocused(target) {
    return elements.historyScroll.contains(target);
  }

  for (const button of elements.localeButtons) {
    button.addEventListener("click", () => _setLocale(button.dataset.locale));
  }
  elements.themeToggle.addEventListener("click", () => {
    _setTheme(state.theme === "dark" ? "light" : "dark");
  });
  elements.startButton.addEventListener("click", _startMaze);
  elements.tutorialOpen.addEventListener("click", _openTutorial);
  elements.tutorialSkip.addEventListener("click", () => elements.tutorialDialog.close());
  elements.tutorialClose.addEventListener("click", () => elements.tutorialDialog.close());
  elements.tutorialReplay.addEventListener("click", _playTutorial);
  elements.tutorialPrevious.addEventListener("click", () => _stepTutorial(-1));
  elements.tutorialNext.addEventListener("click", () => _stepTutorial(1));
  elements.tutorialDialog.addEventListener("close", _stopTutorialPlayback);
  elements.nextButton.addEventListener("click", _startMaze);
  elements.quitButton.addEventListener("click", _quitMaze);
  elements.restoreButton.addEventListener("click", () => {
    void _restoreSession();
  });
  elements.retryButton.addEventListener("click", () => {
    if (state.pendingCompletion) {
      void _sendCompletion();
    } else if (state.pendingLegacyRequest) {
      void _sendLegacyPendingRequest(state.pendingLegacyRequest);
    }
  });
  elements.zoomOut.addEventListener("click", () => _changeZoom(-0.25));
  elements.zoomIn.addEventListener("click", () => _changeZoom(0.25));
  elements.zoomReset.addEventListener("click", () => {
    state.zoom = 1;
    _applyZoom();
  });
  for (const button of elements.actionButtons) {
    button.addEventListener("click", () => _acceptAction(button.dataset.action));
  }
  elements.replayFirst.addEventListener("click", () => _setReplayCursor(0));
  elements.replayPrevious.addEventListener("click", () => _setReplayCursor(state.replayCursor - 1));
  elements.replayPlay.addEventListener("click", _toggleReplay);
  elements.replayNext.addEventListener("click", () => _setReplayCursor(state.replayCursor + 1));
  elements.replayLast.addEventListener("click", () => {
    if (state.replay) {
      _setReplayCursor(state.replay.terminalCursor);
    }
  });
  elements.replayRange.addEventListener("input", () => {
    _setReplayCursor(Number(elements.replayRange.value));
  });
  elements.mazeImage.addEventListener("load", () => {
    state.imageFailed = false;
    _applyZoom();
    _render();
  });
  elements.mazeImage.addEventListener("error", () => {
    state.imageFailed = true;
    state.uncertain = true;
    state.actionStatus = { kind: "error", key: "status.imageError" };
    _render();
  });
  window.addEventListener("keydown", (event) => {
    const action = KEY_ACTIONS[event.key];
    if (!action || elements.tutorialDialog.open || _isHistoryFocused(event.target)) {
      return;
    }
    if (state.attempt?.status !== "active") {
      return;
    }
    event.preventDefault();
    if (!event.repeat) {
      _acceptAction(action);
    }
  });
  window.addEventListener("resize", _applyZoom);
  window.addEventListener("focus", () => {
    if (
      state.sessionLoaded
      && !state.sendingLegacyRequest
      && !state.savingCompletion
      && !state.syncing
      && !state.uncertain
    ) {
      void _restoreSession();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      _stopTutorialPlayback();
      return;
    }
    if (
      document.visibilityState === "visible"
      && state.sessionLoaded
      && !state.sendingLegacyRequest
      && !state.savingCompletion
      && !state.syncing
      && !state.uncertain
    ) {
      void _restoreSession();
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === LOCALE_KEY && (event.newValue === "ko" || event.newValue === "en")) {
      state.locale = event.newValue;
      _render();
    } else if (event.key === THEME_KEY && (event.newValue === "light" || event.newValue === "dark")) {
      state.theme = event.newValue;
      _render();
    }
  });

  state.browserId = _loadBrowserId();
  _loadLegacyPendingRequest();
  _loadPendingCompletion();
  const savedLocale = localStorage.getItem(LOCALE_KEY);
  state.locale = savedLocale === "ko" || savedLocale === "en"
    ? savedLocale
    : navigator.language.toLowerCase().startsWith("ko")
      ? "ko"
      : "en";
  const savedTheme = localStorage.getItem(THEME_KEY);
  state.theme = savedTheme === "light" || savedTheme === "dark"
    ? savedTheme
    : matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  const themePreference = matchMedia("(prefers-color-scheme: dark)");
  themePreference.addEventListener("change", (event) => {
    if (localStorage.getItem(THEME_KEY) === null) {
      state.theme = event.matches ? "dark" : "light";
      _render();
    }
  });
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.style.colorScheme = state.theme;
  _render();
  void _restoreSession();
  if (localStorage.getItem(TUTORIAL_KEY) === null) {
    _openTutorial();
  }
})();
