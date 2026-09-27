const RANDOM_RANGE = 0x1_0000_0000;

/** @description 시도 차수에 따른 미로 선택 */
export function selectMaze(available, attemptNumber, randomIndex) {
  if (attemptNumber >= 4) {
    return available[randomIndex(available.length)];
  }

  const candidates = attemptNumber === 1
    ? available.filter(({ problem }) => problem.width <= 15 && problem.height <= 15)
    : available;
  const totalWeight = candidates.reduce(
    (total, { problem }) => total + 1 / problem.width,
    0,
  );
  const draw = randomIndex(RANDOM_RANGE) / RANDOM_RANGE * totalWeight;
  let index = 0;
  let cumulativeWeight = 1 / candidates[index].problem.width;

  while (index < candidates.length - 1 && draw >= cumulativeWeight) {
    index += 1;
    cumulativeWeight += 1 / candidates[index].problem.width;
  }
  return candidates[index];
}
