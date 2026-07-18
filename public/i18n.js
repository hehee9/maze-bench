/**
 * @file public/i18n.js
 * @description Provide shared Korean and English dashboard translations
 */

(function exposeDashboardI18n(globalScope) {
  "use strict";

  const STORAGE_KEY = "maze-bench-locale";
  const LOCALE_EVENT = "maze-bench:localechange";
  const TRANSLATIONS = {
    ko: {
      "common.brand": "MAZE BENCH",
      "common.ko": "KO",
      "common.en": "EN",
      "common.korean": "한국어",
      "common.english": "영어",
      "common.language": "언어 선택",
      "common.switchKorean": "한국어로 전환",
      "common.switchEnglish": "영어로 전환",
      "common.switchDarkTheme": "다크 모드로 전환",
      "common.switchLightTheme": "라이트 모드로 전환",
      "common.leaderboard": "리더보드",
      "common.replay": "리플레이",
      "common.pageNavigation": "페이지 이동",
      "common.loading": "불러오는 중",
      "common.readingResults": "공개 결과를 읽고 있습니다.",
      "common.noNameModel": "이름 없는 모델",
      "common.unknownDeveloper": "알 수 없는 개발사",
      "common.all": "전체",
      "common.score": "점수",
      "common.cost": "비용",
      "common.totalCost": "총 비용",
      "common.input": "입력",
      "common.output": "출력",
      "common.reasoning": "추론",
      "common.totalTokens": "총 토큰",
      "common.mazeSize": "미로 크기",
      "common.model": "모델",
      "common.modelName": "모델명",
      "common.rank": "순위",
      "common.waiting": "대기 중",
      "common.noResults": "결과 없음",
      "common.apiFailure": "API 실패",
      "common.unavailable": "사용 불가",
      "common.formatError": "형식 오류",
      "common.completed": "완주",
      "common.collision": "충돌",
      "common.unreached": "미도달",
      "common.noScoreData": "표시할 점수 데이터가 없습니다.",
      "common.originalId": "{label}; 원본 ID {id}",
      "common.points": "{score}점",
      "common.resultsCount": "{count}개 결과",
      "common.oneResult": "1개 결과",
      "common.scoreMissing": "점수 없음",
      "common.dataModuleFailure": "공통 데이터 모듈을 불러오지 못했습니다.",
      "common.publicLoadFailure": "공개 결과를 불러오지 못했습니다. {detail}",
      "common.modelsResultsMissing": "models 또는 results 배열이 없습니다",
      "common.noDisplayModels": "표시할 모델이 없습니다",
      "common.mazeFallback": "{number}번 미로",
      "common.mazeNamed": "{number}번 · {relation}",
      "relation.adjacent": "인접 출입구",
      "relation.opposite": "마주보는 출입구",
      "relation.same": "같은 면 출입구",
      "selection.allModels": "전체 모델",
      "selection.selectAll": "모두 선택",
      "selection.clearAll": "모두 해제",
      "selection.selectDeveloper": "{developer} 모델 모두 선택",
      "selection.clearDeveloper": "{developer} 모델 모두 해제",
      "selection.expandDeveloper": "{developer} 모델 펼치기",
      "selection.collapseDeveloper": "{developer} 모델 접기",
      "export.image": "이미지로 내보내기",
      "export.saved": "PNG 이미지 다운로드를 시작했습니다.",
      "export.failed": "이미지를 내보내지 못했습니다.",

      "footer.ariaLabel": "프로젝트 정보",
      "footer.githubAria": "Maze Bench GitHub 저장소 열기",
      "footer.licenseAria": "Apache License 2.0 전문 보기",
      "footer.independent": "Maze Bench는 독립적으로 운영되는 오픈소스 벤치마크입니다.",

      "leaderboard.documentTitle": "Maze Bench 리더보드",
      "leaderboard.brandLabel": "Maze Bench 리더보드",
      "leaderboard.title": "모델 리더보드",
      "leaderboard.filters": "리더보드 필터",
      "leaderboard.multiSize": "미로 크기 복수 선택",
      "leaderboard.readingScope": "공개 결과를 읽고 있습니다.",
      "leaderboard.modelRanking": "모델 순위",
      "leaderboard.sortKey": "정렬 기준",
      "leaderboard.changeDescending": "내림차순으로 변경",
      "leaderboard.changeAscending": "오름차순으로 변경",
      "leaderboard.noModelResults": "표시할 모델 결과가 없습니다.",
      "leaderboard.analytics": "리더보드 통계",
      "leaderboard.bySizePerformance": "주요 모델 미로 크기별 성적",
      "leaderboard.selectModels": "모델 선택",
      "leaderboard.allMazePerformance": "전체 미로 성적",
      "leaderboard.costPerformance": "비용-성적",
      "leaderboard.costScale": "비용 축 선택",
      "leaderboard.linear": "선형",
      "leaderboard.log": "로그",
      "leaderboard.processedTitle": "현재까지 처리된 결과",
      "leaderboard.provisionalScore": "임시 점수",
      "leaderboard.reasoningEnabled": "모든 모델은 추론 활성화 상태입니다.",
      "leaderboard.reasoningConfiguration": "추론 강도 조절을 지원할 경우, medium 또는 8K 예산을 가집니다.",
      "leaderboard.scoreFormulaSummary": "표의 점수는 선택 범위 내 개별 미로 점수의 평균입니다.",
      "leaderboard.scoreFormulaEquation": "개별 점수 = 100 × P × E",
      "leaderboard.scoreFormulaRatios": "P = m/(m+r) · E = D/(m+r)",
      "leaderboard.scoreVariableD": "최소 명령 수",
      "leaderboard.scoreVariableM": "성공한 명령 수",
      "leaderboard.scoreVariableR": "남은 최소 명령 수",
      "leaderboard.allMazes": "전체 미로",
      "leaderboard.oneSizeMazes": "{size} 미로",
      "leaderboard.multipleSizeMazes": "{count}개 크기 미로",
      "leaderboard.selectedSizeScope": "{scope} · 순위 {complete}개{partial}",
      "leaderboard.partialScope": " · 집계 중 {count}개",
      "leaderboard.chartBars": "선택 모델의 미로 크기별 평균 점수 막대그래프",
      "leaderboard.chartCost": "{scale} 비용 축 비용-성적 산점도",
      "leaderboard.totalCostAxis": "총 비용 ($)",
      "leaderboard.averageScoreAxis": "평균 점수",
      "leaderboard.aggregating": "집계 중",
      "leaderboard.noCostData": "표시할 비용 데이터가 없습니다.",
      "leaderboard.loadFailed": "benchmark_results.json 로드 실패",

      "model.documentTitle": "Maze Bench 모델 상세",
      "model.sidebar": "전체 모델 순위",
      "model.allRanking": "전체 순위",
      "model.closeRanking": "모델 순위 닫기",
      "model.detailLinks": "모델 상세 바로가기",
      "model.resizeRanking": "모델 순위 너비 조절",
      "model.detail": "모델 상세",
      "model.rankingButton": "순위",
      "model.summary": "모델 결과 요약",
      "model.pricePerMillion": "100만 토큰당 가격",
      "model.priceValue": "입력 — · 출력 —",
      "model.mazeResults": "미로별 결과",
      "model.mazeName": "미로명",
      "model.status": "상태",
      "model.noMazes": "표시할 미로가 없습니다.",
      "model.analytics": "미로 크기와 구조별 평균 점수",
      "model.sizeAverage": "미로 크기별 평균 점수",
      "model.structureHeatmap": "미로 크기 × 출입구 구조",
      "model.rankMissing": "순위 없음",
      "model.rankLabel": "{rank}위",
      "model.rankingAria": "{rank} {model}, 점수 {score}",
      "model.provisionalTitle": "집계 중 임시 점수",
      "model.sizeChartAria": "{model} 미로 크기별 평균 점수: {values}",
      "model.sizeChartEntry": "{size} {score}점",
      "model.heatmapValue": "{size} {relation} 평균 {score}점, {results}",
      "model.heatmapMissing": "{size} {relation} 점수 없음",
      "model.view": "보기",
      "model.viewReplay": "리플레이 보기",
      "model.replayAria": "{maze} 리플레이 보기",
      "model.detailTitle": "{model} 상세",
      "model.detailDocumentTitle": "Maze Bench · {model} 상세",
      "model.costAndTokens": "{cost} / {tokens}토큰",
      "model.price": "입력 {input} · 출력 {output}",
      "model.resultsTitle": "{model} · 미로별 결과",
      "model.rankingLoadFailure": "모델 순위를 불러오지 못했습니다.",

      "replay.documentTitle": "Maze Bench Replay",
      "replay.brandLabel": "Maze Bench 리플레이",
      "replay.title": "모델 이동 리플레이",
      "replay.controls": "리플레이 선택 및 재생 제어",
      "replay.settings": "리플레이 설정",
      "replay.collapse": "옵션 접기",
      "replay.expand": "옵션 펼치기",
      "replay.compareModels": "모델 비교",
      "replay.shortestPath": "최단 경로",
      "replay.searchModel": "모델 검색",
      "replay.searchPlaceholder": "모델명 검색",
      "replay.selectModels": "비교할 모델 선택",
      "replay.bulkSelection": "모델 일괄 선택",
      "replay.developers": "개발사",
      "replay.developerSelection": "개발사별 모델 선택",
      "replay.readingFile": "결과 파일을 읽고 있습니다",
      "replay.executedMoves": "실행 이동",
      "replay.optimalMoves": "최단 이동",
      "replay.speed": "속도",
      "replay.move": "이동",
      "replay.mazePath": "미로 이동 경로",
      "replay.svgTitle": "미로 리플레이",
      "replay.svgDescription": "미로의 벽, 출발점, 도착점과 현재까지 이동한 경로",
      "replay.movementLog": "모델 이동 로그",
      "replay.commands": "이동 명령",
      "replay.commandColors": "명령 색상 설명",
      "replay.current": "현재",
      "replay.goal": "도착",
      "replay.ignored": "종료 이후",
      "replay.positionControls": "재생 위치 제어",
      "replay.first": "처음으로",
      "replay.previous": "한 칸 뒤로",
      "replay.autoPlay": "자동 재생",
      "replay.play": "재생",
      "replay.next": "한 칸 앞으로",
      "replay.last": "마지막으로",
      "replay.logLeft": "로그를 왼쪽으로 이동",
      "replay.commandList": "이동 명령 목록",
      "replay.logRight": "로그를 오른쪽으로 이동",
      "replay.position": "재생 위치",
      "replay.stop": "정지",
      "replay.replayError": "리플레이 오류",
      "replay.emptyOutput": "빈 출력",
      "replay.noSearchResults": "검색 결과가 없습니다",
      "replay.routeVisible": "{model} 경로 표시",
      "replay.modelLogTitle": "이 모델의 로그와 결과 보기",
      "replay.noModelSelected": "모델 미선택",
      "replay.chooseModel": "비교할 모델을 선택하세요",
      "replay.noSelectableMaze": "선택할 수 있는 미로가 없습니다.",
      "replay.moveMismatch": "실행 이동 수 불일치: 공개 결과 {expected}, 재구성 {actual}",
      "replay.noShortestCommands": "최단 경로 명령이 없습니다",
      "replay.shortestDoesNotReach": "최단 경로가 도착점에 도달하지 않습니다",
      "replay.noReplayableResults": "이 미로에는 재생 가능한 모델 결과가 없습니다.",
      "replay.mazeLoadFailure": "미로 데이터를 불러오거나 리플레이를 재구성하지 못했습니다. {detail}. 저장소 루트에서 정적 HTTP 서버를 실행했는지 확인해 주세요.",
      "replay.renderTitle": "{label} 리플레이",
      "replay.renderDescription": "{width} × {height} 미로의 최단 경로와 선택한 모델 이동 경로",
      "replay.noCommands": "재생할 명령이 없습니다",
      "replay.moveTitle": "{index}번째 이동: {action}",
      "replay.resultsMissing": "results 배열이 없습니다",
      "replay.resultsEmpty": "공개 결과가 비어 있습니다",
      "replay.loadFailure": "로드 실패",
      "replay.publicAutoLoadFailure": "공개 결과 파일을 자동으로 읽지 못했습니다. {detail}. 저장소 루트에서 정적 HTTP 서버를 실행한 뒤 /public/에 접속해 주세요.",
      "replay.coreFailure": "리플레이 계산 모듈을 불러오지 못했습니다.",
      "replay.directionError": "방향을 변환할 수 없습니다: {facing}, {action}",
      "replay.eventPointError": "미로 이벤트 좌표가 없습니다: {event}",
      "replay.outsidePointError": "외부 지점 정보를 해석할 수 없습니다: {side}",
      "replay.collisionPointError": "충돌 방향을 해석할 수 없습니다: {direction}",
    },
    en: {
      "common.brand": "MAZE BENCH",
      "common.ko": "KO",
      "common.en": "EN",
      "common.korean": "Korean",
      "common.english": "English",
      "common.language": "Language",
      "common.switchKorean": "Switch to Korean",
      "common.switchEnglish": "Switch to English",
      "common.switchDarkTheme": "Switch to dark mode",
      "common.switchLightTheme": "Switch to light mode",
      "common.leaderboard": "Leaderboard",
      "common.replay": "Replay",
      "common.pageNavigation": "Page navigation",
      "common.loading": "Loading",
      "common.readingResults": "Loading public results.",
      "common.noNameModel": "Unnamed model",
      "common.unknownDeveloper": "Unknown developer",
      "common.all": "All",
      "common.score": "Score",
      "common.cost": "Cost",
      "common.totalCost": "Total cost",
      "common.input": "Input",
      "common.output": "Output",
      "common.reasoning": "Reasoning",
      "common.totalTokens": "Total tokens",
      "common.mazeSize": "Maze size",
      "common.model": "Model",
      "common.modelName": "Model",
      "common.rank": "Rank",
      "common.waiting": "Pending",
      "common.noResults": "No result",
      "common.apiFailure": "API failure",
      "common.unavailable": "Unavailable",
      "common.formatError": "Invalid format",
      "common.completed": "Completed",
      "common.collision": "Collision",
      "common.unreached": "Unreached",
      "common.noScoreData": "No score data to display.",
      "common.originalId": "{label}; original ID {id}",
      "common.points": "{score} points",
      "common.resultsCount": "{count} results",
      "common.oneResult": "1 result",
      "common.scoreMissing": "No score",
      "common.dataModuleFailure": "Could not load the shared data module.",
      "common.publicLoadFailure": "Could not load public results. {detail}",
      "common.modelsResultsMissing": "Missing models or results array",
      "common.noDisplayModels": "No models to display",
      "common.mazeFallback": "Maze {number}",
      "common.mazeNamed": "{number} · {relation}",
      "relation.adjacent": "Adjacent entrances",
      "relation.opposite": "Opposite entrances",
      "relation.same": "Same-side entrances",
      "selection.allModels": "All models",
      "selection.selectAll": "Select all",
      "selection.clearAll": "Clear all",
      "selection.selectDeveloper": "Select all {developer} models",
      "selection.clearDeveloper": "Clear all {developer} models",
      "selection.expandDeveloper": "Expand {developer} models",
      "selection.collapseDeveloper": "Collapse {developer} models",
      "export.image": "Export as image",
      "export.saved": "PNG download started.",
      "export.failed": "Could not export the image.",

      "footer.ariaLabel": "Project information",
      "footer.githubAria": "Open the Maze Bench GitHub repository",
      "footer.licenseAria": "Read the Apache License 2.0",
      "footer.independent": "Maze Bench is an independently maintained open-source benchmark.",

      "leaderboard.documentTitle": "Maze Bench Leaderboard",
      "leaderboard.brandLabel": "Maze Bench leaderboard",
      "leaderboard.title": "Model Leaderboard",
      "leaderboard.filters": "Leaderboard filters",
      "leaderboard.multiSize": "Select multiple maze sizes",
      "leaderboard.readingScope": "Loading public results.",
      "leaderboard.modelRanking": "Model Ranking",
      "leaderboard.sortKey": "Sort by",
      "leaderboard.changeDescending": "Switch to descending order",
      "leaderboard.changeAscending": "Switch to ascending order",
      "leaderboard.noModelResults": "No model results to display.",
      "leaderboard.analytics": "Leaderboard analytics",
      "leaderboard.bySizePerformance": "Top Models by Maze Size",
      "leaderboard.selectModels": "Select models",
      "leaderboard.allMazePerformance": "All Maze Results",
      "leaderboard.costPerformance": "Cost vs. Performance",
      "leaderboard.costScale": "Cost axis scale",
      "leaderboard.linear": "Linear",
      "leaderboard.log": "Log",
      "leaderboard.processedTitle": "Results processed so far",
      "leaderboard.provisionalScore": "Provisional score",
      "leaderboard.reasoningEnabled": "All models have reasoning enabled.",
      "leaderboard.reasoningConfiguration": "Models that support reasoning-level control use medium or an 8K budget.",
      "leaderboard.scoreFormulaSummary": "The table score is the average of the individual maze scores in the selected range.",
      "leaderboard.scoreFormulaEquation": "Individual score = 100 × P × E",
      "leaderboard.scoreFormulaRatios": "P = m/(m+r) · E = D/(m+r)",
      "leaderboard.scoreVariableD": "Minimum command count",
      "leaderboard.scoreVariableM": "Successful command count",
      "leaderboard.scoreVariableR": "Minimum remaining command count",
      "leaderboard.allMazes": "All mazes",
      "leaderboard.oneSizeMazes": "{size} mazes",
      "leaderboard.multipleSizeMazes": "{count} maze sizes",
      "leaderboard.selectedSizeScope": "{scope} · {complete} ranked{partial}",
      "leaderboard.partialScope": " · {count} in progress",
      "leaderboard.chartBars": "Average score by maze size for selected models",
      "leaderboard.chartCost": "Cost-performance scatter plot with a {scale} cost axis",
      "leaderboard.totalCostAxis": "Total cost ($)",
      "leaderboard.averageScoreAxis": "Average score",
      "leaderboard.aggregating": "In progress",
      "leaderboard.noCostData": "No cost data to display.",
      "leaderboard.loadFailed": "Failed to load benchmark_results.json",

      "model.documentTitle": "Maze Bench Model Details",
      "model.sidebar": "All model rankings",
      "model.allRanking": "All Rankings",
      "model.closeRanking": "Close model rankings",
      "model.detailLinks": "Model detail links",
      "model.resizeRanking": "Resize model rankings",
      "model.detail": "Model Details",
      "model.rankingButton": "Rankings",
      "model.summary": "Model result summary",
      "model.pricePerMillion": "Price per 1M tokens",
      "model.priceValue": "Input — · Output —",
      "model.mazeResults": "Results by Maze",
      "model.mazeName": "Maze",
      "model.status": "Status",
      "model.noMazes": "No mazes to display.",
      "model.analytics": "Average Scores by Maze Size and Layout",
      "model.sizeAverage": "Average Score by Maze Size",
      "model.structureHeatmap": "Maze Size × Entrance Layout",
      "model.rankMissing": "Unranked",
      "model.rankLabel": "Rank {rank}",
      "model.rankingAria": "{rank}, {model}, score {score}",
      "model.provisionalTitle": "Provisional score while results are in progress",
      "model.sizeChartAria": "{model} average score by maze size: {values}",
      "model.sizeChartEntry": "{size} {score} points",
      "model.heatmapValue": "{size} {relation}, average {score} points from {results}",
      "model.heatmapMissing": "{size} {relation}, no score",
      "model.view": "View",
      "model.viewReplay": "View replay",
      "model.replayAria": "View replay for {maze}",
      "model.detailTitle": "{model} Details",
      "model.detailDocumentTitle": "Maze Bench · {model} Details",
      "model.costAndTokens": "{cost} / {tokens} tokens",
      "model.price": "Input {input} · Output {output}",
      "model.resultsTitle": "{model} · Results by Maze",
      "model.rankingLoadFailure": "Could not load model rankings.",

      "replay.documentTitle": "Maze Bench Replay",
      "replay.brandLabel": "Maze Bench replay",
      "replay.title": "Model Movement Replay",
      "replay.controls": "Replay selection and playback controls",
      "replay.settings": "Replay Settings",
      "replay.collapse": "Collapse options",
      "replay.expand": "Expand options",
      "replay.compareModels": "Compare Models",
      "replay.shortestPath": "Shortest path",
      "replay.searchModel": "Search models",
      "replay.searchPlaceholder": "Search by model name",
      "replay.selectModels": "Select models to compare",
      "replay.bulkSelection": "Bulk model selection",
      "replay.developers": "Developers",
      "replay.developerSelection": "Select models by developer",
      "replay.readingFile": "Loading the result file",
      "replay.executedMoves": "Executed moves",
      "replay.optimalMoves": "Shortest moves",
      "replay.speed": "Speed",
      "replay.move": "Move",
      "replay.mazePath": "Maze movement path",
      "replay.svgTitle": "Maze replay",
      "replay.svgDescription": "Maze walls, start, goal, and the movement path so far",
      "replay.movementLog": "Model movement log",
      "replay.commands": "Commands",
      "replay.commandColors": "Command color legend",
      "replay.current": "Current",
      "replay.goal": "Goal",
      "replay.ignored": "After finish",
      "replay.positionControls": "Playback position controls",
      "replay.first": "Go to start",
      "replay.previous": "Previous move",
      "replay.autoPlay": "Auto play",
      "replay.play": "Play",
      "replay.next": "Next move",
      "replay.last": "Go to end",
      "replay.logLeft": "Scroll log left",
      "replay.commandList": "Movement command list",
      "replay.logRight": "Scroll log right",
      "replay.position": "Playback position",
      "replay.stop": "Pause",
      "replay.replayError": "Replay error",
      "replay.emptyOutput": "Empty output",
      "replay.noSearchResults": "No search results",
      "replay.routeVisible": "Show {model} path",
      "replay.modelLogTitle": "View this model's log and result",
      "replay.noModelSelected": "No model selected",
      "replay.chooseModel": "Select a model to compare",
      "replay.noSelectableMaze": "No maze is available for selection.",
      "replay.moveMismatch": "Move count mismatch: public result {expected}, reconstructed {actual}",
      "replay.noShortestCommands": "Shortest-path commands are missing",
      "replay.shortestDoesNotReach": "The shortest path does not reach the goal",
      "replay.noReplayableResults": "This maze has no replayable model results.",
      "replay.mazeLoadFailure": "Could not load the maze or reconstruct the replay. {detail}. Check that a static HTTP server is running from the repository root.",
      "replay.renderTitle": "{label} Replay",
      "replay.renderDescription": "{width} × {height} maze with the shortest path and selected model paths",
      "replay.noCommands": "No commands to replay",
      "replay.moveTitle": "Move {index}: {action}",
      "replay.resultsMissing": "Missing results array",
      "replay.resultsEmpty": "Public results are empty",
      "replay.loadFailure": "Load failed",
      "replay.publicAutoLoadFailure": "Could not load the public result file automatically. {detail}. Run a static HTTP server from the repository root and open /public/.",
      "replay.coreFailure": "Could not load the replay calculation module.",
      "replay.directionError": "Could not rotate direction: {facing}, {action}",
      "replay.eventPointError": "Missing maze event coordinates: {event}",
      "replay.outsidePointError": "Could not interpret the outside point: {side}",
      "replay.collisionPointError": "Could not interpret the collision direction: {direction}",
    },
  };

  let currentLocale = _resolveInitialLocale();

  /** @description Normalize supported locales and default all non-Korean values to English */
  function _normalizeLocale(locale) {
    return String(locale ?? "").toLowerCase().startsWith("ko") ? "ko" : "en";
  }

  /** @description Read a saved locale when browser storage is available */
  function _savedLocale() {
    try {
      const saved = globalScope.localStorage?.getItem(STORAGE_KEY);
      return saved === "ko" || saved === "en" ? saved : null;
    } catch {
      return null;
    }
  }

  /** @description Resolve the saved locale or the browser's preferred language */
  function _resolveInitialLocale() {
    const saved = _savedLocale();
    if (saved) {
      return saved;
    }
    const preferred = globalScope.navigator?.languages?.[0]
      ?? globalScope.navigator?.language;
    return _normalizeLocale(preferred);
  }

  /** @description Return the active dashboard locale */
  function getLocale() {
    return currentLocale;
  }

  /** @description Translate one key and substitute named parameters */
  function t(key, parameters = {}) {
    const template = TRANSLATIONS[currentLocale]?.[key]
      ?? TRANSLATIONS.ko[key]
      ?? key;
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
      Object.hasOwn(parameters, name) ? String(parameters[name]) : match
    ));
  }

  /** @description Update static translated text and attributes within one root */
  function applyDocument(root = globalScope.document) {
    if (!root?.querySelectorAll) {
      return;
    }
    globalScope.document.documentElement.lang = currentLocale;
    for (const element of root.querySelectorAll("[data-i18n]")) {
      element.textContent = t(element.dataset.i18n);
    }
    for (const attribute of ["aria-label", "title", "placeholder"]) {
      const dataName = `i18n${attribute.split("-").map((part) => (
        `${part[0].toUpperCase()}${part.slice(1)}`
      )).join("")}`;
      for (const element of root.querySelectorAll(`[data-${dataName.replace(
        /[A-Z]/g,
        (character) => `-${character.toLowerCase()}`,
      )}]`)) {
        element.setAttribute(attribute, t(element.dataset[dataName]));
      }
    }
    const nextLocale = currentLocale === "ko" ? "en" : "ko";
    for (const button of root.querySelectorAll("[data-locale]")) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.locale === currentLocale),
      );
      button.setAttribute(
        "aria-label",
        t(nextLocale === "ko" ? "common.switchKorean" : "common.switchEnglish"),
      );
      if (button.dataset.localeBound !== "true") {
        button.dataset.localeBound = "true";
        button.addEventListener("click", () => {
          setLocale(currentLocale === "ko" ? "en" : "ko");
        });
      }
    }
  }

  /** @description Persist and apply a new dashboard locale */
  function setLocale(locale) {
    const nextLocale = _normalizeLocale(locale);
    const changed = nextLocale !== currentLocale;
    try {
      globalScope.localStorage?.setItem(STORAGE_KEY, nextLocale);
    } catch {
      // Language persistence is optional when browser storage is unavailable.
    }
    if (!changed) {
      return currentLocale;
    }
    currentLocale = nextLocale;
    applyDocument();
    if (typeof globalScope.dispatchEvent === "function") {
      globalScope.dispatchEvent(new CustomEvent(LOCALE_EVENT, {
        detail: { locale: currentLocale },
      }));
    }
    return currentLocale;
  }

  const api = {
    LOCALE_EVENT,
    STORAGE_KEY,
    applyDocument,
    getLocale,
    setLocale,
    t,
  };

  globalScope.MazeBenchI18n = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  applyDocument();
}(globalThis));
