/**
 * @file scripts/export-readme-images.mjs
 * @description Export Korean and English README charts from the local dashboard
 */

import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "..");
const IMAGE_DIR = path.join(REPOSITORY_ROOT, "images");
const DIAGNOSTICS_DIR = path.join(
  REPOSITORY_ROOT,
  ".tmp",
  "export-diagnostics",
);
const DASHBOARD_PATH = "/public/leaderboard.html";
const VIEWPORT = { width: 1920, height: 1400 };
const READY_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
]);
const EXPORT_TARGETS = [
  {
    selector: "#exportLeaderboardRanking",
    korean: "maze-bench-model-ranking.png",
    english: "maze-bench-model-ranking-en.png",
  },
  {
    selector: "#exportLeaderboardSizes",
    korean: "maze-bench-leaderboard-size-scores.png",
    english: "maze-bench-leaderboard-size-scores-en.png",
  },
  {
    selector: "#exportLeaderboardCost",
    korean: "maze-bench-leaderboard-cost-performance.png",
    english: "maze-bench-leaderboard-cost-performance-en.png",
  },
];

/** @description Resolve a requested URL to a file inside the repository */
function _resolveRequestPath(requestUrl) {
  const pathname = decodeURIComponent(
    new URL(requestUrl ?? "/", "http://127.0.0.1").pathname,
  );
  const relativePath = pathname.replace(/^\/+/, "") || "index.html";
  const filePath = path.resolve(REPOSITORY_ROOT, relativePath);
  const repositoryPrefix = `${REPOSITORY_ROOT}${path.sep}`;
  return filePath.startsWith(repositoryPrefix) ? filePath : null;
}

/** @description Serve repository files for one local export run */
async function _handleRequest(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  const filePath = _resolveRequestPath(request.url);
  if (!filePath) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new Error("Requested path is not a file");
    }
    const contents = await readFile(filePath);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": MIME_TYPES.get(path.extname(filePath).toLowerCase())
        ?? "application/octet-stream",
    });
    response.end(request.method === "HEAD" ? undefined : contents);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

/** @description Start a local static server on an available port */
async function _startServer() {
  const server = createServer((request, response) => {
    void _handleRequest(request, response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not determine the local dashboard port");
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

/** @description Close a Node HTTP server */
async function _closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** @description Save browser diagnostics for a failed locale export */
async function _writeDiagnostics(page, locale, error, browserMessages) {
  await mkdir(DIAGNOSTICS_DIR, { recursive: true });
  const baseName = `readme-images-${locale}`;
  await Promise.all([
    page.screenshot({
      path: path.join(DIAGNOSTICS_DIR, `${baseName}.png`),
      fullPage: true,
    }).catch(() => undefined),
    writeFile(
      path.join(DIAGNOSTICS_DIR, `${baseName}.json`),
      `${JSON.stringify({
        locale,
        url: page.url(),
        title: await page.title().catch(() => ""),
        dashboardState: await page.locator("html").getAttribute(
          "data-dashboard-state",
        ).catch(() => null),
        error: error instanceof Error ? error.stack : String(error),
        browserMessages,
      }, null, 2)}\n`,
      "utf8",
    ),
  ]);
}

/** @description Wait until dashboard data, fonts, and provider icons are ready */
async function _waitForDashboard(page) {
  await page.waitForFunction(
    () => ["ready", "error"].includes(
      document.documentElement.dataset.dashboardState,
    ),
    { timeout: READY_TIMEOUT_MS },
  );
  const dashboardState = await page.locator("html").getAttribute(
    "data-dashboard-state",
  );
  if (dashboardState !== "ready") {
    const message = await page.locator("#messageBox").textContent()
      .catch(() => "");
    throw new Error(`Dashboard failed to load: ${message?.trim() || "unknown error"}`);
  }
  await page.evaluate(async () => {
    await document.fonts?.ready;
    await Promise.all([...document.images].map((image) => {
      if (image.complete) {
        return undefined;
      }
      return new Promise((resolve) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
      });
    }));
    await new Promise((resolve) => requestAnimationFrame(
      () => requestAnimationFrame(resolve),
    ));
  });
}

/** @description Export all README charts for one dashboard locale */
async function _exportLocale(browser, baseUrl, locale) {
  const browserMessages = [];
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: locale === "ko" ? "ko-KR" : "en-US",
    viewport: VIEWPORT,
  });
  await context.addInitScript(({ activeLocale }) => {
    localStorage.setItem("maze-bench-locale", activeLocale);
    localStorage.setItem("maze-bench-theme", "light");
  }, { activeLocale: locale });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      browserMessages.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    browserMessages.push(`pageerror: ${error.message}`);
  });

  try {
    await page.goto(`${baseUrl}${DASHBOARD_PATH}`, {
      waitUntil: "domcontentloaded",
    });
    await _waitForDashboard(page);

    for (const target of EXPORT_TARGETS) {
      const filename = locale === "ko" ? target.korean : target.english;
      const button = page.locator(
        `[data-export-target="${target.selector}"]`,
      );
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: DOWNLOAD_TIMEOUT_MS }),
        button.click(),
      ]);
      await download.saveAs(path.join(IMAGE_DIR, filename));
      console.log(`Exported ${filename}`);
    }
  } catch (error) {
    await _writeDiagnostics(page, locale, error, browserMessages);
    throw error;
  } finally {
    await context.close();
  }
}

/** @description Run the complete bilingual README image export */
async function main() {
  await mkdir(IMAGE_DIR, { recursive: true });
  const { server, baseUrl } = await _startServer();
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      timeout: READY_TIMEOUT_MS,
    });
    await _exportLocale(browser, baseUrl, "ko");
    await _exportLocale(browser, baseUrl, "en");
  } finally {
    await browser?.close();
    await _closeServer(server);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
