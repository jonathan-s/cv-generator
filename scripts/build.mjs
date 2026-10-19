#!/usr/bin/env node
/**
 * Build the CV from JSON:
 *   data/wakako-obata.json  ->  dist/wakako-obata.html  ->  dist/wakako-obata.pdf
 *
 * No external dependencies. The PDF is printed with headless Chrome using the
 * print rules in styles/cv.css (@page A4, two fixed page sheets).
 */

import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const paths = {
  data: join(root, "data", "wakako-obata.json"),
  template: join(root, "templates", "cv.html"),
  styles: join(root, "styles", "cv.css"),
  assets: join(root, "assets"),
  outDir: join(root, "dist"),
  html: join(root, "dist", "wakako-obata.html"),
  pdf: join(root, "dist", "wakako-obata.pdf"),
};

const htmlOnly = process.argv.includes("--html-only");

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

const escapeHtml = (value = "") =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );

const requireField = (condition, message) => {
  if (!condition) throw new Error(`CV data error: ${message}`);
};

const renderListItems = (items = []) =>
  items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");

const renderEntries = (entries = []) =>
  entries
    .map((entry) => {
      const organisation =
        entry.company ?? entry.organization ?? entry.institution ?? "";
      const meta = [organisation, entry.location].filter(Boolean).join(", ");
      const highlights = entry.highlights ?? [];

      return `<article class="entry">
  <div class="entry__head">
    <h3 class="entry__title">${escapeHtml(entry.title)}</h3>
    ${entry.period ? `<span class="entry__period">${escapeHtml(entry.period)}</span>` : ""}
  </div>
  ${meta ? `<p class="entry__meta">${escapeHtml(meta)}</p>` : ""}
  ${
    highlights.length
      ? `<ul class="bullets">${renderListItems(highlights)}</ul>`
      : ""
  }
</article>`;
    })
    .join("\n");

const renderContact = (basics) => {
  const firstRow = [];
  const secondRow = [];

  if (basics.birth) firstRow.push(`<li>${escapeHtml(basics.birth)}</li>`);
  if (basics.address) firstRow.push(`<li>${escapeHtml(basics.address)}</li>`);

  if (basics.phone) {
    const phoneHref = String(basics.phone).replace(/[^\d+]/g, "");
    secondRow.push(
      `<li><a href="tel:${escapeHtml(phoneHref)}">${escapeHtml(basics.phone)}</a></li>`,
    );
  }

  if (basics.email) {
    secondRow.push(
      `<li><a href="mailto:${escapeHtml(basics.email)}">${escapeHtml(basics.email)}</a></li>`,
    );
  }

  return [firstRow, secondRow]
    .filter((row) => row.length)
    .map((row) => `<ul class="contact__row">${row.join("")}</ul>`)
    .join("\n");
};

const renderLanguages = (languages = []) =>
  languages
    .map((language) => {
      const max = language.maxLevel ?? 5;
      const level = Math.max(0, Math.min(Number(language.level) || 0, max));
      const dots = Array.from(
        { length: max },
        (_, index) =>
          `<span class="dot${index < level ? " dot--on" : ""}" aria-hidden="true"></span>`,
      ).join("");

      return `<li>
  <span class="language__name">${escapeHtml(language.name)}</span>
  <span class="dots" role="img" aria-label="${escapeHtml(language.name)}: ${level} von ${max}">${dots}</span>
</li>`;
    })
    .join("\n");

/* -------------------------------------------------------------------------- */
/* validate + render                                                          */
/* -------------------------------------------------------------------------- */

const data = JSON.parse(await readFile(paths.data, "utf8"));

for (const key of [
  "meta",
  "basics",
  "labels",
  "summary",
  "experience",
  "education",
  "volunteer",
  "skills",
  "languages",
  "hobbies",
  "closing",
]) {
  requireField(data[key], `missing "${key}"`);
}

requireField(data.basics.name, 'missing "basics.name"');
requireField(data.basics.photo, 'missing "basics.photo"');
requireField(
  existsSync(join(root, data.basics.photo)),
  `photo not found: ${data.basics.photo}`,
);
requireField(
  data.experience.every((entry) => entry.title),
  "every experience entry needs a title",
);
requireField(
  data.education.every((entry) => entry.title),
  "every education entry needs a title",
);
requireField(
  data.volunteer.every((entry) => entry.title),
  "every volunteer entry needs a title",
);

const tokens = {
  lang: escapeHtml(data.meta.language ?? "de"),
  title: escapeHtml(data.meta.title ?? `Lebenslauf – ${data.basics.name}`),
  name: escapeHtml(data.basics.name),
  tagline: escapeHtml(data.basics.tagline ?? ""),
  photo: escapeHtml(data.basics.photo),
  contact: renderContact(data.basics),
  summary: data.summary.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("\n"),
  experience: renderEntries(data.experience),
  education: renderEntries(data.education),
  volunteer: renderEntries(data.volunteer),
  technicalSkills: renderListItems(data.skills.technical ?? []),
  personalSkills: renderListItems(data.skills.personal ?? []),
  tools: renderListItems(data.skills.tools ?? []),
  languages: renderLanguages(data.languages),
  hobbies: renderListItems(data.hobbies),
  closingPlace: escapeHtml(data.closing.place ?? ""),
  closingDate: escapeHtml(data.closing.date ?? ""),
};

for (const [key, value] of Object.entries(data.labels)) {
  tokens[`labels.${key}`] = escapeHtml(value);
}

const template = await readFile(paths.template, "utf8");
const html = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
  if (!(key in tokens)) {
    throw new Error(`Unknown template token ${match} in templates/cv.html`);
  }
  return tokens[key];
});

if (/\{\{[^}]+\}\}/.test(html)) {
  throw new Error("Unresolved template tokens remain in the generated HTML");
}

await rm(paths.outDir, { recursive: true, force: true });
await mkdir(paths.outDir, { recursive: true });

await writeFile(paths.html, html, "utf8");
await cp(paths.styles, join(paths.outDir, "cv.css"));
await cp(paths.assets, join(paths.outDir, "assets"), { recursive: true });

console.log(`✓ ${paths.html.replace(`${root}/`, "")}`);

if (htmlOnly) process.exit(0);

/* -------------------------------------------------------------------------- */
/* PDF via headless Chrome                                                    */
/* -------------------------------------------------------------------------- */

const chromeCandidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const chrome = chromeCandidates.find((candidate) => existsSync(candidate));

if (!chrome) {
  throw new Error(
    "Chrome/Chromium not found. Set CHROME_PATH or use --html-only.",
  );
}

const profileDir = join(tmpdir(), `wakako-cv-chrome-${process.pid}`);

try {
  await execFileAsync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-pdf-header-footer",
      "--run-all-compositor-stages-before-draw",
      "--virtual-time-budget=5000",
      `--user-data-dir=${profileDir}`,
      `--print-to-pdf=${paths.pdf}`,
      pathToFileURL(paths.html).href,
    ],
    { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
  );
} finally {
  await rm(profileDir, { recursive: true, force: true });
}

const pdfStat = await stat(paths.pdf);
requireField(pdfStat.size > 1000, "generated PDF is unexpectedly small");

let pageCount = null;

const gsCandidates = [
  process.env.GS_PATH,
  "/opt/homebrew/bin/gs",
  "/usr/local/bin/gs",
  "/usr/bin/gs",
].filter(Boolean);
const ghostscript = gsCandidates.find((candidate) => existsSync(candidate));

if (ghostscript) {
  const escapedPath = paths.pdf
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
  try {
    const { stdout } = await execFileAsync(ghostscript, [
      "-q",
      "-dNODISPLAY",
      "-dNOSAFER",
      "-c",
      `(${escapedPath}) (r) file runpdfbegin pdfpagecount = quit`,
    ]);
    const parsed = Number.parseInt(stdout.trim(), 10);
    if (Number.isFinite(parsed)) pageCount = parsed;
  } catch {
    /* page count is informational only */
  }
}

if (pageCount === null && process.platform === "darwin") {
  try {
    const { stdout } = await execFileAsync("mdls", [
      "-name",
      "kMDItemNumberOfPages",
      "-raw",
      paths.pdf,
    ]);
    const parsed = Number.parseInt(stdout.trim(), 10);
    if (Number.isFinite(parsed)) pageCount = parsed;
  } catch {
    /* page count is informational only */
  }
}

const sizeKb = Math.round(pdfStat.size / 1024);
console.log(
  `✓ ${paths.pdf.replace(`${root}/`, "")} (${pageCount ? `${pageCount} pages, ` : ""}${sizeKb} KB)`,
);

if (pageCount !== null && pageCount !== 2) {
  console.warn(
    `⚠ expected a two-page CV, but the PDF has ${pageCount} pages — check the spacing in styles/cv.css`,
  );
}
