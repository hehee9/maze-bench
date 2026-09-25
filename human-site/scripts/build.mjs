import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @file human-site/scripts/build.mjs
 * @description 미로 카탈로그 생성 및 정적 자산 복사
 */

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(siteRoot, "..");
const outputRoot = path.join(siteRoot, ".build");
const assetsRoot = path.join(outputRoot, "assets");

/** @description 두 난이도 구간의 미로 목록 경로 수집 */
async function _manifests(folder) {
  const entries = await readdir(folder, { withFileTypes: true });
  const nested = await Promise.all(entries.filter((entry) => entry.isDirectory())
    .map((entry) => _manifests(path.join(folder, entry.name))));
  return [
    ...entries.filter((entry) => entry.isFile() && entry.name.endsWith("_manifest.json"))
      .map((entry) => path.join(folder, entry.name)),
    ...nested.flat(),
  ];
}

const catalog = [];
for (const [folder, tier] of [["maze_sets", 1], ["maze_sets_tier2", 2]]) {
  for (const manifestPath of await _manifests(path.join(repoRoot, folder))) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const item of manifest) {
      const sourceDir = path.dirname(manifestPath);
      const problem = JSON.parse(await readFile(path.join(sourceDir, item.json), "utf8"));
      if (problem.problem_id !== item.problem_id) {
        throw new Error(`Manifest maze ID mismatch in ${manifestPath}: ${item.problem_id}`);
      }
      const imagePath = path.join(sourceDir, item.png);
      const imageUrl = `/mazes/${item.problem_id}.png`;
      catalog.push({
        tier,
        image_url: imageUrl,
        problem,
        image_source: imagePath,
      });
    }
  }
}

catalog.sort((left, right) => left.problem.problem_id.localeCompare(right.problem.problem_id));
const ids = new Set(catalog.map(({ problem }) => problem.problem_id));
if (catalog.length !== 50 || ids.size !== 50) {
  throw new Error(`Expected 50 unique manifest mazes, found ${catalog.length}`);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(assetsRoot, { recursive: true });
await cp(path.join(siteRoot, "web"), assetsRoot, { recursive: true });
await cp(path.join(repoRoot, "public", "replay-core.js"), path.join(assetsRoot, "replay-core.js"));
await mkdir(path.join(assetsRoot, "mazes"), { recursive: true });
await Promise.all(catalog.map(({ image_source: source, image_url: imageUrl }) => {
  const destination = path.join(assetsRoot, imageUrl.slice(1));
  return cp(source, destination);
}));

const serverCatalog = catalog.map(({ tier, image_url, problem }) => ({ tier, image_url, problem }));
const byId = Object.fromEntries(serverCatalog.map((maze) => [maze.problem.problem_id, maze]));
await writeFile(
  path.join(outputRoot, "maze-catalog.generated.js"),
  `export const MAZES = ${JSON.stringify(serverCatalog)};\nexport const MAZE_BY_ID = new Map(MAZES.map((maze) => [maze.problem.problem_id, maze]));\n`,
  "utf8",
);
console.log(`Built ${catalog.length} maze records and ${catalog.length} maze images.`);
