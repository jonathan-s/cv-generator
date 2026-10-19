#!/usr/bin/env node
/**
 * Local CV editor.
 *
 *   npm run editor   ->  http://127.0.0.1:8080
 *
 * The editor is a plain HTML/CSS/JS page. Saving sends the whole JSON document
 * to PUT /api/cv, which:
 *   1. validates the document,
 *   2. writes it atomically to data/wakako-obata.json,
 *   3. runs scripts/build.mjs (HTML + PDF),
 *   4. returns the build result so the preview can refresh.
 */

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCv } from "./scripts/lib/validate.mjs";

const execFileAsync = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));

const paths = {
  data: join(root, "data", "wakako-obata.json"),
  build: join(root, "scripts", "build.mjs"),
  editor: join(root, "editor"),
  dist: join(root, "dist"),
  html: join(root, "dist", "wakako-obata.html"),
  pdf: join(root, "dist", "wakako-obata.pdf"),
  atsHtml: join(root, "dist", "wakako-obata-ats.html"),
  atsPdf: join(root, "dist", "wakako-obata-ats.pdf"),
  manifest: join(root, "dist", "build.json"),
};

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT) || 8080;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

class HttpError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/* -------------------------------------------------------------------------- */
/* responses                                                                  */
/* -------------------------------------------------------------------------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function sendFile(res, filePath) {
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") throw new HttpError(404, "Not found.");
    throw error;
  }

  if (!info.isFile()) throw new HttpError(404, "Not found.");

  const type = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": info.size,
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(res);
}

/* -------------------------------------------------------------------------- */
/* build                                                                      */
/* -------------------------------------------------------------------------- */

let operationQueue = Promise.resolve();

function enqueue(operation) {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.catch(() => {});
  return result;
}

async function runBuild() {
  const started = Date.now();

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [paths.build],
      {
        cwd: root,
        timeout: 180_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    let manifest = { variants: {} };
    try {
      manifest = JSON.parse(await readFile(paths.manifest, "utf8"));
    } catch {
      /* the build should write this, but do not fail the save over it */
    }

    const variants = {};
    for (const [key, value] of Object.entries(manifest.variants ?? {})) {
      variants[key] = {
        label: value.label,
        htmlUrl: `/preview/${value.html}`,
        pdfUrl: `/preview/${value.pdf}`,
        pageCount: value.pageCount,
        sizeKb: value.sizeKb,
      };
    }

    return {
      variants,
      pageCount: variants.designed?.pageCount ?? null,
      sizeKb: variants.designed?.sizeKb ?? null,
      durationMs: Date.now() - started,
      log: stdout.trim(),
      warnings: stderr.trim() || null,
    };
  } catch (error) {
    const details = [error.stdout, error.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();

    throw new HttpError(
      500,
      "Build failed.",
      details || error.message || "Unknown build error.",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* request helpers                                                            */
/* -------------------------------------------------------------------------- */

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      rejectBody(error);
    };

    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new HttpError(413, "Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        settled = true;
        resolveBody(JSON.parse(text));
      } catch {
        fail(new HttpError(400, "Request body must be valid JSON."));
      }
    });

    req.on("error", (error) => fail(error));
  });
}

function validateForSave(data) {
  const errors = validateCv(data);

  const photo = data?.basics?.photo;
  if (typeof photo === "string" && photo.trim()) {
    const photoPath = resolve(root, photo);

    if (!photoPath.startsWith(root + sep)) {
      errors.push("basics.photo must be inside the project folder.");
    } else {
      try {
        if (!statSync(photoPath).isFile()) {
          errors.push("basics.photo must point to a file.");
        }
      } catch {
        errors.push(`Photo not found: ${photo}`);
      }
    }
  }

  return errors;
}

async function writeData(data) {
  const json = `${JSON.stringify(data, null, 2)}\n`;
  const temporary = `${paths.data}.tmp`;
  await writeFile(temporary, json, "utf8");
  await rename(temporary, paths.data);
}

/* -------------------------------------------------------------------------- */
/* API handlers                                                               */
/* -------------------------------------------------------------------------- */

async function handleGetCv(res) {
  const text = await readFile(paths.data, "utf8");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(500, "data/wakako-obata.json is not valid JSON.");
  }
  sendJson(res, 200, data);
}

async function handleGetBuild(res) {
  try {
    const manifest = JSON.parse(await readFile(paths.manifest, "utf8"));
    sendJson(res, 200, manifest);
  } catch {
    sendJson(res, 200, { variants: {} });
  }
}

async function handleSave(req, res) {
  const data = await readJsonBody(req);
  const errors = validateForSave(data);

  if (errors.length) {
    sendJson(res, 422, { ok: false, saved: false, errors });
    return;
  }

  let saved = false;

  try {
    const result = await enqueue(async () => {
      await writeData(data);
      saved = true;
      console.log(`Saved ${paths.data.replace(`${root}/`, "")}`);
      return runBuild();
    });

    console.log(`Rebuilt in ${result.durationMs} ms`);
    sendJson(res, 200, { ok: true, saved: true, ...result });
  } catch (error) {
    console.error(error.message);
    if (error.details) console.error(error.details);
    sendJson(res, error.status || 500, {
      ok: false,
      saved,
      error: error.message,
      details: error.details || null,
    });
  }
}

async function handleRebuild(res) {
  try {
    const result = await enqueue(runBuild);
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    console.error(error.message);
    if (error.details) console.error(error.details);
    sendJson(res, error.status || 500, {
      ok: false,
      error: error.message,
      details: error.details || null,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* static handlers                                                            */
/* -------------------------------------------------------------------------- */

async function handlePreview(res, pathname) {
  const relative =
    pathname === "/preview" || pathname === "/preview/"
      ? "wakako-obata.html"
      : pathname.slice("/preview/".length);

  const file = resolve(paths.dist, relative);
  if (!file.startsWith(paths.dist + sep)) {
    throw new HttpError(403, "Forbidden.");
  }

  await sendFile(res, file);
}

const editorFiles = new Map([
  ["/", "index.html"],
  ["/editor", "index.html"],
  ["/editor/", "index.html"],
  ["/editor/index.html", "index.html"],
  ["/editor.css", "editor.css"],
  ["/editor.js", "editor.js"],
]);

/* -------------------------------------------------------------------------- */
/* server                                                                     */
/* -------------------------------------------------------------------------- */

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === "GET" && editorFiles.has(pathname)) {
      await sendFile(res, join(paths.editor, editorFiles.get(pathname)));
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/preview")) {
      await handlePreview(res, pathname);
      return;
    }

    if (req.method === "GET" && pathname === "/api/cv") {
      await handleGetCv(res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/build") {
      await handleGetBuild(res);
      return;
    }

    if (req.method === "PUT" && pathname === "/api/cv") {
      await handleSave(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/rebuild") {
      await handleRebuild(res);
      return;
    }

    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    throw new HttpError(404, "Not found.");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error(error);

    if (!res.headersSent) {
      sendJson(res, status, {
        ok: false,
        error: error.message,
        details: error.details || null,
      });
    } else {
      res.destroy();
    }
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Try: PORT=8081 npm run editor`,
    );
    process.exit(1);
  }
  throw error;
});

async function start() {
  const required = [
    paths.html,
    paths.pdf,
    paths.atsHtml,
    paths.atsPdf,
    paths.manifest,
  ];

  if (required.some((file) => !existsSync(file))) {
    console.log("No complete build found — generating the initial HTML/PDFs…");
    try {
      await runBuild();
    } catch (error) {
      console.error(error.message);
      if (error.details) console.error(error.details);
    }
  }

  server.listen(PORT, HOST, () => {
    const displayHost = HOST === "0.0.0.0" ? "localhost" : HOST;
    console.log(`CV editor: http://${displayHost}:${PORT}`);
    console.log(
      `PDF:       http://${displayHost}:${PORT}/preview/wakako-obata.pdf`,
    );
  });
}

await start();
