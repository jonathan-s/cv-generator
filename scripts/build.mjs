#!/usr/bin/env node
/**
 * Build both CV variants from the same JSON:
 *
 *   data/wakako-obata.json
 *     -> dist/wakako-obata.html      + dist/wakako-obata.pdf      (designed)
 *     -> dist/wakako-obata-ats.html  + dist/wakako-obata-ats.pdf  (ATS)
 *
 * No external dependencies. The PDFs are printed with headless Chrome.
 */

import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { validateCv } from "./lib/validate.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const paths = {
  data: join(root, "data", "wakako-obata.json"),
  outDir: join(root, "dist"),
};

const htmlOnly = process.argv.includes("--html-only");

const variants = [
  {
    key: "designed",
    label: "Designed",
    template: join(root, "templates", "cv.html"),
    stylesheet: join(root, "styles", "cv.css"),
    stylesheetName: "cv.css",
    html: join(paths.outDir, "wakako-obata.html"),
    pdf: join(paths.outDir, "wakako-obata.pdf"),
    expectedPages: 2,
  },
  {
    key: "ats",
    label: "ATS",
    template: join(root, "templates", "cv-ats.html"),
    stylesheet: join(root, "styles", "cv-ats.css"),
    stylesheetName: "cv-ats.css",
    html: join(paths.outDir, "wakako-obata-ats.html"),
    pdf: join(paths.outDir, "wakako-obata-ats.pdf"),
    expectedPages: 2,
  },
];

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

const renderInlineList = (items = [], separator = " · ") =>
  items.map((item) => escapeHtml(item)).join(separator);

const languageLevel = (language) =>
  (typeof language.levelLabel === "string" && language.levelLabel.trim()) ||
  `${language.level}/${language.maxLevel ?? 5}`;

const renderLanguagesInline = (languages = [], separator = " · ") =>
  languages
    .map(
      (language) =>
        `${escapeHtml(language.name)} (${escapeHtml(languageLevel(language))})`,
    )
    .join(separator);

/* designed layout entries: title + right-aligned date, company below */
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

/* ATS layout entries: title, company/location/date, bullets in DOM order */
const renderEntriesAts = (entries = []) =>
  entries
    .map((entry) => {
      const organisation =
        entry.company ?? entry.organization ?? entry.institution ?? "";
      const meta = [organisation, entry.location].filter(Boolean).join(", ");
      const line = [meta, entry.period].filter(Boolean).join(" | ");
      const highlights = entry.highlights ?? [];

      return `<div class="ats-entry">
  <h3 class="ats-entry__title">${escapeHtml(entry.title)}</h3>
  ${line ? `<p class="ats-entry__meta">${escapeHtml(line)}</p>` : ""}
  ${
    highlights.length
      ? `<ul class="ats-bullets">${renderListItems(highlights)}</ul>`
      : ""
  }
</div>`;
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

const renderContactInline = (basics) => {
  const items = [];

  if (basics.birth) items.push(escapeHtml(basics.birth));
  if (basics.address) items.push(escapeHtml(basics.address));

  if (basics.phone) {
    const phoneHref = String(basics.phone).replace(/[^\d+]/g, "");
    items.push(
      `<a href="tel:${escapeHtml(phoneHref)}">${escapeHtml(basics.phone)}</a>`,
    );
  }

  if (basics.email) {
    items.push(
      `<a href="mailto:${escapeHtml(basics.email)}">${escapeHtml(basics.email)}</a>`,
    );
  }

  return items.join(" | ");
};

/* -------------------------------------------------------------------------- */
/* validate + render                                                          */
/* -------------------------------------------------------------------------- */

const data = JSON.parse(await readFile(paths.data, "utf8"));

const validationErrors = validateCv(data);
if (validationErrors.length) {
  throw new Error(`CV data error:\n- ${validationErrors.join("\n- ")}`);
}

const photoSource = resolve(root, data.basics.photo);
requireField(
  photoSource.startsWith(root + sep),
  "basics.photo must be inside the project folder",
);
requireField(
  existsSync(photoSource),
  `photo not found: ${data.basics.photo}`,
);
requireField(
  (await stat(photoSource)).isFile(),
  "basics.photo must point to a file",
);

const tokens = {
  lang: escapeHtml(data.meta.language ?? "de"),
  title: escapeHtml(data.meta.title ?? `Lebenslauf – ${data.basics.name}`),
  name: escapeHtml(data.basics.name),
  tagline: escapeHtml(data.basics.tagline ?? ""),
  photo: escapeHtml(encodeURI(data.basics.photo)),
  contact: renderContact(data.basics),
  contactInline: renderContactInline(data.basics),
  summary: data.summary
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("\n"),
  experience: renderEntries(data.experience),
  education: renderEntries(data.education),
  volunteer: renderEntries(data.volunteer),
  experienceAts: renderEntriesAts(data.experience),
  educationAts: renderEntriesAts(data.education),
  volunteerAts: renderEntriesAts(data.volunteer),
  technicalSkills: renderListItems(data.skills.technical ?? []),
  personalSkills: renderListItems(data.skills.personal ?? []),
  technicalInlineAts: renderInlineList(data.skills.technical ?? [], ", "),
  personalInlineAts: renderInlineList(data.skills.personal ?? [], ", "),
  languagesInline: renderLanguagesInline(data.languages, " · "),
  languagesInlineAts: renderLanguagesInline(data.languages, ", "),
  toolsInline: renderInlineList(data.skills.tools ?? [], " · "),
  toolsInlineAts: renderInlineList(data.skills.tools ?? [], ", "),
  hobbiesInline: renderInlineList(data.hobbies, " · "),
  closingPlace: escapeHtml(data.closing.place ?? ""),
  closingDate: escapeHtml(data.closing.date ?? ""),
};

for (const [key, value] of Object.entries(data.labels)) {
  tokens[`labels.${key}`] = escapeHtml(value);
}

const renderTemplate = async (variant) => {
  const template = await readFile(variant.template, "utf8");
  const html = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
    if (!(key in tokens)) {
      throw new Error(
        `Unknown template token ${match} in ${relative(root, variant.template)}`,
      );
    }
    return tokens[key];
  });

  if (/\{\{[^}]+\}\}/.test(html)) {
    throw new Error(
      `Unresolved template tokens remain in ${relative(root, variant.template)}`,
    );
  }

  return html;
};

/* -------------------------------------------------------------------------- */
/* write HTML + assets                                                       */
/* -------------------------------------------------------------------------- */

await rm(paths.outDir, { recursive: true, force: true });
await mkdir(paths.outDir, { recursive: true });

for (const variant of variants) {
  const html = await renderTemplate(variant);
  await writeFile(variant.html, html, "utf8");
  await cp(variant.stylesheet, join(paths.outDir, variant.stylesheetName));
  console.log(`✓ ${relative(root, variant.html)}`);
}

const photoTarget = resolve(paths.outDir, data.basics.photo);
requireField(
  photoTarget.startsWith(paths.outDir + sep),
  "basics.photo must be inside the output folder",
);
await mkdir(dirname(photoTarget), { recursive: true });
await cp(photoSource, photoTarget);

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

const gsCandidates = [
  process.env.GS_PATH,
  "/opt/homebrew/bin/gs",
  "/usr/local/bin/gs",
  "/usr/bin/gs",
].filter(Boolean);
const ghostscript = gsCandidates.find((candidate) => existsSync(candidate));

async function getPdfPageCount(pdfPath) {
  if (ghostscript) {
    const escapedPath = pdfPath
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
      if (Number.isFinite(parsed)) return parsed;
    } catch {
      /* fall through to mdls */
    }
  }

  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("mdls", [
        "-name",
        "kMDItemNumberOfPages",
        "-raw",
        pdfPath,
      ]);
      const parsed = Number.parseInt(stdout.trim(), 10);
      if (Number.isFinite(parsed)) return parsed;
    } catch {
      /* page count is informational only */
    }
  }

  return null;
}

for (const variant of variants) {
  const profileDir = join(
    tmpdir(),
    `wakako-cv-chrome-${process.pid}-${variant.key}`,
  );

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
        `--print-to-pdf=${variant.pdf}`,
        pathToFileURL(variant.html).href,
      ],
      { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
    );
  } finally {
    await rm(profileDir, { recursive: true, force: true });
  }

  const info = await stat(variant.pdf);
  requireField(info.size > 1000, `${variant.label} PDF is unexpectedly small`);

  variant.pageCount = await getPdfPageCount(variant.pdf);
  variant.sizeKb = Math.round(info.size / 1024);

  console.log(
    `✓ ${relative(root, variant.pdf)} (${variant.pageCount ? `${variant.pageCount} pages, ` : ""}${variant.sizeKb} KB)`,
  );

  if (
    variant.pageCount !== null &&
    variant.pageCount !== variant.expectedPages
  ) {
    console.warn(
      `⚠ ${variant.label} expected ${variant.expectedPages} pages, got ${variant.pageCount} — check ${relative(root, variant.stylesheet)}`,
    );
  }
}

const manifest = {
  builtAt: new Date().toISOString(),
  variants: Object.fromEntries(
    variants.map((variant) => [
      variant.key,
      {
        label: variant.label,
        html: relative(paths.outDir, variant.html),
        pdf: relative(paths.outDir, variant.pdf),
        pageCount: variant.pageCount,
        sizeKb: variant.sizeKb,
      },
    ]),
  ),
};

await writeFile(
  join(paths.outDir, "build.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
