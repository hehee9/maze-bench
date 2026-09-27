import assert from "node:assert/strict";
import test from "node:test";
import { selectMaze } from "../src/maze-selection.js";

const RANDOM_RANGE = 0x1_0000_0000;

/** @description 가중치 시험용 미로 구성 */
function _maze(problemId, width, height = width, tier = 1) {
  return { problem: { problem_id: problemId, width, height }, tier };
}

/** @description 지정한 난수와 요청 상한을 반환하는 추첨기 구성 */
function _randomIndex(value) {
  const bounds = [];
  const randomIndex = (bound) => {
    bounds.push(bound);
    return value;
  };
  return { bounds, randomIndex };
}

test("첫 시도는 폭과 높이가 15 이하인 미로만 선택한다", () => {
  const tooWide = _maze("too-wide", 16, 6);
  const tooTall = _maze("too-tall", 6, 16);
  const eligible = _maze("eligible", 15, 15, 2);
  const draw = _randomIndex(0);

  assert.equal(selectMaze([tooWide, tooTall, eligible], 1, draw.randomIndex), eligible);
  assert.deepEqual(draw.bounds, [RANDOM_RANGE]);
});

test("첫 세 시도는 한 변의 길이에 반비례하는 가중치 구간을 따른다", () => {
  const small = _maze("small", 4);
  const cases = [
    { attemptNumber: 1, large: _maze("large-capped", 12), ratio: 3 / 4 },
    { attemptNumber: 2, large: _maze("large", 24), ratio: 6 / 7 },
    { attemptNumber: 3, large: _maze("large", 24), ratio: 6 / 7 },
  ];

  for (const { attemptNumber, large, ratio } of cases) {
    const boundary = Math.ceil(RANDOM_RANGE * ratio);
    const beforeBoundary = _randomIndex(boundary - 1);
    const afterBoundary = _randomIndex(boundary);

    assert.equal(selectMaze([small, large], attemptNumber, beforeBoundary.randomIndex), small);
    assert.equal(selectMaze([small, large], attemptNumber, afterBoundary.randomIndex), large);
    assert.deepEqual(beforeBoundary.bounds, [RANDOM_RANGE]);
    assert.deepEqual(afterBoundary.bounds, [RANDOM_RANGE]);
  }
});

test("같은 크기의 다른 티어 미로는 같은 가중치를 가진다", () => {
  const tierOne = _maze("tier-one", 15, 15, 1);
  const tierTwo = _maze("tier-two", 15, 15, 2);
  const firstHalf = _randomIndex(0);
  const secondHalf = _randomIndex(RANDOM_RANGE / 2);

  assert.equal(selectMaze([tierOne, tierTwo], 2, firstHalf.randomIndex), tierOne);
  assert.equal(selectMaze([tierOne, tierTwo], 3, secondHalf.randomIndex), tierTwo);
});

test("네 번째 이후 시도는 기존 정수 추첨으로 남은 후보를 균등 선택한다", () => {
  const available = [_maze("first", 24, 24, 2), _maze("second", 12), _maze("third", 4)];

  for (const [attemptNumber, index] of [[4, 0], [5, 1], [12, 2]]) {
    const draw = _randomIndex(index);
    assert.equal(selectMaze(available, attemptNumber, draw.randomIndex), available[index]);
    assert.deepEqual(draw.bounds, [available.length]);
  }
});

test("선택기는 전달된 미시도 후보 안에서만 선택한다", () => {
  const available = [_maze("untried-large", 24, 24, 2)];
  const draw = _randomIndex(0);

  assert.equal(selectMaze(available, 2, draw.randomIndex), available[0]);
  assert.deepEqual(draw.bounds, [RANDOM_RANGE]);
});
