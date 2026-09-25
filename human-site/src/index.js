import { MAZES, MAZE_BY_ID } from "../.build/maze-catalog.generated.js";

/**
 * @file human-site/src/index.js
 * @description 사람 플레이 API와 정적 자산 제공
 */




/* =================================== 전역 상수/변수 =================================== */


const VALID_ACTIONS = new Set(["S", "B", "L", "R"]);
const DIRECTIONS = ["N", "E", "S", "W"];
const TURN = { S: 0, R: 1, B: 2, L: 3 };
const EXPORT_PAGE_SIZE = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_PROBLEM_FIELDS = [
  "problem_id",
  "width",
  "height",
  "image_size",
  "start_cell",
  "goal_cell",
  "start_side",
  "goal_side",
  "initial_facing",
  "events",
  "transitions",
];





/* =================================== 헬퍼/유틸 =================================== */


/** @description JSON 응답 생성 */
function _json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/** @description JSON 요청 본문 파싱 */
async function _readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** @description 브라우저 식별자 검증 및 정규화 */
function _browserId(request) {
  const value = request.headers.get("X-Browser-ID");
  return value && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

/** @description 클라이언트 미로 재생에 필요한 공개 문제 데이터 구성 */
function _activeProblem(problem) {
  return Object.fromEntries(ACTIVE_PROBLEM_FIELDS.map((field) => [field, problem[field]]));
}

/** @description 시도 데이터의 공개 응답 형태 구성 */
function _toAttempt(row) {
  if (!row) return null;
  const maze = MAZE_BY_ID.get(row.maze_id);
  const attempt = {
    id: row.id,
    maze: {
      maze_id: row.maze_id,
      tier: row.tier,
      width: maze.problem.width,
      height: maze.problem.height,
      image_url: maze.image_url,
    },
    actions: JSON.parse(row.actions_json),
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
  if (row.status !== "active") {
    attempt.result = {
      score: row.score,
      successful_moves: row.successful_moves,
      remaining_moves: row.remaining_moves,
      optimal_moves: row.optimal_moves,
      completion_ratio: row.completion_ratio,
      efficiency_ratio: row.efficiency_ratio,
    };
    attempt.problem = maze.problem;
  } else {
    attempt.problem = _activeProblem(maze.problem);
  }
  return attempt;
}

/** @description 활성 시도 또는 가장 최근 종료 시도 조회 */
async function _sessionRow(db, browserId) {
  const active = await db.prepare(
    "SELECT * FROM attempts WHERE browser_id = ? AND status = 'active' LIMIT 1",
  ).bind(browserId).first();
  if (active) return active;
  return db.prepare(
    `SELECT attempts.* FROM attempts
     JOIN terminal_exports ON terminal_exports.attempt_id = attempts.id
     WHERE attempts.browser_id = ?
     ORDER BY terminal_exports.sequence DESC LIMIT 1`,
  ).bind(browserId).first();
}

/** @description 세션 응답 구성 */
async function _sessionResult(db, browserId, row) {
  const { count } = await db.prepare(
    "SELECT COUNT(*) AS count FROM attempts WHERE browser_id = ?",
  ).bind(browserId).first();
  return {
    attempt: _toAttempt(row),
    exhausted: !row || row.status !== "active" ? count >= MAZES.length : false,
  };
}

/** @description 상한 미만의 균등 무작위 정수 선택 */
function _randomIndex(bound) {
  const range = 0x1_0000_0000;
  const ceiling = Math.floor(range / bound) * bound;
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= ceiling);
  return value[0] % bound;
}

/** @description 브라우저 소유 시도 조회 */
async function _ownedAttempt(db, attemptId, browserId) {
  return db.prepare(
    "SELECT * FROM attempts WHERE id = ? AND browser_id = ? LIMIT 1",
  ).bind(attemptId, browserId).first();
}

/** @description 상대 명령에 따른 바라보는 방향 회전 */
function _rotate(facing, action) {
  return DIRECTIONS[(DIRECTIONS.indexOf(facing) + TURN[action]) % DIRECTIONS.length];
}

/** @description 미로 상태에서 목표까지 최단 명령 수 계산 */
function _remainingDistance(problem, startEvent, startFacing) {
  const queue = [[startEvent, startFacing, 0]];
  const visited = new Set([`${startEvent}:${startFacing}`]);
  for (let index = 0; index < queue.length; index += 1) {
    const [event, facing, distance] = queue[index];
    if (event === "GOAL_OUT") return distance;
    for (const [direction, edge] of Object.entries(problem.transitions[event])) {
      const key = `${edge.to}:${direction}`;
      if (!visited.has(key)) {
        visited.add(key);
        queue.push([edge.to, direction, distance + 1]);
      }
    }
  }
  throw new Error(`Maze goal is unreachable from ${startEvent} facing ${startFacing}`);
}

/**
 * @description MazeScorer의 완주율·효율 점수 계산
 * @param {object} problem 원본 미로 데이터
 * @param {string[]} actions 입력 명령 목록
 * @returns {object} 종료 상태와 점수
 */
export function scoreActions(problem, actions) {
  const simulation = _simulateActions(problem, actions);
  const remainingMoves = simulation.success ? 0 : _remainingDistance(problem, simulation.event, simulation.facing);
  const total = simulation.successfulMoves + remainingMoves;
  const optimalMoves = problem.optimal_action_count;
  const completionRatio = total > 0 ? simulation.successfulMoves / total : 0;
  const efficiencyRatio = total > 0 ? optimalMoves / total : 1;
  return {
    score: 100 * completionRatio * efficiencyRatio,
    successful_moves: simulation.successfulMoves,
    remaining_moves: remainingMoves,
    optimal_moves: optimalMoves,
    completion_ratio: completionRatio,
    efficiency_ratio: efficiencyRatio,
    success: simulation.success,
    collision: simulation.collision,
  };
}

/** @description 시작 상태부터 명령 목록 재생 */
function _simulateActions(problem, actions) {
  let event = "START_OUT";
  let facing = problem.initial_facing;
  let successfulMoves = 0;
  let success = false;
  let collision = false;
  let processedActions = 0;
  for (const action of actions) {
    processedActions += 1;
    if (!VALID_ACTIONS.has(action)) {
      collision = true;
      break;
    }
    const direction = _rotate(facing, action);
    const edge = problem.transitions[event][direction];
    if (!edge) {
      collision = true;
      break;
    }
    event = edge.to;
    facing = direction;
    successfulMoves += 1;
    if (event === "GOAL_OUT") {
      success = true;
      break;
    }
  }
  return { event, facing, successfulMoves, processedActions, success, collision };
}





/* =================================== 메인 로직 =================================== */


/** @description 해답·위치를 제외한 현재 세션 응답 */
async function _getSession(request, env) {
  const browserId = _browserId(request);
  if (!browserId) return _json({ error: "invalid_browser_id" }, 400);
  const row = await _sessionRow(env.DB, browserId);
  return _json(await _sessionResult(env.DB, browserId, row));
}

/** @description 브라우저의 고유 미로 시도 시작 또는 이어하기 */
async function _startAttempt(request, env) {
  const browserId = _browserId(request);
  if (!browserId) return _json({ error: "invalid_browser_id" }, 400);
  const body = await _readJson(request);
  if (!body || Array.isArray(body) || Object.keys(body).length !== 0) {
    return _json({ error: "invalid_request" }, 400);
  }

  const active = await _sessionRow(env.DB, browserId);
  if (active?.status === "active") {
    return _json(await _sessionResult(env.DB, browserId, active));
  }

  const { results: triedRows } = await env.DB.prepare(
    "SELECT maze_id FROM attempts WHERE browser_id = ?",
  ).bind(browserId).all();
  const tried = new Set(triedRows.map(({ maze_id }) => maze_id));
  const available = MAZES.filter(({ problem }) => !tried.has(problem.problem_id));
  if (available.length === 0) {
    return _json(await _sessionResult(env.DB, browserId, active));
  }

  const maze = available[_randomIndex(available.length)];
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO attempts
       (id, browser_id, maze_id, tier, status, facing, started_at)
     SELECT ?, ?, ?, ?, 'active', ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM attempts WHERE browser_id = ? AND status = 'active'
     )`,
  ).bind(
    id,
    browserId,
    maze.problem.problem_id,
    maze.tier,
    maze.problem.initial_facing,
    new Date().toISOString(),
    browserId,
  ).run();

  const current = await _sessionRow(env.DB, browserId);
  return _json(await _sessionResult(env.DB, browserId, current));
}

/** @description 충돌 응답에 최신 시도 상태 포함 */
async function _conflict(db, browserId, row, code, status = 409) {
  return _json({ ...(await _sessionResult(db, browserId, row)), error: code }, status);
}

/**
 * @description 이동 명령을 한 번만 저장하고 오래된 명령 충돌 처리
 * @param {Request} request 명령 요청
 * @param {object} env Worker 바인딩
 * @param {string} attemptId 시도 식별자
 * @returns {Promise<Response>} 명령 적용 결과
 */
async function _applyAction(request, env, attemptId) {
  const browserId = _browserId(request);
  if (!browserId) return _json({ error: "invalid_browser_id" }, 400);
  const body = await _readJson(request);
  if (
    !body || Array.isArray(body) || !Number.isSafeInteger(body.sequence) || body.sequence < 1 ||
    typeof body.request_id !== "string" || !UUID_PATTERN.test(body.request_id) ||
    typeof body.action !== "string" || body.action.length !== 1 || !VALID_ACTIONS.has(body.action)
  ) {
    return _json({ error: "invalid_request" }, 400);
  }
  const action = body.action;
  const requestId = body.request_id.toLowerCase();
  const row = await _ownedAttempt(env.DB, attemptId, browserId);
  if (!row) return _json({ error: "attempt_not_found" }, 404);

  const priorRequest = await env.DB.prepare(
    "SELECT attempt_id, sequence, kind, action FROM commands WHERE request_id = ?",
  ).bind(requestId).first();
  if (priorRequest) {
    if (
      priorRequest.attempt_id !== attemptId || priorRequest.sequence !== body.sequence ||
      priorRequest.kind !== "action" || priorRequest.action !== action
    ) {
      return _conflict(env.DB, browserId, row, "request_id_conflict");
    }
    return _json(await _sessionResult(env.DB, browserId, await _ownedAttempt(env.DB, attemptId, browserId)));
  }
  if (row.status !== "active") return _conflict(env.DB, browserId, row, "attempt_finished");
  if (body.sequence !== row.command_count + 1) {
    return _conflict(env.DB, browserId, row, "sequence_conflict");
  }

  const maze = MAZE_BY_ID.get(row.maze_id);
  const actions = JSON.parse(row.actions_json);
  actions.push(action);
  const direction = _rotate(row.facing, action);
  const edge = maze.problem.transitions[row.current_event][direction];
  const currentEvent = edge ? edge.to : row.current_event;
  const facing = edge ? direction : row.facing;
  const status = !edge ? "collision" : currentEvent === "GOAL_OUT" ? "success" : "active";
  const score = status === "active" ? null : scoreActions(maze.problem, actions);
  const result = status === "active" ? {
    score: null,
    successful_moves: null,
    remaining_moves: null,
    optimal_moves: null,
    completion_ratio: null,
    efficiency_ratio: null,
  } : score;
  const finishedAt = status === "active" ? null : new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO commands (attempt_id, sequence, request_id, kind, action)
       SELECT ?, ?, ?, 'action', ? FROM attempts
       WHERE id = ? AND browser_id = ? AND status = 'active' AND command_count = ?`,
    ).bind(attemptId, body.sequence, requestId, action, attemptId, browserId, body.sequence - 1),
    env.DB.prepare(
      `UPDATE attempts SET actions_json = ?, command_count = ?, current_event = ?, facing = ?,
         status = ?, finished_at = ?, score = ?, successful_moves = ?, remaining_moves = ?,
         optimal_moves = ?, completion_ratio = ?, efficiency_ratio = ?
       WHERE id = ? AND browser_id = ? AND status = 'active' AND command_count = ?
         AND EXISTS (
           SELECT 1 FROM commands WHERE attempt_id = ? AND sequence = ? AND request_id = ?
             AND kind = 'action' AND action = ?
         )`,
    ).bind(
      JSON.stringify(actions),
      body.sequence,
      currentEvent,
      facing,
      status,
      finishedAt,
      result.score,
      result.successful_moves,
      result.remaining_moves,
      result.optimal_moves,
      result.completion_ratio,
      result.efficiency_ratio,
      attemptId,
      browserId,
      body.sequence - 1,
      attemptId,
      body.sequence,
      requestId,
      action,
    ),
  ]);

  const updated = await _ownedAttempt(env.DB, attemptId, browserId);
  const persistedRequest = await env.DB.prepare(
    "SELECT attempt_id, sequence, kind, action FROM commands WHERE request_id = ?",
  ).bind(requestId).first();
  if (
    persistedRequest?.attempt_id === attemptId && persistedRequest.sequence === body.sequence &&
    persistedRequest.kind === "action" && persistedRequest.action === action
  ) {
    return _json(await _sessionResult(env.DB, browserId, updated));
  }
  return _conflict(env.DB, browserId, updated, "sequence_conflict");
}

/**
 * @description 이동 명령 추가 없이 활성 시도 종료
 * @param {Request} request 종료 요청
 * @param {object} env Worker 바인딩
 * @param {string} attemptId 시도 식별자
 * @returns {Promise<Response>} 종료 결과
 */
async function _quitAttempt(request, env, attemptId) {
  const browserId = _browserId(request);
  if (!browserId) return _json({ error: "invalid_browser_id" }, 400);
  const body = await _readJson(request);
  if (
    !body || Array.isArray(body) || !Number.isSafeInteger(body.sequence) || body.sequence < 1 ||
    typeof body.request_id !== "string" || !UUID_PATTERN.test(body.request_id)
  ) {
    return _json({ error: "invalid_request" }, 400);
  }
  const requestId = body.request_id.toLowerCase();
  const row = await _ownedAttempt(env.DB, attemptId, browserId);
  if (!row) return _json({ error: "attempt_not_found" }, 404);

  const priorRequest = await env.DB.prepare(
    "SELECT attempt_id, sequence, kind, action FROM commands WHERE request_id = ?",
  ).bind(requestId).first();
  if (priorRequest) {
    if (
      priorRequest.attempt_id !== attemptId || priorRequest.sequence !== body.sequence ||
      priorRequest.kind !== "quit"
    ) {
      return _conflict(env.DB, browserId, row, "request_id_conflict");
    }
    return _json(await _sessionResult(env.DB, browserId, await _ownedAttempt(env.DB, attemptId, browserId)));
  }
  if (row.status !== "active") return _conflict(env.DB, browserId, row, "attempt_finished");
  if (body.sequence !== row.command_count + 1) {
    return _conflict(env.DB, browserId, row, "sequence_conflict");
  }

  const maze = MAZE_BY_ID.get(row.maze_id);
  const actions = JSON.parse(row.actions_json);
  const score = scoreActions(maze.problem, actions);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO commands (attempt_id, sequence, request_id, kind, action)
       SELECT ?, ?, ?, 'quit', NULL FROM attempts
       WHERE id = ? AND browser_id = ? AND status = 'active' AND command_count = ?`,
    ).bind(attemptId, body.sequence, requestId, attemptId, browserId, body.sequence - 1),
    env.DB.prepare(
      `UPDATE attempts SET command_count = ?, status = 'quit', finished_at = ?, score = ?,
         successful_moves = ?, remaining_moves = ?, optimal_moves = ?, completion_ratio = ?,
         efficiency_ratio = ?
       WHERE id = ? AND browser_id = ? AND status = 'active' AND command_count = ?
         AND EXISTS (
           SELECT 1 FROM commands WHERE attempt_id = ? AND sequence = ? AND request_id = ?
             AND kind = 'quit' AND action IS NULL
         )`,
    ).bind(
      body.sequence,
      new Date().toISOString(),
      score.score,
      score.successful_moves,
      score.remaining_moves,
      score.optimal_moves,
      score.completion_ratio,
      score.efficiency_ratio,
      attemptId,
      browserId,
      body.sequence - 1,
      attemptId,
      body.sequence,
      requestId,
    ),
  ]);

  const updated = await _ownedAttempt(env.DB, attemptId, browserId);
  const persistedRequest = await env.DB.prepare(
    "SELECT attempt_id, sequence, kind, action FROM commands WHERE request_id = ?",
  ).bind(requestId).first();
  if (
    persistedRequest?.attempt_id === attemptId && persistedRequest.sequence === body.sequence &&
    persistedRequest.kind === "quit" && persistedRequest.action === null
  ) {
    return _json(await _sessionResult(env.DB, browserId, updated));
  }
  return _conflict(env.DB, browserId, updated, "sequence_conflict");
}

/**
 * @description 제출된 동작을 재생·채점하고 시도를 한 번에 종료
 * @param {Request} request 완료 요청
 * @param {object} env Worker 바인딩
 * @param {string} attemptId 시도 식별자
 * @returns {Promise<Response>} 종료 결과
 */
async function _completeAttempt(request, env, attemptId) {
  const browserId = _browserId(request);
  if (!browserId) return _json({ error: "invalid_browser_id" }, 400);
  const body = await _readJson(request);
  if (
    !body || Array.isArray(body) || Object.keys(body).length !== 2 ||
    !Array.isArray(body.actions) || typeof body.quit !== "boolean" ||
    !body.actions.every((action) => typeof action === "string" && VALID_ACTIONS.has(action))
  ) {
    return _json({ error: "invalid_request" }, 400);
  }

  const requestedActionsJson = JSON.stringify(body.actions);
  let row = await _ownedAttempt(env.DB, attemptId, browserId);
  if (!row) return _json({ error: "attempt_not_found" }, 404);

  while (true) {
    if (row.status !== "active") {
      if (
        row.actions_json === requestedActionsJson &&
        (row.status === "quit") === body.quit
      ) {
        return _json(await _sessionResult(env.DB, browserId, row));
      }
      return _conflict(env.DB, browserId, row, "attempt_finished");
    }

    const priorActions = JSON.parse(row.actions_json);
    if (
      priorActions.length > body.actions.length ||
      priorActions.some((action, index) => action !== body.actions[index])
    ) {
      return _conflict(env.DB, browserId, row, "actions_conflict");
    }

    const problem = MAZE_BY_ID.get(row.maze_id).problem;
    const simulation = _simulateActions(problem, body.actions);
    if (simulation.processedActions !== body.actions.length) {
      return _json({ error: "invalid_request" }, 400);
    }
    const terminalStatus = simulation.success ? "success" : simulation.collision ? "collision" : "active";
    if (body.quit ? terminalStatus !== "active" : terminalStatus === "active") {
      return _json({ error: "invalid_request" }, 400);
    }

    const status = body.quit ? "quit" : terminalStatus;
    const score = scoreActions(problem, body.actions);
    await env.DB.prepare(
      `UPDATE attempts SET actions_json = ?, command_count = ?, current_event = ?, facing = ?,
         status = ?, finished_at = ?, score = ?, successful_moves = ?, remaining_moves = ?,
         optimal_moves = ?, completion_ratio = ?, efficiency_ratio = ?
       WHERE id = ? AND browser_id = ? AND status = 'active' AND command_count = ?
         AND actions_json = ?`,
    ).bind(
      requestedActionsJson,
      body.actions.length + Number(body.quit),
      simulation.event,
      simulation.facing,
      status,
      new Date().toISOString(),
      score.score,
      score.successful_moves,
      score.remaining_moves,
      score.optimal_moves,
      score.completion_ratio,
      score.efficiency_ratio,
      attemptId,
      browserId,
      row.command_count,
      row.actions_json,
    ).run();

    row = await _ownedAttempt(env.DB, attemptId, browserId);
    if (row.status !== "active") {
      if (row.actions_json === requestedActionsJson && row.status === status) {
        return _json(await _sessionResult(env.DB, browserId, row));
      }
      return _conflict(env.DB, browserId, row, "attempt_finished");
    }
  }
}

/** @description 0 이상 커서 값 파싱 */
function _cursor(value, fallback) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * @description 변경 불가·개인 식별자 제외 종료 기록 스냅샷 내보내기
 * @param {Request} request 내보내기 요청
 * @param {object} env Worker 바인딩
 * @returns {Promise<Response>} 페이지 단위 결과
 */
async function _export(request, env) {
  if (!env.EXPORT_TOKEN) return _json({ error: "export_unavailable" }, 503);
  if (request.headers.get("Authorization") !== `Bearer ${env.EXPORT_TOKEN}`) {
    return _json({ error: "unauthorized" }, 401);
  }
  if (env.DATASET !== "verification" && env.DATASET !== "production") {
    return _json({ error: "invalid_dataset_configuration" }, 500);
  }
  const url = new URL(request.url);
  const after = _cursor(url.searchParams.get("after"), 0);
  const requestedThrough = _cursor(url.searchParams.get("through"), null);
  if (after === null || requestedThrough === null && url.searchParams.has("through")) {
    return _json({ error: "invalid_cursor" }, 400);
  }
  const { maximum } = await env.DB.prepare(
    "SELECT COALESCE(MAX(sequence), 0) AS maximum FROM terminal_exports",
  ).first();
  const through = requestedThrough === null ? maximum : Math.min(requestedThrough, maximum);
  const [countResult, recordResult] = await env.DB.batch([
    env.DB.prepare(
      `SELECT attempts.tier, COUNT(DISTINCT attempts.browser_id) AS participants
       FROM terminal_exports
       JOIN attempts ON attempts.id = terminal_exports.attempt_id
       WHERE terminal_exports.sequence <= ?
       GROUP BY attempts.tier`,
    ).bind(through),
    env.DB.prepare(
      `SELECT terminal_exports.sequence, attempts.id AS attempt_id, attempts.maze_id,
          attempts.tier, attempts.actions_json, attempts.status, attempts.started_at,
          attempts.finished_at
       FROM terminal_exports
       JOIN attempts ON attempts.id = terminal_exports.attempt_id
       WHERE terminal_exports.sequence > ? AND terminal_exports.sequence <= ?
       ORDER BY terminal_exports.sequence LIMIT ?`,
    ).bind(after, through, EXPORT_PAGE_SIZE + 1),
  ]);
  const participantCounts = { "1": 0, "2": 0 };
  for (const count of countResult.results) participantCounts[String(count.tier)] = count.participants;
  const hasMore = recordResult.results.length > EXPORT_PAGE_SIZE;
  const records = recordResult.results.slice(0, EXPORT_PAGE_SIZE).map((row) => ({
    sequence: row.sequence,
    attempt_id: row.attempt_id,
    maze_id: row.maze_id,
    tier: String(row.tier),
    actions: JSON.parse(row.actions_json),
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at,
  }));
  return _json({
    schema_version: 1,
    dataset: env.DATASET,
    through,
    next_cursor: records.length > 0 ? records.at(-1).sequence : after,
    has_more: hasMore,
    participant_counts: participantCounts,
    records,
  });
}





/* =================================== 이벤트/내보내기 =================================== */


/** @description API 요청 분기 및 정적 자산 제공 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/session") {
      return request.method === "GET" ? _getSession(request, env) : _json({ error: "method_not_allowed" }, 405);
    }
    if (url.pathname === "/api/start") {
      return request.method === "POST" ? _startAttempt(request, env) : _json({ error: "method_not_allowed" }, 405);
    }
    if (url.pathname === "/api/export") {
      return request.method === "GET" ? _export(request, env) : _json({ error: "method_not_allowed" }, 405);
    }
    const completeMatch = url.pathname.match(/^\/api\/attempts\/([^/]+)\/complete$/);
    if (completeMatch) {
      return request.method === "POST"
        ? _completeAttempt(request, env, completeMatch[1])
        : _json({ error: "method_not_allowed" }, 405);
    }
    const actionMatch = url.pathname.match(/^\/api\/attempts\/([^/]+)\/actions$/);
    if (actionMatch) {
      return request.method === "POST"
        ? _applyAction(request, env, actionMatch[1])
        : _json({ error: "method_not_allowed" }, 405);
    }
    const quitMatch = url.pathname.match(/^\/api\/attempts\/([^/]+)\/quit$/);
    if (quitMatch) {
      return request.method === "POST"
        ? _quitAttempt(request, env, quitMatch[1])
        : _json({ error: "method_not_allowed" }, 405);
    }
    if (url.pathname.startsWith("/api/")) return _json({ error: "not_found" }, 404);
    if (url.pathname.startsWith("/mazes/")) {
      const maze = MAZES.find(({ image_url }) => image_url === url.pathname);
      if (!maze) return new Response("Not Found", { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};
