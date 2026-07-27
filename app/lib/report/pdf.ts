import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Server-side PDF production for the client report.
 *
 * The report is one HTML page whose print rendering has already been proved
 * correct, so the honest way to produce a file is to print that exact page
 * rather than re-author the layout in a PDF library — any second renderer
 * would drift from what the browser shows and would have to re-earn the
 * null-vs-zero, decimal-comma and dark-mode guarantees on its own.
 *
 * Chromium is driven as a plain subprocess rather than through Puppeteer or
 * Playwright: `--print-to-pdf` is the whole API surface needed here, and
 * neither package would earn its ~300MB of vendored browser on a 4GB Pi when
 * the system chromium is already the thing they would drive.
 */

/** Where the binary lives on the dev machine and in the container image. */
const CANDIDATES = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
];

/** Generous: a cold chromium on the Pi is far slower than on a laptop. */
const RENDER_TIMEOUT_MS = 60_000;

export class PdfUnavailableError extends Error {}

/**
 * Resolves the browser binary. `CHROMIUM_PATH` wins so the container can
 * pin one explicitly and fail loudly if the image ever drops the package.
 */
export async function resolveChromium(): Promise<string> {
  const configured = process.env.CHROMIUM_PATH;
  const paths = configured ? [configured] : CANDIDATES;

  for (const path of paths) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Try the next candidate.
    }
  }

  throw new PdfUnavailableError(
    `No chromium binary found (looked in ${paths.join(", ")}). ` +
      "Install chromium or set CHROMIUM_PATH."
  );
}

/**
 * The URL chromium should print.
 *
 * Deliberately loopback rather than the request's own origin: the container
 * publishes on a host port it cannot necessarily route back to, and sending
 * the render out to the LAN and back would make an internal detail depend on
 * the network. `PORT` is what the standalone server binds, so it is what the
 * loopback address has to use.
 */
export function internalReportUrl(slug: string, requestUrl: string): string {
  const port = process.env.PORT ?? new URL(requestUrl).port ?? "3000";
  return `http://127.0.0.1:${port || "3000"}/site/${encodeURIComponent(slug)}/report`;
}

/**
 * Environment overrides for the chromium subprocess.
 *
 * `HOME` is the load-bearing one, and it fails in a way that looks like
 * nothing at all. The compose service runs the dashboard as a bare host uid
 * with no `/etc/passwd` entry, so `HOME` is `/` — unwritable. Chromium's
 * crashpad handler cannot create its database there, exits with
 * "--database is required", takes the browser down with it, and the parent
 * still sees exit code 0 with no PDF on disk. Verified in a container as
 * uid 1001 on 2026-07-27; pointing HOME at the scratch directory fixes it.
 */
export function pdfRenderEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_CACHE_HOME: join(dir, "cache"),
  };
}

/**
 * Prints `url` to a PDF and returns its bytes.
 *
 * `--no-sandbox` is required to run headless chromium as a non-root user in a
 * container without CAP_SYS_ADMIN. The page being rendered is our own,
 * served from loopback, on a host that is not internet-exposed — the sandbox
 * is protecting us from content we authored.
 *
 * `--disable-dev-shm-usage` matters in Docker specifically: the default
 * /dev/shm is 64MB and chromium crashes against it rather than degrading.
 */
export async function renderPdf(url: string): Promise<Buffer> {
  const bin = await resolveChromium();
  const dir = await mkdtemp(join(tmpdir(), "seo-report-"));
  const out = join(dir, "report.pdf");

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        bin,
        [
          "--headless",
          "--disable-gpu",
          "--no-sandbox",
          "--disable-dev-shm-usage",
          `--user-data-dir=${join(dir, "profile")}`,
          "--no-pdf-header-footer",
          // The page is fully server-rendered, so this is a ceiling on
          // fonts and layout settling, not a guess at a data fetch.
          "--virtual-time-budget=10000",
          `--print-to-pdf=${out}`,
          url,
        ],
        { stdio: ["ignore", "ignore", "pipe"], env: pdfRenderEnv(dir) }
      );

      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`chromium timed out after ${RENDER_TIMEOUT_MS}ms`));
      }, RENDER_TIMEOUT_MS);

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        // chromium logs plenty at exit; the tail is the part that explains a
        // failure, and swallowing it would leave an unexplainable 500.
        else reject(new Error(`chromium exited ${code}: ${stderr.trim().slice(-500)}`));
      });
    });

    // Exit code 0 does not prove a PDF exists: when the crashpad handler
    // dies (see pdfRenderEnv) chromium reports success and writes nothing.
    try {
      return await readFile(out);
    } catch {
      throw new Error(`chromium reported success but wrote no PDF to ${out}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * ASCII-only version of a filename, for the plain `filename=` parameter.
 *
 * Serbian Latin decomposes cleanly except for đ/Đ, which have no combining
 * form and would otherwise be dropped entirely — turning "izveštaj" into a
 * readable fallback but "Đorđe" into "ore".
 */
function asciiFold(s: string): string {
  return s
    .replace(/đ/g, "dj")
    .replace(/Đ/g, "Dj")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, "-");
}

/**
 * The name the client's browser saves the file under.
 *
 * Characters that are illegal or awkward in a filename are replaced rather
 * than stripped, so two different reports can never collapse to the same
 * name. The site name and period are the two things that identify a report.
 */
export function reportPdfFilename(siteName: string, period: string): string {
  const base = `${siteName} - ${period}`
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "");
  return `${base}.pdf`;
}

/**
 * A `Content-Disposition` value carrying a non-ASCII filename.
 *
 * The bare `filename=` parameter is ASCII-only by RFC 6266, so a Serbian name
 * needs the RFC 5987 `filename*` form. Both are emitted: modern browsers
 * prefer `filename*`, and anything that does not understand it still gets a
 * readable, transliterated name instead of a mojibake one.
 */
export function contentDispositionAttachment(filename: string): string {
  const ascii = asciiFold(filename).replace(/"/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
