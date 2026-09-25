import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MAZES, MAZE_BY_ID } from "../.build/maze-catalog.generated.js";
import { scoreActions } from "../src/index.js";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(siteRoot, "..");
const wrangler = path.join(siteRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const devVarsPath = path.join(siteRoot, ".dev.vars");
const configuredExportToken = existsSync(devVarsPath)
  ? readFileSync(devVarsPath, "utf8").split(/\r?\n/)
    .find((line) => line.startsWith("EXPORT_TOKEN="))?.slice("EXPORT_TOKEN=".length)
  : null;
const exportToken = configuredExportToken || "human-site-test-export-token";
const pythonScorer = [
  "import json, sys",
  "sys.path.insert(0, 'scripts')",
  "from maze_benchmark import MazeProblem, MazeScorer",
  "payload = json.load(sys.stdin)",
  "result = MazeScorer(MazeProblem(**payload['problem'])).score_actions(payload['actions'])",
  "print(json.dumps(result.to_jsonable()))",
].join("\n");
const activeProblemFields = [
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

/** @description 사용 가능한 로컬 포트 예약 */
async function _freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

/** @description Wrangler 로컬 서버 실행 및 준비 대기 */
async function _startServer(port, persistence) {
  const argumentsList = [
    wrangler,
    "dev",
    "--local",
    "--config",
    "wrangler.toml",
    "--persist-to",
    persistence,
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
  ];
  if (!configuredExportToken) argumentsList.push("--var", `EXPORT_TOKEN:${exportToken}`);
  argumentsList.push("--log-level", "error");
  const child = spawn(process.execPath, argumentsList, {
    cwd: siteRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });

  for (let retry = 0; retry < 100; retry += 1) {
    if (child.exitCode !== null) throw new Error(`Wrangler exited early:\n${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/session`);
      if (response.status === 400) return { child, output: () => output };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`Wrangler did not start:\n${output}`);
}

/** @description 로컬 API 요청 전송 */
async function _request(baseUrl, browserId, route, options = {}) {
  const headers = { "X-Browser-ID": browserId };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() };
}

/** @description 절대 방향에 해당하는 상대 명령 계산 */
function _relativeAction(facing, direction) {
  const directions = ["N", "E", "S", "W"];
  const actions = ["S", "R", "B", "L"];
  return actions[(directions.indexOf(direction) - directions.indexOf(facing) + 4) % 4];
}

/** @description 후진 명령으로 이동하는 합법 경로 탐색 */
function _routeWithBack(problem) {
  const initial = {
    event: "START_OUT",
    facing: problem.initial_facing,
    usedBack: false,
    actions: [],
  };
  const queue = [initial];
  const visited = new Set([`${initial.event}:${initial.facing}:0`]);
  for (let index = 0; index < queue.length; index += 1) {
    const state = queue[index];
    if (state.event === "GOAL_OUT" && state.usedBack) return state.actions;
    for (const [direction, edge] of Object.entries(problem.transitions[state.event])) {
      const action = _relativeAction(state.facing, direction);
      const usedBack = state.usedBack || action === "B";
      const key = `${edge.to}:${direction}:${usedBack ? 1 : 0}`;
      if (!visited.has(key)) {
        visited.add(key);
        queue.push({
          event: edge.to,
          facing: direction,
          usedBack,
          actions: [...state.actions, action],
        });
      }
    }
  }
  throw new Error(`No legal route with B found for ${problem.problem_id}`);
}

/** @description Worker 점수를 Python MazeScorer 결과와 대조 */
function _assertScoringParity(problem, actions) {
  const python = spawnSync("python", ["-c", pythonScorer], {
    cwd: repoRoot,
    input: JSON.stringify({ problem, actions }),
    encoding: "utf8",
  });
  assert.equal(python.status, 0, python.stderr);
  const expected = JSON.parse(python.stdout);
  const actual = scoreActions(problem, actions);
  assert.equal(actual.success, expected.success);
  assert.equal(actual.collision, expected.death);
  assert.equal(actual.successful_moves, expected.actual_action_count);
  assert.equal(actual.remaining_moves, expected.remaining_action_count);
  assert.equal(actual.optimal_moves, expected.optimal_action_count);
  assert.ok(Math.abs(actual.score - expected.score) < 1e-10);
  assert.ok(Math.abs(actual.completion_ratio - expected.completion_ratio) < 1e-10);
  assert.ok(Math.abs(actual.efficiency_ratio - expected.efficiency_ratio) < 1e-10);
  return actual;
}

/** @description 활성 시도의 공개 문제 그래프와 답안 비공개 확인 */
function _assertActiveProblem(attempt, problem) {
  const expected = Object.fromEntries(activeProblemFields.map((field) => [field, problem[field]]));
  assert.deepEqual(attempt.problem, expected);
  for (const field of ["answer_actions", "answer_event_path", "optimal_action_count"]) {
    assert.equal(Object.hasOwn(attempt.problem, field), false);
  }
}

/** @description 저장된 완료 점수와 Python MazeScorer 결과 대조 */
function _assertAttemptScoringParity(problem, attempt, actions) {
  const expected = _assertScoringParity(problem, actions);
  for (const field of [
    "score",
    "successful_moves",
    "remaining_moves",
    "optimal_moves",
    "completion_ratio",
    "efficiency_ratio",
  ]) {
    assert.ok(Math.abs(attempt.result[field] - expected[field]) < 1e-10, field);
  }
  return expected;
}

test("human-play D1 worker contracts", async (t) => {
  const persistence = await mkdtemp(path.join(os.tmpdir(), "maze-human-d1-"));
  const port = await _freePort();
  const migration = spawnSync(process.execPath, [
    wrangler,
    "d1",
    "migrations",
    "apply",
    "maze-bench-human-play",
    "--local",
    "--config",
    "wrangler.toml",
    "--persist-to",
    persistence,
  ], { cwd: siteRoot, encoding: "utf8" });
  assert.equal(migration.status, 0, `${migration.stdout}\n${migration.stderr}`);
  const server = await _startServer(port, persistence);
  const baseUrl = `http://127.0.0.1:${port}`;
  const completed = new Map([["1", new Set()], ["2", new Set()]]);
  const knownBrowsers = new Set();
  const bulkCompletionIds = new Set();

  const rememberCompletion = (browserId, attempt) => {
    const tier = String(attempt.maze.tier);
    assert.ok(completed.has(tier), `Unexpected attempt metadata: ${JSON.stringify(attempt.maze)}`);
    completed.get(tier).add(browserId);
    knownBrowsers.add(browserId);
  };

  try {
    await t.test("bulk completion validation, retries, races, legacy prefixes, and score parity", async () => {
      const successBrowser = crypto.randomUUID();
      const successStart = await _request(baseUrl, successBrowser, "/api/start", {
        method: "POST",
        body: {},
      });
      const successAttempt = successStart.body.attempt;
      const successProblem = MAZE_BY_ID.get(successAttempt.maze.maze_id).problem;
      const successActions = successProblem.answer_actions;
      _assertActiveProblem(successAttempt, successProblem);

      const successBody = { actions: successActions, quit: false };
      const success = await _request(
        baseUrl,
        successBrowser,
        `/api/attempts/${successAttempt.id}/complete`,
        { method: "POST", body: successBody },
      );
      assert.equal(success.status, 200);
      assert.equal(success.body.attempt.status, "success");
      assert.deepEqual(success.body.attempt.actions, successActions);
      _assertAttemptScoringParity(successProblem, success.body.attempt, successActions);
      rememberCompletion(successBrowser, success.body.attempt);
      bulkCompletionIds.add(successAttempt.id);

      const lostResponseRetry = await _request(
        baseUrl,
        successBrowser,
        `/api/attempts/${successAttempt.id}/complete`,
        { method: "POST", body: successBody },
      );
      assert.equal(lostResponseRetry.status, 200);
      assert.deepEqual(lostResponseRetry.body, success.body);
      const divergentRetry = await _request(
        baseUrl,
        successBrowser,
        `/api/attempts/${successAttempt.id}/complete`,
        { method: "POST", body: { actions: successActions.slice(0, -1), quit: false } },
      );
      assert.equal(divergentRetry.status, 409);
      assert.equal(divergentRetry.body.error, "attempt_finished");
      assert.deepEqual(divergentRetry.body.attempt, lostResponseRetry.body.attempt);

      const collisionBrowser = crypto.randomUUID();
      const collisionStart = await _request(baseUrl, collisionBrowser, "/api/start", {
        method: "POST",
        body: {},
      });
      const collisionAttempt = collisionStart.body.attempt;
      const collisionProblem = MAZE_BY_ID.get(collisionAttempt.maze.maze_id).problem;
      const openStartDirections = new Set(Object.keys(collisionProblem.transitions.START_OUT));
      const collisionAction = ["S", "B", "L", "R"].find((action) => {
        const direction = ["N", "E", "S", "W"][(
          ["N", "E", "S", "W"].indexOf(collisionProblem.initial_facing) + { S: 0, R: 1, B: 2, L: 3 }[action]
        ) % 4];
        return !openStartDirections.has(direction);
      });
      assert.ok(collisionAction);
      const collision = await _request(
        baseUrl,
        collisionBrowser,
        `/api/attempts/${collisionAttempt.id}/complete`,
        { method: "POST", body: { actions: [collisionAction], quit: false } },
      );
      assert.equal(collision.status, 200);
      assert.equal(collision.body.attempt.status, "collision");
      _assertAttemptScoringParity(collisionProblem, collision.body.attempt, [collisionAction]);
      rememberCompletion(collisionBrowser, collision.body.attempt);
      bulkCompletionIds.add(collisionAttempt.id);

      const quitBrowser = crypto.randomUUID();
      const quitStart = await _request(baseUrl, quitBrowser, "/api/start", {
        method: "POST",
        body: {},
      });
      const quitAttempt = quitStart.body.attempt;
      const quitProblem = MAZE_BY_ID.get(quitAttempt.maze.maze_id).problem;
      const quitActions = quitProblem.answer_actions.slice(0, 1);
      const quit = await _request(
        baseUrl,
        quitBrowser,
        `/api/attempts/${quitAttempt.id}/complete`,
        { method: "POST", body: { actions: quitActions, quit: true } },
      );
      assert.equal(quit.status, 200);
      assert.equal(quit.body.attempt.status, "quit");
      assert.deepEqual(quit.body.attempt.actions, quitActions);
      _assertAttemptScoringParity(quitProblem, quit.body.attempt, quitActions);
      rememberCompletion(quitBrowser, quit.body.attempt);
      bulkCompletionIds.add(quitAttempt.id);

      const legacyBrowser = crypto.randomUUID();
      const legacyStart = await _request(baseUrl, legacyBrowser, "/api/start", {
        method: "POST",
        body: {},
      });
      const legacyAttempt = legacyStart.body.attempt;
      const legacyProblem = MAZE_BY_ID.get(legacyAttempt.maze.maze_id).problem;
      const legacyActions = legacyProblem.answer_actions;
      const legacyPrefix = await _request(
        baseUrl,
        legacyBrowser,
        `/api/attempts/${legacyAttempt.id}/actions`,
        {
          method: "POST",
          body: { sequence: 1, request_id: crypto.randomUUID(), action: legacyActions[0] },
        },
      );
      assert.equal(legacyPrefix.status, 200);
      assert.equal(legacyPrefix.body.attempt.status, "active");
      const conflictingPrefix = await _request(
        baseUrl,
        legacyBrowser,
        `/api/attempts/${legacyAttempt.id}/complete`,
        {
          method: "POST",
          body: { actions: [["S", "B", "L", "R"].find((action) => action !== legacyActions[0]), ...legacyActions.slice(1)], quit: false },
        },
      );
      assert.equal(conflictingPrefix.status, 409);
      assert.equal(conflictingPrefix.body.error, "actions_conflict");
      assert.deepEqual(conflictingPrefix.body.attempt.actions, [legacyActions[0]]);
      const continued = await _request(
        baseUrl,
        legacyBrowser,
        `/api/attempts/${legacyAttempt.id}/complete`,
        { method: "POST", body: { actions: legacyActions, quit: false } },
      );
      assert.equal(continued.status, 200);
      assert.equal(continued.body.attempt.status, "success");
      assert.deepEqual(continued.body.attempt.actions, legacyActions);
      _assertAttemptScoringParity(legacyProblem, continued.body.attempt, legacyActions);
      rememberCompletion(legacyBrowser, continued.body.attempt);
      bulkCompletionIds.add(legacyAttempt.id);

      const invalidBrowser = crypto.randomUUID();
      const invalidStart = await _request(baseUrl, invalidBrowser, "/api/start", {
        method: "POST",
        body: {},
      });
      const invalidAttempt = invalidStart.body.attempt;
      const invalidProblem = MAZE_BY_ID.get(invalidAttempt.maze.maze_id).problem;
      const invalidOpenDirections = new Set(Object.keys(invalidProblem.transitions.START_OUT));
      const invalidCollisionAction = ["S", "B", "L", "R"].find((action) => {
        const direction = ["N", "E", "S", "W"][(
          ["N", "E", "S", "W"].indexOf(invalidProblem.initial_facing) + { S: 0, R: 1, B: 2, L: 3 }[action]
        ) % 4];
        return !invalidOpenDirections.has(direction);
      });
      const invalidBodies = [
        { actions: [...invalidProblem.answer_actions, "S"], quit: false },
        { actions: [invalidCollisionAction, "S"], quit: false },
        { actions: invalidProblem.answer_actions.slice(0, -1), quit: false },
        { actions: invalidProblem.answer_actions, quit: true },
        { actions: ["X"], quit: false },
      ];
      for (const body of invalidBodies) {
        const invalid = await _request(
          baseUrl,
          invalidBrowser,
          `/api/attempts/${invalidAttempt.id}/complete`,
          { method: "POST", body },
        );
        assert.equal(invalid.status, 400);
        assert.equal(invalid.body.error, "invalid_request");
      }
      const closeInvalidAttempt = await _request(
        baseUrl,
        invalidBrowser,
        `/api/attempts/${invalidAttempt.id}/complete`,
        { method: "POST", body: { actions: [], quit: true } },
      );
      assert.equal(closeInvalidAttempt.body.attempt.status, "quit");
      _assertAttemptScoringParity(invalidProblem, closeInvalidAttempt.body.attempt, []);
      rememberCompletion(invalidBrowser, closeInvalidAttempt.body.attempt);
      bulkCompletionIds.add(invalidAttempt.id);

      const concurrentBrowser = crypto.randomUUID();
      const concurrentStart = await _request(baseUrl, concurrentBrowser, "/api/start", {
        method: "POST",
        body: {},
      });
      const concurrentAttempt = concurrentStart.body.attempt;
      const concurrentProblem = MAZE_BY_ID.get(concurrentAttempt.maze.maze_id).problem;
      const concurrentOpenDirections = new Set(Object.keys(concurrentProblem.transitions.START_OUT));
      const concurrentCollisionAction = ["S", "B", "L", "R"].find((action) => {
        const direction = ["N", "E", "S", "W"][(
          ["N", "E", "S", "W"].indexOf(concurrentProblem.initial_facing) + { S: 0, R: 1, B: 2, L: 3 }[action]
        ) % 4];
        return !concurrentOpenDirections.has(direction);
      });
      const concurrentBodies = [
        { actions: concurrentProblem.answer_actions, quit: false },
        { actions: [concurrentCollisionAction], quit: false },
      ];
      const concurrentResults = await Promise.all(concurrentBodies.map((body) => _request(
        baseUrl,
        concurrentBrowser,
        `/api/attempts/${concurrentAttempt.id}/complete`,
        { method: "POST", body },
      )));
      assert.deepEqual(concurrentResults.map(({ status }) => status).sort(), [200, 409]);
      const winningIndex = concurrentResults.findIndex(({ status }) => status === 200);
      const concurrentWinner = concurrentResults[winningIndex];
      const concurrentBody = concurrentBodies[winningIndex];
      assert.equal(concurrentWinner.body.attempt.status, concurrentBody.actions.length === 1 ? "collision" : "success");
      assert.deepEqual(concurrentResults[1 - winningIndex].body.attempt, concurrentWinner.body.attempt);
      assert.equal(concurrentResults[1 - winningIndex].body.error, "attempt_finished");
      const concurrentRetry = await _request(
        baseUrl,
        concurrentBrowser,
        `/api/attempts/${concurrentAttempt.id}/complete`,
        { method: "POST", body: concurrentBody },
      );
      assert.equal(concurrentRetry.status, 200);
      assert.deepEqual(concurrentRetry.body, concurrentWinner.body);
      _assertAttemptScoringParity(concurrentProblem, concurrentWinner.body.attempt, concurrentBody.actions);
      rememberCompletion(concurrentBrowser, concurrentWinner.body.attempt);
      bulkCompletionIds.add(concurrentAttempt.id);
    });

    await t.test("maze catalog, status privacy, concurrent start, replay, and stale writes", async () => {
      assert.equal(MAZES.length, 50);
      const browserId = crypto.randomUUID();
      knownBrowsers.add(browserId);
      const starts = await Promise.all(Array.from({ length: 8 }, () => _request(baseUrl, browserId, "/api/start", {
        method: "POST",
        body: {},
      })));
      assert.ok(starts.every(({ status }) => status === 200));
      assert.equal(new Set(starts.map(({ body }) => body.attempt.id)).size, 1);
      const first = starts[0].body.attempt;
      assert.equal(first.status, "active");
      const problem = MAZE_BY_ID.get(first.maze.maze_id).problem;
      _assertActiveProblem(first, problem);
      assert.equal(Object.hasOwn(first, "result"), false);
      assert.equal(JSON.stringify(first).includes("current_event"), false);
      assert.equal(JSON.stringify(first).includes("score"), false);
      assert.equal(first.maze.image_url, `/mazes/${first.maze.maze_id}.png`);
      const image = await fetch(`${baseUrl}${first.maze.image_url}`);
      assert.equal(image.status, 200);
      assert.match(image.headers.get("content-type"), /^image\/png/);
      const repeatedStart = await _request(baseUrl, browserId, "/api/start", { method: "POST", body: {} });
      assert.equal(repeatedStart.body.attempt.id, first.id);

      const startDirections = new Set(Object.keys(problem.transitions.START_OUT));
      const actions = ["S", "B", "L", "R"]
        .filter((action) => !startDirections.has(["N", "E", "S", "W"][(
          ["N", "E", "S", "W"].indexOf(problem.initial_facing) + { S: 0, R: 1, B: 2, L: 3 }[action]
        ) % 4]));
      assert.ok(actions.length >= 2);
      const candidates = actions.slice(0, 2).map((action) => ({ action, request_id: crypto.randomUUID() }));
      const writes = await Promise.all(candidates.map((command) => _request(
        baseUrl,
        browserId,
        `/api/attempts/${first.id}/actions`,
        { method: "POST", body: { sequence: 1, ...command } },
      )));
      assert.deepEqual(writes.map(({ status }) => status).sort(), [200, 409]);
      const winnerIndex = writes.findIndex(({ status }) => status === 200);
      const winner = writes[winnerIndex];
      const winnerCommand = candidates[winnerIndex];
      assert.equal(winner.body.attempt.status, "collision");
      assert.equal(winner.body.attempt.actions.length, 1);
      assert.equal(
        winner.body.attempt.result.score,
        _assertScoringParity(problem, [winnerCommand.action]).score,
      );
      const duplicateAction = await _request(baseUrl, browserId, `/api/attempts/${first.id}/actions`, {
        method: "POST",
        body: { sequence: 1, ...winnerCommand },
      });
      assert.equal(duplicateAction.status, 200);
      assert.deepEqual(duplicateAction.body.attempt.actions, [winnerCommand.action]);
      const conflictingRetry = await _request(baseUrl, browserId, `/api/attempts/${first.id}/actions`, {
        method: "POST",
        body: { sequence: 1, request_id: winnerCommand.request_id, action: candidates[1 - winnerIndex].action },
      });
      assert.equal(conflictingRetry.status, 409);
      assert.equal(conflictingRetry.body.error, "request_id_conflict");
      assert.ok(["sequence_conflict", "attempt_finished"].includes(writes[1 - winnerIndex].body.error));
      const getAfterCollision = await _request(baseUrl, browserId, "/api/session");
      assert.equal(getAfterCollision.body.attempt.id, first.id);
      assert.equal(getAfterCollision.body.attempt.status, "collision");
      rememberCompletion(browserId, getAfterCollision.body.attempt);

      const secondStart = await _request(baseUrl, browserId, "/api/start", { method: "POST", body: {} });
      const second = secondStart.body.attempt;
      assert.equal(second.status, "active");
      assert.notEqual(second.maze.maze_id, first.maze.maze_id);
      const secondProblem = MAZE_BY_ID.get(second.maze.maze_id).problem;
      const entryDirection = Object.keys(secondProblem.transitions.START_OUT)[0];
      const entryAction = _relativeAction(secondProblem.initial_facing, entryDirection);
      const entry = await _request(baseUrl, browserId, `/api/attempts/${second.id}/actions`, {
        method: "POST",
        body: { sequence: 1, request_id: crypto.randomUUID(), action: entryAction },
      });
      assert.equal(entry.body.attempt.status, "active");
      const wrongQuit = await _request(baseUrl, browserId, `/api/attempts/${second.id}/quit`, {
        method: "POST",
        body: { sequence: 1, request_id: crypto.randomUUID() },
      });
      assert.equal(wrongQuit.status, 409);
      assert.equal(wrongQuit.body.error, "sequence_conflict");
      const quitBody = { sequence: 2, request_id: crypto.randomUUID() };
      const quit = await _request(baseUrl, browserId, `/api/attempts/${second.id}/quit`, {
        method: "POST",
        body: quitBody,
      });
      assert.equal(quit.body.attempt.status, "quit");
      assert.deepEqual(quit.body.attempt.actions, [entryAction]);
      assert.equal(quit.body.attempt.result.score, _assertScoringParity(secondProblem, [entryAction]).score);
      const duplicateQuit = await _request(baseUrl, browserId, `/api/attempts/${second.id}/quit`, {
        method: "POST",
        body: quitBody,
      });
      assert.equal(duplicateQuit.status, 200);
      assert.equal(duplicateQuit.body.attempt.id, second.id);
      rememberCompletion(browserId, quit.body.attempt);

      const staleAction = await _request(baseUrl, browserId, `/api/attempts/${first.id}/actions`, {
        method: "POST",
        body: { sequence: 1, request_id: crypto.randomUUID(), action: "S" },
      });
      assert.equal(staleAction.status, 409);
      assert.equal(staleAction.body.attempt.status, "collision");

      const assets = path.join(siteRoot, ".build", "assets");
      const files = await readdirRecursive(assets);
      assert.equal(files.filter((file) => file.startsWith("mazes/") && file.endsWith(".png")).length, 50);
      assert.equal(files.some((file) => file.endsWith(".json")), false);
    });

    await t.test("MazeScorer parity for success, collision, quit, and B movement", async () => {
      const problem = MAZE_BY_ID.get("maze_04x04_adjacent_01").problem;
      assert.equal(_assertScoringParity(problem, problem.answer_actions).success, true);
      const startOpenings = new Set(Object.keys(problem.transitions.START_OUT));
      const collisionAction = ["S", "B", "L", "R"].find((action) => {
        const facing = ["N", "E", "S", "W"][(
          ["N", "E", "S", "W"].indexOf(problem.initial_facing) + { S: 0, R: 1, B: 2, L: 3 }[action]
        ) % 4];
        return !startOpenings.has(facing);
      });
      assert.equal(_assertScoringParity(problem, [collisionAction]).collision, true);
      assert.equal(_assertScoringParity(problem, [problem.answer_actions[0]]).success, false);
      const backRoute = _routeWithBack(problem);
      assert.ok(backRoute.includes("B"));
      assert.equal(_assertScoringParity(problem, backRoute).success, true);

      const browserId = crypto.randomUUID();
      knownBrowsers.add(browserId);
      const start = await _request(baseUrl, browserId, "/api/start", { method: "POST", body: {} });
      const maze = MAZE_BY_ID.get(start.body.attempt.maze.maze_id).problem;
      const runtimeRoute = _routeWithBack(maze);
      assert.ok(runtimeRoute.includes("B"));
      let response = start;
      for (const [index, action] of runtimeRoute.entries()) {
        response = await _request(baseUrl, browserId, `/api/attempts/${start.body.attempt.id}/actions`, {
          method: "POST",
          body: { sequence: index + 1, request_id: crypto.randomUUID(), action },
        });
        if (index < runtimeRoute.length - 1) {
          assert.equal(response.body.attempt.status, "active");
          _assertActiveProblem(response.body.attempt, maze);
          assert.equal(Object.hasOwn(response.body.attempt, "result"), false);
        }
      }
      assert.equal(response.body.attempt.status, "success");
      assert.equal(response.body.attempt.result.score, _assertScoringParity(maze, runtimeRoute).score);
      rememberCompletion(browserId, response.body.attempt);
    });

    await t.test("all 50 mazes are unique per browser and exhaustion is stable", async () => {
      const browserId = crypto.randomUUID();
      knownBrowsers.add(browserId);
      const seen = new Set();
      for (let index = 0; index < MAZES.length; index += 1) {
        const start = await _request(baseUrl, browserId, "/api/start", { method: "POST", body: {} });
        assert.equal(start.status, 200);
        const attempt = start.body.attempt;
        assert.equal(attempt.status, "active");
        assert.equal(seen.has(attempt.maze.maze_id), false);
        seen.add(attempt.maze.maze_id);
        const quit = await _request(baseUrl, browserId, `/api/attempts/${attempt.id}/quit`, {
          method: "POST",
          body: { sequence: 1, request_id: crypto.randomUUID() },
        });
        assert.equal(quit.body.attempt.status, "quit");
        assert.equal(quit.body.exhausted, index === MAZES.length - 1);
        rememberCompletion(browserId, quit.body.attempt);
      }
      assert.equal(seen.size, 50);
      const session = await _request(baseUrl, browserId, "/api/session");
      assert.equal(session.body.exhausted, true);
      const exhaustedStart = await _request(baseUrl, browserId, "/api/start", { method: "POST", body: {} });
      assert.equal(exhaustedStart.body.exhausted, true);
      assert.equal(exhaustedStart.body.attempt.id, session.body.attempt.id);
    });

    await t.test("export authentication, snapshot pagination, participant counts, and privacy", async () => {
      const badAuth = await fetch(`${baseUrl}/api/export?after=0`);
      assert.equal(badAuth.status, 401);
      const badToken = await fetch(`${baseUrl}/api/export?after=0`, {
        headers: { Authorization: "Bearer wrong" },
      });
      assert.equal(badToken.status, 401);
      const malformedCursor = await fetch(`${baseUrl}/api/export?after=-1`, {
        headers: { Authorization: `Bearer ${exportToken}` },
      });
      assert.equal(malformedCursor.status, 400);

      const started = [];
      for (let offset = 0; offset < 201; offset += 20) {
        const batch = await Promise.all(Array.from({ length: Math.min(20, 201 - offset) }, async () => {
          const browserId = crypto.randomUUID();
          knownBrowsers.add(browserId);
          const result = await _request(baseUrl, browserId, "/api/start", { method: "POST", body: {} });
          assert.equal(result.status, 200);
          return { browserId, attempt: result.body.attempt };
        }));
        started.push(...batch);
      }
      for (let offset = 0; offset < started.length; offset += 20) {
        await Promise.all(started.slice(offset, offset + 20).map(async ({ browserId, attempt }) => {
          const quit = await _request(baseUrl, browserId, `/api/attempts/${attempt.id}/quit`, {
            method: "POST",
            body: { sequence: 1, request_id: crypto.randomUUID() },
          });
          assert.equal(quit.status, 200);
          rememberCompletion(browserId, quit.body.attempt);
        }));
      }

      const firstResponse = await fetch(`${baseUrl}/api/export?after=0`, {
        headers: { Authorization: `Bearer ${exportToken}` },
      });
      assert.equal(firstResponse.status, 200);
      const first = await firstResponse.json();
      assert.equal(first.schema_version, 1);
      assert.equal(first.dataset, "verification");
      assert.equal(first.records.length, 200);
      assert.equal(first.has_more, true);
      const snapshot = first.through;
      assert.ok(snapshot > 200);
      assert.deepEqual(first.participant_counts, {
        "1": completed.get("1").size,
        "2": completed.get("2").size,
      });
      for (const attemptId of bulkCompletionIds) {
        assert.equal(first.records.filter(({ attempt_id }) => attempt_id === attemptId).length, 1);
      }
      const serialized = JSON.stringify(first);
      for (const browserId of knownBrowsers) assert.equal(serialized.includes(browserId), false);

      const afterSnapshotBrowser = crypto.randomUUID();
      const afterSnapshotStart = await _request(baseUrl, afterSnapshotBrowser, "/api/start", {
        method: "POST",
        body: {},
      });
      const afterSnapshotQuit = await _request(
        baseUrl,
        afterSnapshotBrowser,
        `/api/attempts/${afterSnapshotStart.body.attempt.id}/quit`,
        { method: "POST", body: { sequence: 1, request_id: crypto.randomUUID() } },
      );
      assert.equal(afterSnapshotQuit.status, 200);

      const records = [...first.records];
      let nextCursor = first.next_cursor;
      let hasMore = first.has_more;
      while (hasMore) {
        const pageResponse = await fetch(
          `${baseUrl}/api/export?after=${nextCursor}&through=${snapshot}`,
          { headers: { Authorization: `Bearer ${exportToken}` } },
        );
        assert.equal(pageResponse.status, 200);
        const page = await pageResponse.json();
        assert.equal(page.through, snapshot);
        assert.deepEqual(page.participant_counts, first.participant_counts);
        records.push(...page.records);
        nextCursor = page.next_cursor;
        hasMore = page.has_more;
      }
      assert.equal(records.length, snapshot);
      assert.deepEqual(records.map(({ sequence }) => sequence), Array.from({ length: snapshot }, (_, i) => i + 1));
      assert.equal(new Set(records.map(({ attempt_id }) => attempt_id)).size, snapshot);
      assert.equal(records.some(({ attempt_id }) => attempt_id === afterSnapshotStart.body.attempt.id), false);
      assert.ok(records.every(({ status, actions }) =>
        ["success", "collision", "quit"].includes(status) && Array.isArray(actions)));
    });
  } finally {
    server.child.kill();
    await new Promise((resolve) => server.child.once("exit", resolve));
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (let retry = 0; ; retry += 1) {
      try {
        await rm(persistence, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error.code !== "EBUSY" || retry === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }
});

/** @description 생성된 자산 폴더의 상대 경로 목록 */
async function readdirRecursive(folder, prefix = "") {
  const entries = await readdir(folder, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const relative = path.join(prefix, entry.name).replaceAll("\\", "/");
    return entry.isDirectory() ? readdirRecursive(path.join(folder, entry.name), relative) : [relative];
  }));
  return nested.flat();
}
