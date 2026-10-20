#!/usr/bin/env node
/**
 * Local CV editor.
 *
 *   npm run editor   ->  http://127.0.0.1:8080
 *
 * Every JSON file in data/ is a selectable data profile. The editor is a plain
 * HTML/CSS/JS page. Saving sends the whole JSON document to
 * PUT /api/cv?profile=<id>, which:
 *   1. validates the document,
 *   2. writes it atomically to data/<id>.json,
 *   3. runs scripts/build.mjs --profile <id> (HTML + PDF),
 *   4. returns the build result so the preview can refresh.
 */

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCv } from "./scripts/lib/validate.mjs";
import {
  assertProfileId,
  listProfiles,
  profileOutputs,
  profilePaths,
  readManifest,
} from "./scripts/lib/profiles.mjs";

const execFileAsync = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));

const paths = {
  build: join(root, "scripts", "build.mjs"),
  editor: join(root, "editor"),
  dist: join(root, "dist"),
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
/* profiles                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Resolves the `?profile=<id>` query parameter. Without one, the first profile
 * in data/ (alphabetical) is used.
 */
async function resolveProfile(url) {
  const profiles = await listProfiles(root);

  if (!profiles.length) {
    throw new HttpError(404, "No data profiles found. Add a JSON file to data/.");
  }

  const requested = url.searchParams.get("profile");
  if (!requested) return profilePaths(root, profiles[0].id);

  try {
    assertProfileId(requested);
  } catch (error) {
    throw new HttpError(400, error.message);
  }

  if (!profiles.some((profile) => profile.id === requested)) {
    throw new HttpError(404, `Unknown profile: ${requested}.`);
  }

  return profilePaths(root, requested);
}

function variantPayload(variants) {
  const payload = {};

  for (const [key, variant] of Object.entries(variants ?? {})) {
    payload[key] = {
      label: variant.label,
      htmlUrl: variant.html ? `/preview/${variant.html}` : null,
      pdfUrl: variant.pdf ? `/preview/${variant.pdf}` : null,
      pageCount: variant.pageCount ?? null,
      sizeKb: variant.sizeKb ?? null,
    };
  }

  return payload;
}

async function buildPayload(profileId) {
  const manifest = await readManifest(root);
  const entry = manifest.profiles[profileId] ?? null;
  const variants = variantPayload(entry?.variants);

  return {
    profile: profileId,
    label: entry?.label ?? profileId,
    builtAt: entry?.builtAt ?? manifest.builtAt ?? null,
    variants,
    pageCount: variants.designed?.pageCount ?? null,
    sizeKb: variants.designed?.sizeKb ?? null,
  };
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

async function runBuild(profileId = null) {
  const started = Date.now();
  const args = [paths.build];
  if (profileId) args.push("--profile", profileId);

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: root,
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
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

async function writeData(profile, data) {
  const json = `${JSON.stringify(data, null, 2)}\n`;
  const temporary = `${profile.dataFile}.tmp`;
  await writeFile(temporary, json, "utf8");
  await rename(temporary, profile.dataFile);
}

/* -------------------------------------------------------------------------- */
/* cover letter                                                               */
/* -------------------------------------------------------------------------- */

/** The letter is optional: a missing file simply means an empty letter. */
async function readCoverLetter(profile) {
  try {
    return await readFile(profile.coverLetterFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw new HttpError(
      500,
      `Could not read data/${profile.id}.cover-letter.md.`,
    );
  }
}

/** Writes the markdown atomically; an empty letter removes the file. */
async function writeCoverLetter(profile, markdown) {
  if (!markdown.trim()) {
    await rm(profile.coverLetterFile, { force: true });
    return false;
  }

  const temporary = `${profile.coverLetterFile}.tmp`;
  const content = markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, profile.coverLetterFile);
  return true;
}

/* -------------------------------------------------------------------------- */
/* API handlers                                                               */
/* -------------------------------------------------------------------------- */

async function handleGetProfiles(res) {
  const [profiles, manifest] = await Promise.all([
    listProfiles(root),
    readManifest(root),
  ]);

  const payload = profiles.map((profile) => ({
    id: profile.id,
    file: profile.file,
    name: profile.name || profile.id,
    title: profile.title || "",
    updated: profile.updated || "",
    valid: profile.valid,
    built: Boolean(manifest.profiles[profile.id]),
  }));

  sendJson(res, 200, {
    profiles: payload,
    default: payload[0]?.id ?? null,
  });
}

async function handleGetCv(res, profile) {
  const text = await readFile(profile.dataFile, "utf8");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(
      500,
      `data/${profile.id}.json is not valid JSON.`,
    );
  }
  sendJson(res, 200, data);
}

async function handleGetBuild(res, profile) {
  sendJson(res, 200, { ok: true, ...(await buildPayload(profile.id)) });
}

async function handleGetCoverLetter(res, profile) {
  const markdown = await readCoverLetter(profile);

  sendJson(res, 200, {
    profile: profile.id,
    file: `data/${profile.id}.cover-letter.md`,
    exists: markdown.trim().length > 0,
    markdown,
  });
}

async function handleSave(req, res, profile) {
  const data = await readJsonBody(req);
  const errors = validateForSave(data);

  if (errors.length) {
    sendJson(res, 422, {
      ok: false,
      saved: false,
      profile: profile.id,
      errors,
    });
    return;
  }

  let saved = false;

  try {
    const result = await enqueue(async () => {
      await writeData(profile, data);
      saved = true;
      console.log(`Saved data/${profile.id}.json`);
      return runBuild(profile.id);
    });

    console.log(`Rebuilt ${profile.id} in ${result.durationMs} ms`);
    const build = await buildPayload(profile.id);
    sendJson(res, 200, {
      ok: true,
      saved: true,
      ...build,
      durationMs: result.durationMs,
      log: result.log,
      warnings: result.warnings,
    });
  } catch (error) {
    console.error(error.message);
    if (error.details) console.error(error.details);
    sendJson(res, error.status || 500, {
      ok: false,
      saved,
      profile: profile.id,
      error: error.message,
      details: error.details || null,
    });
  }
}

/**
 * Combined save used by the editor: CV JSON + cover letter markdown, then a
 * single rebuild. Both files are written before the build starts.
 */
async function handleSaveDocument(req, res, profile) {
  const body = await readJsonBody(req);
  const data = body?.cv;
  const markdown = body?.coverLetter;

  const errors = [];

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    errors.push("cv must be a JSON object.");
  } else {
    errors.push(...validateForSave(data));
  }

  if (markdown != null && typeof markdown !== "string") {
    errors.push("coverLetter must be a string.");
  }

  if (errors.length) {
    sendJson(res, 422, {
      ok: false,
      saved: false,
      profile: profile.id,
      errors,
    });
    return;
  }

  let saved = false;
  let savedCoverLetter = false;

  try {
    const result = await enqueue(async () => {
      await writeData(profile, data);
      saved = true;
      console.log(`Saved data/${profile.id}.json`);

      if (markdown != null) {
        savedCoverLetter = await writeCoverLetter(profile, markdown);
        console.log(
          savedCoverLetter
            ? `Saved data/${profile.id}.cover-letter.md`
            : `Removed data/${profile.id}.cover-letter.md (empty letter)`,
        );
      }

      return runBuild(profile.id);
    });

    console.log(`Rebuilt ${profile.id} in ${result.durationMs} ms`);
    const build = await buildPayload(profile.id);
    sendJson(res, 200, {
      ok: true,
      saved: true,
      savedCoverLetter,
      coverLetterFile: `data/${profile.id}.cover-letter.md`,
      ...build,
      durationMs: result.durationMs,
      log: result.log,
      warnings: result.warnings,
    });
  } catch (error) {
    console.error(error.message);
    if (error.details) console.error(error.details);
    sendJson(res, error.status || 500, {
      ok: false,
      saved,
      savedCoverLetter,
      profile: profile.id,
      error: error.message,
      details: error.details || null,
    });
  }
}

async function handleRebuild(res, profile) {
  try {
    const result = await enqueue(() => runBuild(profile.id));
    const build = await buildPayload(profile.id);
    sendJson(res, 200, {
      ok: true,
      ...build,
      durationMs: result.durationMs,
      log: result.log,
      warnings: result.warnings,
    });
  } catch (error) {
    console.error(error.message);
    if (error.details) console.error(error.details);
    sendJson(res, error.status || 500, {
      ok: false,
      profile: profile.id,
      error: error.message,
      details: error.details || null,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* static handlers                                                            */
/* -------------------------------------------------------------------------- */

async function defaultPreviewFile() {
  const profiles = await listProfiles(root);
  if (!profiles.length) {
    throw new HttpError(404, "No data profiles found. Add a JSON file to data/.");
  }
  return `${profiles[0].id}.html`;
}

async function handlePreview(res, pathname) {
  const relativePath =
    pathname === "/preview" || pathname === "/preview/"
      ? await defaultPreviewFile()
      : pathname.slice("/preview/".length);

  const file = resolve(paths.dist, relativePath);
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

    if (req.method === "GET" && pathname === "/api/profiles") {
      await handleGetProfiles(res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/cv") {
      await handleGetCv(res, await resolveProfile(url));
      return;
    }

    if (req.method === "GET" && pathname === "/api/build") {
      await handleGetBuild(res, await resolveProfile(url));
      return;
    }

    if (req.method === "GET" && pathname === "/api/cover-letter") {
      await handleGetCoverLetter(res, await resolveProfile(url));
      return;
    }

    if (req.method === "PUT" && pathname === "/api/cv") {
      await handleSave(req, res, await resolveProfile(url));
      return;
    }

    if (req.method === "PUT" && pathname === "/api/document") {
      await handleSaveDocument(req, res, await resolveProfile(url));
      return;
    }

    if (req.method === "POST" && pathname === "/api/rebuild") {
      await handleRebuild(res, await resolveProfile(url));
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
  const [profiles, manifest] = await Promise.all([
    listProfiles(root),
    readManifest(root),
  ]);

  if (!profiles.length) {
    console.log("No data profiles found. Add a JSON file to data/.");
  } else {
    const needsBuild = profiles.some((profile) => {
      const profilePath = profilePaths(root, profile.id);
      const missing = profileOutputs(profilePath).some(
        (file) => !existsSync(file),
      );

      if (!manifest.profiles[profile.id] || missing) return true;

      /* an existing cover letter must have its HTML and PDF as well */
      return (
        existsSync(profilePath.coverLetterFile) &&
        (!existsSync(profilePath.coverLetterHtml) ||
          !existsSync(profilePath.coverLetterPdf))
      );
    });

    if (needsBuild) {
      console.log("No complete build found — generating the HTML/PDFs…");
      try {
        await runBuild();
      } catch (error) {
        console.error(error.message);
        if (error.details) console.error(error.details);
      }
    }
  }

  server.listen(PORT, HOST, () => {
    const displayHost = HOST === "0.0.0.0" ? "localhost" : HOST;
    console.log(`CV editor: http://${displayHost}:${PORT}`);
  });
}

await start();
