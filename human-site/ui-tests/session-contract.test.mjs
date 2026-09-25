import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import MazeReplayCore from "../../public/replay-core.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const webRoot = resolve(projectRoot, "human-site", "web");
const mazeProblemPath = resolve(projectRoot, "maze_sets", "4x4", "maze_04x04_adjacent_01.json");
const mazeImagePath = resolve(projectRoot, "maze_sets", "4x4", "maze_04x04_adjacent_01.png");
const screenshotRoot = process.env.MAZE_UI_SCREENSHOT_DIR;
const staticFiles = new Map([
  ["/", resolve(webRoot, "index.html")],
  ["/app.js", resolve(webRoot, "app.js")],
  ["/styles.css", resolve(webRoot, "styles.css")],
  ["/replay-core.js", resolve(projectRoot, "public", "replay-core.js")],
]);

let browser;
let server;
let origin;
let mazeProblem;

function _collisionProblem() {
  return mazeProblem;
}

function _successProblem() {
  return mazeProblem;
}

function _overlapProblem() {
  return mazeProblem;
}

function _actionForDirection(facing, direction) {
  return ["S", "B", "L", "R"].find((action) => (
    MazeReplayCore.rotateDirection(facing, action) === direction
  ));
}

function _shortestGoalActions(problem) {
  const queue = [{ event: "START_OUT", facing: problem.initial_facing, actions: [] }];
  const visited = new Set([`START_OUT:${problem.initial_facing}`]);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current.event === "GOAL_OUT") return current.actions;
    for (const action of ["S", "B", "L", "R"]) {
      const direction = MazeReplayCore.rotateDirection(current.facing, action);
      const edge = problem.transitions[current.event][direction];
      if (!edge) continue;
      const key = `${edge.to}:${direction}`;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ event: edge.to, facing: direction, actions: [...current.actions, action] });
    }
  }
  throw new Error("미로 출구에 도달하는 이동을 찾지 못했습니다.");
}

function _overlapCollisionActions(problem) {
  const queue = [{ event: "START_OUT", facing: problem.initial_facing, actions: [] }];
  const visited = new Set([`START_OUT:${problem.initial_facing}`]);
  let candidate = null;
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const available = problem.transitions[current.event];
    if (current.actions.length >= 2) {
      const collisionDirection = MazeReplayCore.DIRECTIONS.find((direction) => !available[direction]);
      if (collisionDirection) {
        for (const [direction, edge] of Object.entries(available)) {
          if (edge.to === "GOAL_OUT") continue;
          const opposite = { N: "S", E: "W", S: "N", W: "E" }[direction];
          if (problem.transitions[edge.to][opposite]?.to !== current.event) continue;
          candidate = [
            ...current.actions,
            _actionForDirection(current.facing, direction),
            "B",
            _actionForDirection(opposite, collisionDirection),
          ];
          break;
        }
      }
    }
    for (const action of ["S", "B", "L", "R"]) {
      const direction = MazeReplayCore.rotateDirection(current.facing, action);
      const edge = available[direction];
      if (!edge) continue;
      const key = `${edge.to}:${direction}`;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ event: edge.to, facing: direction, actions: [...current.actions, action] });
    }
  }
  if (!candidate) throw new Error("되짚은 뒤 충돌하는 이동을 찾지 못했습니다.");
  return candidate;
}

async function _pressActions(page, actions) {
  const keys = { S: "ArrowUp", B: "ArrowDown", L: "ArrowLeft", R: "ArrowRight" };
  for (const action of actions) {
    await page.keyboard.press(keys[action]);
  }
}

function _attempt(id = "attempt-one", problem = _collisionProblem(), overrides = {}) {
  return {
    id,
    actions: [],
    status: "active",
    started_at: "2026-09-25T00:00:00.000Z",
    finished_at: null,
    problem,
    ...overrides,
  };
}

function _terminalAttempt(attempt, actions, status) {
  return {
    ...attempt,
    actions,
    status,
    finished_at: "2026-09-25T00:01:00.000Z",
    result: {
      score: 12.34,
      successful_moves: status === "success" ? actions.length : actions.length - 1,
      remaining_moves: 8,
      optimal_moves: 8,
    },
  };
}

async function _newPage({ returningVisitor = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 960 } });
  if (returningVisitor) {
    await page.addInitScript(() => {
      localStorage.setItem("maze-bench-human-tutorial-seen", "seen");
    });
  }
  return page;
}

async function _json(route, payload, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

async function _screenshot(page, name) {
  if (!screenshotRoot) return;
  await mkdir(screenshotRoot, { recursive: true });
  await page.screenshot({ path: join(screenshotRoot, name), fullPage: true });
}

async function _waitForImage(page) {
  await page.waitForFunction(() => document.querySelector("#mazeImage").naturalWidth > 0);
}

async function _routeForAttempt(page, getAttempt, exhausted = false) {
  await page.route("**/api/session", (route) => (
    _json(route, { attempt: getAttempt(), exhausted })
  ));
}

before(async () => {
  const sourceProblem = JSON.parse(await readFile(mazeProblemPath, "utf8"));
  mazeProblem = {
    problem_id: sourceProblem.problem_id,
    width: sourceProblem.width,
    height: sourceProblem.height,
    image_size: sourceProblem.image_size,
    start_cell: sourceProblem.start_cell,
    goal_cell: sourceProblem.goal_cell,
    start_side: sourceProblem.start_side,
    goal_side: sourceProblem.goal_side,
    initial_facing: sourceProblem.initial_facing,
    events: sourceProblem.events,
    transitions: sourceProblem.transitions,
  };
  server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = staticFiles.get(pathname)
      ?? (pathname.startsWith("/mazes/") ? mazeImagePath : null);
    if (!file) {
      response.writeHead(404);
      response.end();
      return;
    }
    void readFile(file).then((content) => {
      const contentType = file.endsWith(".html")
        ? "text/html; charset=utf-8"
        : file.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : file.endsWith(".css")
            ? "text/css; charset=utf-8"
            : "image/png";
      response.writeHead(200, { "Content-Type": contentType });
      response.end(content);
    }, () => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  origin = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (server?.listening) {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("세 입력을 즉시 기록하고 충돌 경로를 저장 응답 전에 보여준다", async () => {
  const page = await _newPage();
  let serverAttempt = _attempt();
  const completionBodies = [];
  let notifyCompletion;
  const completionReceived = new Promise((resolveCompletion) => {
    notifyCompletion = resolveCompletion;
  });
  let releaseCompletion;
  await _routeForAttempt(page, () => serverAttempt);
  await page.route("**/api/attempts/*/complete", async (route) => {
    completionBodies.push(route.request().postDataJSON());
    notifyCompletion();
    await new Promise((resolveCompletion) => {
      releaseCompletion = resolveCompletion;
    });
    serverAttempt = _terminalAttempt(serverAttempt, ["S", "S", "S"], "collision");
    await _json(route, { attempt: serverAttempt, exhausted: false });
  });
  let actionRequests = 0;
  await page.route("**/api/attempts/*/actions", () => { actionRequests += 1; });

  try {
    await page.goto(origin);
    await _waitForImage(page);
    await page.evaluate(() => {
      for (let index = 0; index < 3; index += 1) {
        document.body.dispatchEvent(new KeyboardEvent("keydown", {
          key: "ArrowUp",
          bubbles: true,
        }));
      }
    });
    await completionReceived;

    assert.equal(await page.locator("#moveCount").innerText(), "3");
    assert.equal(await page.locator("#historyList .history-item").count(), 3);
    assert.equal(await page.locator("#terminalTitle").innerText(), "벽에 부딪혔습니다");
    assert.equal(await page.locator("#routeSvg").isVisible(), true);
    assert.equal(await page.locator("#terminalScore").isHidden(), true);
    assert.equal(await page.locator("#nextButton").isDisabled(), true);
    assert.equal(actionRequests, 0);
    assert.deepEqual(Object.keys(completionBodies[0]).sort(), ["actions", "quit"]);
    assert.deepEqual(completionBodies[0], { actions: ["S", "S", "S"], quit: false });
    assert.match(await page.locator("#actionStatus").innerText(), /저장하고/);
    await _screenshot(page, "collision-saving.png");

    releaseCompletion();
    await page.getByText("점수 12.34").waitFor();
    assert.equal(await page.locator("#nextButton").isDisabled(), false);
  } finally {
    releaseCompletion?.();
    await page.close();
  }
});

test("성공 경로는 재생 중에도 전체가 초록색이고 점수는 저장 확인 뒤 표시한다", async () => {
  const page = await _newPage();
  let serverAttempt = _attempt("attempt-success", _successProblem());
  const actions = _shortestGoalActions(serverAttempt.problem);
  let releaseCompletion;
  let notifyCompletion;
  const completionReceived = new Promise((resolveCompletion) => {
    notifyCompletion = resolveCompletion;
  });
  await _routeForAttempt(page, () => serverAttempt);
  await page.route("**/api/attempts/*/complete", async (route) => {
    notifyCompletion();
    await new Promise((resolveCompletion) => {
      releaseCompletion = resolveCompletion;
    });
    serverAttempt = _terminalAttempt(serverAttempt, actions, "success");
    await _json(route, { attempt: serverAttempt, exhausted: false });
  });

  try {
    await page.goto(origin);
    await _waitForImage(page);
    await _pressActions(page, actions);
    await completionReceived;

    assert.equal(await page.locator("#terminalTitle").innerText(), "출구에 도착했습니다");
    assert.equal(await page.locator("#terminalScore").isHidden(), true);
    assert.equal(await page.locator("#routeSvg .route-path").count(), 1);
    assert.equal(await page.locator("#routeSvg .route-path").getAttribute("class"), "route-path route-success");
    await _screenshot(page, "success-saving.png");
    await page.locator("#replayFirst").click();
    assert.equal(await page.locator("#routeSvg .route-path").count(), 0);
    await page.locator("#replayNext").click();
    assert.equal(await page.locator("#routeSvg .route-path").getAttribute("class"), "route-path route-success");

    releaseCompletion();
    await page.getByText("점수 12.34").waitFor();
    assert.equal(await page.locator("#nextButton").isDisabled(), false);
  } finally {
    releaseCompletion?.();
    await page.close();
  }
});

test("되짚은 경로도 단일 불투명 경로로 그리고 충돌 표시를 별도로 남긴다", async () => {
  const page = await _newPage();
  let serverAttempt = _attempt("attempt-overlap", _overlapProblem());
  const actions = _overlapCollisionActions(serverAttempt.problem);
  const replay = MazeReplayCore.simulateReplay(serverAttempt.problem, actions);
  let releaseCompletion;
  let notifyCompletion;
  const completionReceived = new Promise((resolveCompletion) => {
    notifyCompletion = resolveCompletion;
  });
  await _routeForAttempt(page, () => serverAttempt);
  await page.route("**/api/attempts/*/complete", async (route) => {
    notifyCompletion();
    await new Promise((resolveCompletion) => {
      releaseCompletion = resolveCompletion;
    });
    serverAttempt = _terminalAttempt(serverAttempt, actions, "collision");
    await _json(route, { attempt: serverAttempt, exhausted: false });
  });

  try {
    await page.goto(origin);
    await _waitForImage(page);
    await _pressActions(page, actions);
    await completionReceived;

    const routePath = page.locator("#routeSvg .route-path");
    const pathData = await routePath.getAttribute("d");
    assert.equal(await routePath.count(), 1);
    assert.equal((pathData.match(/ L /g) ?? []).length, replay.segments.length);
    assert.equal(await routePath.getAttribute("class"), "route-path");
    assert.equal(await page.locator("#routeSvg .route-collision").count(), 3);
    assert.equal(await page.locator("#moveCount").innerText(), String(actions.length));
    const traversedLinks = new Set();
    const hasOverlap = replay.segments.some((segment) => {
      const key = [segment.from.join(","), segment.to.join(",")].sort().join("|");
      if (traversedLinks.has(key)) return true;
      traversedLinks.add(key);
      return false;
    });
    assert.equal(hasOverlap, true);
    await _screenshot(page, "overlapping-route.png");
  } finally {
    releaseCompletion?.();
    await page.close();
  }
});

test("종료 확인은 이동 수를 늘리지 않고 quit:true로 저장한다", async () => {
  const page = await _newPage();
  let serverAttempt = _attempt("attempt-quit", _collisionProblem());
  let completionBody;
  let releaseCompletion;
  let notifyCompletion;
  const completionReceived = new Promise((resolveCompletion) => {
    notifyCompletion = resolveCompletion;
  });
  await _routeForAttempt(page, () => serverAttempt);
  await page.route("**/api/attempts/*/complete", async (route) => {
    completionBody = route.request().postDataJSON();
    notifyCompletion();
    await new Promise((resolveCompletion) => {
      releaseCompletion = resolveCompletion;
    });
    serverAttempt = _terminalAttempt(serverAttempt, completionBody.actions, "quit");
    await _json(route, { attempt: serverAttempt, exhausted: false });
  });

  try {
    await page.goto(origin);
    await _waitForImage(page);
    await page.keyboard.press("ArrowUp");
    assert.equal(await page.locator("#moveCount").innerText(), "1");
    await page.evaluate(() => { window.confirm = () => true; });
    await page.locator("#quitButton").click();
    await completionReceived;

    assert.deepEqual(completionBody, { actions: ["S"], quit: true });
    assert.equal(await page.locator("#moveCount").innerText(), "1");
    assert.equal(await page.locator("#terminalTitle").innerText(), "플레이를 종료했습니다");
    assert.equal(await page.locator("#terminalScore").isHidden(), true);
  } finally {
    releaseCompletion?.();
    await page.close();
  }
});

test("새로고침 때 서버 접두 기록과 초안을 합치고 로컬 입력을 이어간다", async () => {
  const page = await _newPage();
  let serverAttempt = _attempt("attempt-draft", _collisionProblem(), { actions: ["S"] });
  let completionBody;
  await _routeForAttempt(page, () => serverAttempt);
  await page.route("**/api/attempts/*/complete", async (route) => {
    completionBody = route.request().postDataJSON();
    serverAttempt = _terminalAttempt(serverAttempt, completionBody.actions, "collision");
    await _json(route, { attempt: serverAttempt, exhausted: false });
  });

  try {
    await page.goto(origin);
    await _waitForImage(page);
    assert.equal(await page.locator("#moveCount").innerText(), "1");
    await page.keyboard.press("ArrowUp");
    assert.equal(await page.locator("#moveCount").innerText(), "2");
    await page.reload();
    await _waitForImage(page);
    assert.equal(await page.locator("#moveCount").innerText(), "2");
    assert.match(await page.locator("#historyList").innerText(), /전진/);
    await page.keyboard.press("ArrowUp");
    await page.locator("#terminalSummary").waitFor({ state: "visible" });
    assert.deepEqual(completionBody, { actions: ["S", "S", "S"], quit: false });
  } finally {
    await page.close();
  }
});

test("응답을 잃은 최종 저장은 새로고침 뒤 동일 payload로 재전송한다", async () => {
  const page = await _newPage();
  let serverAttempt = _attempt("attempt-retry", _successProblem());
  const actions = _shortestGoalActions(serverAttempt.problem);
  const completionBodies = [];
  await _routeForAttempt(page, () => serverAttempt);
  await page.route("**/api/attempts/*/complete", async (route) => {
    const body = route.request().postDataJSON();
    completionBodies.push(body);
    serverAttempt = _terminalAttempt(serverAttempt, body.actions, "success");
    if (completionBodies.length === 1) {
      await route.abort("failed");
      return;
    }
    await _json(route, { attempt: serverAttempt, exhausted: false });
  });

  try {
    await page.goto(origin);
    await _waitForImage(page);
    await _pressActions(page, actions);
    await page.locator("#retryButton").waitFor({ state: "visible" });
    assert.match(await page.locator("#actionStatus").innerText(), /저장하지 못했어요/);
    assert.equal(await page.locator("#nextButton").isDisabled(), true);
    assert.equal(await page.locator("#terminalScore").isHidden(), true);

    await page.reload();
    await page.getByText("점수 12.34").waitFor();
    assert.equal(completionBodies.length, 2);
    assert.deepEqual(completionBodies[1], completionBodies[0]);
    assert.deepEqual(completionBodies[1], { actions, quit: false });
    assert.equal(await page.locator("#retryButton").isHidden(), true);
    assert.equal(await page.locator("#nextButton").isDisabled(), false);
    assert.equal(
      await page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("maze-bench-human-draft:"))),
      false,
    );
  } finally {
    await page.close();
  }
});

test("완료 요청의 409는 초안을 버리고 서버의 최신 상태를 따른다", async () => {
  const terminalPage = await _newPage();
  let terminalAttempt = _attempt("attempt-terminal-conflict", _successProblem());
  const successfulActions = _shortestGoalActions(terminalAttempt.problem);
  const terminalActions = _overlapCollisionActions(terminalAttempt.problem);
  await _routeForAttempt(terminalPage, () => terminalAttempt);
  await terminalPage.route("**/api/attempts/*/complete", async (route) => {
    terminalAttempt = _terminalAttempt(terminalAttempt, terminalActions, "collision");
    await _json(route, {
      attempt: terminalAttempt,
      exhausted: false,
      error: "attempt_finished",
    }, 409);
  });

  try {
    await terminalPage.goto(origin);
    await _waitForImage(terminalPage);
    await _pressActions(terminalPage, successfulActions);
    await terminalPage.getByText(/오류 코드: attempt_finished/).waitFor();

    assert.equal(await terminalPage.locator("#terminalTitle").innerText(), "벽에 부딪혔습니다");
    assert.equal(await terminalPage.locator("#terminalSummary").isVisible(), true);
    await terminalPage.getByText("점수 12.34").waitFor();
    assert.equal(await terminalPage.locator("#nextButton").isDisabled(), false);
    assert.equal(
      await terminalPage.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("maze-bench-human-draft:"))),
      false,
    );
  } finally {
    await terminalPage.close();
  }

  const activePage = await _newPage();
  let activeAttempt = _attempt("attempt-actions-conflict", _successProblem());
  const authoritativeActions = ["S", "B"];
  await _routeForAttempt(activePage, () => activeAttempt);
  await activePage.route("**/api/attempts/*/complete", async (route) => {
    activeAttempt = { ...activeAttempt, actions: authoritativeActions };
    await _json(route, {
      attempt: activeAttempt,
      exhausted: false,
      error: "actions_conflict",
    }, 409);
  });

  try {
    await activePage.goto(origin);
    await _waitForImage(activePage);
    await _pressActions(activePage, successfulActions);
    await activePage.getByText(/오류 코드: actions_conflict/).waitFor();

    assert.equal(await activePage.locator("#terminalSummary").isHidden(), true);
    assert.equal(await activePage.locator("#actionPad").isVisible(), true);
    assert.equal(await activePage.locator("#moveCount").innerText(), String(authoritativeActions.length));
    assert.match(await activePage.locator("#historyList").innerText(), /후진/);
    assert.equal(await activePage.locator("#actionPad button:not([disabled])").count() > 0, true);
    assert.equal(
      await activePage.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("maze-bench-human-draft:"))),
      false,
    );
  } finally {
    await activePage.close();
  }
});

test("기본 규칙을 접거나 펼쳐도 입력 기록 위쪽 공백이 짧게 유지된다", async () => {
  const page = await _newPage();
  await page.route("**/api/session", (route) => (
    _json(route, { attempt: null, exhausted: false })
  ));

  try {
    await page.goto(origin);
    await page.locator("#startButton").waitFor({ state: "visible" });
    const collapsedGap = await page.evaluate(() => {
      const rules = document.querySelector(".play-rules").getBoundingClientRect();
      const heading = document.querySelector(".history-heading").getBoundingClientRect();
      return heading.top - rules.bottom;
    });
    assert.ok(collapsedGap <= 24, `접힌 상태 간격: ${collapsedGap}px`);
    await _screenshot(page, "rules-collapsed.png");

    await page.locator(".play-rules summary").click();
    const expandedGap = await page.evaluate(() => {
      const rules = document.querySelector(".play-rules").getBoundingClientRect();
      const heading = document.querySelector(".history-heading").getBoundingClientRect();
      return heading.top - rules.bottom;
    });
    assert.ok(expandedGap <= 24, `펼친 상태 간격: ${expandedGap}px`);
    await _screenshot(page, "rules-expanded.png");
  } finally {
    await page.close();
  }
});

test("처음 불러온 완료 시도는 숨기고 새 미로 시작 안내를 유지한다", async () => {
  const page = await _newPage();
  const terminal = _terminalAttempt(_attempt("attempt-completed", _successProblem()), ["S", "R"], "success");
  await page.route("**/api/session", (route) => (
    _json(route, { attempt: terminal, exhausted: false })
  ));

  try {
    await page.goto(origin);
    await page.locator("#startButton").waitFor({ state: "visible" });
    assert.equal(await page.locator("#placeholderTitle").innerText(), "AI와 같은 조건으로 도전하기");
    assert.equal(await page.locator("#mazeCanvas").isHidden(), true);
    assert.equal(await page.locator("#terminalSummary").isHidden(), true);
  } finally {
    await page.close();
  }
});

test("기존 sessionStorage 요청은 새 입력 방식 전에 legacy 경로로 복구한다", async () => {
  const page = await _newPage();
  let serverAttempt = _attempt("attempt-legacy", _collisionProblem());
  let legacyBody;
  await page.addInitScript(() => {
    sessionStorage.setItem("maze-bench-human-pending-request", JSON.stringify({
      kind: "action",
      attemptId: "attempt-legacy",
      sequence: 1,
      request_id: "00000000-0000-4000-8000-000000000001",
      action: "S",
    }));
  });
  await _routeForAttempt(page, () => serverAttempt);
  await page.route("**/api/attempts/*/actions", async (route) => {
    legacyBody = route.request().postDataJSON();
    serverAttempt = { ...serverAttempt, actions: [legacyBody.action] };
    await _json(route, { attempt: serverAttempt, exhausted: false });
  });

  try {
    await page.goto(origin);
    await page.waitForFunction(() => (
      sessionStorage.getItem("maze-bench-human-pending-request") === null
    ));
    await _waitForImage(page);
    assert.deepEqual(legacyBody, {
      sequence: 1,
      request_id: "00000000-0000-4000-8000-000000000001",
      action: "S",
    });
    assert.equal(await page.locator("#moveCount").innerText(), "1");
  } finally {
    await page.close();
  }
});

test("언어 전환과 튜토리얼 조작을 유지한다", async () => {
  const page = await _newPage();
  await page.route("**/api/session", (route) => (
    _json(route, { attempt: null, exhausted: false })
  ));

  try {
    await page.goto(origin);
    await page.locator("#startButton").waitFor({ state: "visible" });
    await page.locator('[data-locale="en"]').click();
    assert.equal(await page.locator("#placeholderTitle").innerText(), "Challenge the maze on the same terms as the AI");
    await page.locator("#tutorialOpen").click();
    await page.locator("#controlTutorial[open]").waitFor();
    assert.equal(await page.locator("#tutorialTitle").innerText(), "How to play");
    await page.locator("#tutorialNext").click();
    assert.equal(await page.locator("#tutorialProgress").innerText(), "2 / 8");
    await page.locator("#tutorialClose").click();
    await page.locator("#controlTutorial").waitFor({ state: "hidden" });
  } finally {
    await page.close();
  }
});
