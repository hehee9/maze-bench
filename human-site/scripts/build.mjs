import { createHash } from "node:crypto";
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
const migrationsRoot = path.join(siteRoot, "migrations");

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

/** @description SQL 문자열 리터럴 인코딩 */
function _sqlLiteral(value) {
  return "'" + value.replaceAll("'", "''") + "'";
}

/** @description 미로 양끝 위치에서 관계 분류 */
function _relation({ start_side: startSide, goal_side: goalSide }) {
  if (startSide === goalSide) {
    return "same";
  }
  if ((startSide === "N" && goalSide === "S") || (startSide === "S" && goalSide === "N")
    || (startSide === "E" && goalSide === "W") || (startSide === "W" && goalSide === "E")) {
    return "opposite";
  }
  return "adjacent";
}

/** @description 미등록 카탈로그의 추가 마이그레이션 생성 */
async function _registerCatalogMigration(catalogId, metadata) {
  const migrationNames = (await readdir(migrationsRoot))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const migrationSql = await Promise.all(migrationNames.map((name) =>
    readFile(path.join(migrationsRoot, name), "utf8")));
  const catalogLiteral = _sqlLiteral(catalogId);
  if (migrationSql.some((sql) => sql.includes("INSERT INTO catalogs") && sql.includes(catalogLiteral))) {
    return;
  }

  const latestVersion = Math.max(...migrationNames.map((name) => Number.parseInt(name, 10)));
  const migrationName = String(latestVersion + 1).padStart(4, "0") + "_register_" + catalogId + ".sql";
  if (migrationNames.includes(migrationName)) {
    throw new Error("Catalog migration exists without registering " + catalogId + ": " + migrationName);
  }

  const metadataJson = _sqlLiteral(JSON.stringify(metadata));
  const sql = "INSERT INTO catalogs (catalog_id, registered_at, mazes_json)\n"
    + "VALUES (" + catalogLiteral + ", strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), " + metadataJson + ");\n";
  await writeFile(path.join(migrationsRoot, migrationName), sql, "utf8");
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
        relation: _relation(problem),
        image_url: imageUrl,
        problem,
        image_source: imagePath,
      });
    }
  }
}

catalog.sort((left, right) => left.problem.problem_id < right.problem.problem_id ? -1
  : left.problem.problem_id > right.problem.problem_id ? 1 : 0);
const ids = new Set(catalog.map(({ problem }) => problem.problem_id));
if (catalog.length === 0 || ids.size !== catalog.length) {
  throw new Error(`Expected a non-empty unique manifest catalog, found ${catalog.length} entries`);
}

const catalogMetadata = catalog.map(({ tier, relation, problem }) => ({
  maze_id: problem.problem_id,
  tier: String(tier),
  width: problem.width,
  height: problem.height,
  relation,
}));
const catalogId = "catalog-" + createHash("sha256")
  .update(catalogMetadata.map(({ maze_id }) => maze_id).join("\n"))
  .digest("hex");
await _registerCatalogMigration(catalogId, catalogMetadata);

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
  `export const CATALOG_ID = ${JSON.stringify(catalogId)};\nexport const CATALOG = ${JSON.stringify(catalogMetadata)};\nexport const MAZES = ${JSON.stringify(serverCatalog)};\nexport const MAZE_BY_ID = new Map(MAZES.map((maze) => [maze.problem.problem_id, maze]));\n`,
  "utf8",
);
console.log(`Built ${catalog.length} maze records and ${catalog.length} maze images.`);
