#!/usr/bin/env node
/**
 * Build CV profiles from data/*.json:
 *
 *   data/<profile>.json
 *     -> dist/<profile>.html      + dist/<profile>.pdf      (designed)
 *     -> dist/<profile>-ats.html  + dist/<profile>-ats.pdf  (ATS)
 *
 * No external dependencies. The PDFs are printed with headless Chrome.
 *
 *   node scripts/build.mjs                        build every data/*.json profile
 *   node scripts/build.mjs --profile wakako-obata build one profile
 *   node scripts/build.mjs --html-only            skip the PDFs
 */

import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { validateCv } from "./lib/validate.mjs";
import {
  assertProfileId,
  listProfiles,
  profileLabel,
  profilePaths,
  readManifest,
  writeManifest,
} from "./lib/profiles.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist");

const htmlOnly = process.argv.includes("--html-only");

/* -------------------------------------------------------------------------- */
/* CLI arguments                                                              */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);

function readOption(name) {
  const inline = argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) {
    const value = inline.slice(name.length + 1);
    if (!value) throw new Error(`${name} needs a value.`);
    return value;
  }

  const index = argv.indexOf(name);
  if (index === -1) return null;

  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} needs a value.`);
  }
  return value;
}

const requestedProfile = readOption("--profile");
const availableProfiles = await listProfiles(root);

if (!availableProfiles.length) {
  throw new Error("No data profiles found. Add a JSON file to data/.");
}

if (
  requestedProfile &&
  !availableProfiles.some((profile) => profile.id === requestedProfile)
) {
  throw new Error(
    `Unknown profile "${requestedProfile}". Available: ${availableProfiles
      .map((profile) => profile.id)
      .join(", ")}`,
  );
}

const profileIds = requestedProfile
  ? [assertProfileId(requestedProfile)]
  : availableProfiles.map((profile) => profile.id);

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
/* tokens + render                                                            */
/* -------------------------------------------------------------------------- */

const buildTokens = (data) => {
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

  return tokens;
};

const templates = {
  designed: join(root, "templates", "cv.html"),
  ats: join(root, "templates", "cv-ats.html"),
};

const stylesheets = {
  designed: {
    source: join(root, "styles", "cv.css"),
    name: "cv.css",
  },
  ats: {
    source: join(root, "styles", "cv-ats.css"),
    name: "cv-ats.css",
  },
};

const variantsFor = (paths) => [
  {
    key: "designed",
    label: "Designed",
    template: templates.designed,
    stylesheet: stylesheets.designed.source,
    stylesheetName: stylesheets.designed.name,
    html: paths.html,
    pdf: paths.pdf,
    expectedPages: 2,
  },
  {
    key: "ats",
    label: "ATS",
    template: templates.ats,
    stylesheet: stylesheets.ats.source,
    stylesheetName: stylesheets.ats.name,
    html: paths.atsHtml,
    pdf: paths.atsPdf,
    expectedPages: 2,
  },
];

async function renderTemplate(variant, tokens) {
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
}

/* -------------------------------------------------------------------------- */
/* HTML + assets                                                             */
/* -------------------------------------------------------------------------- */

await mkdir(outDir, { recursive: true });

const built = [];

for (const id of profileIds) {
  const paths = profilePaths(root, id);

  let data;
  try {
    data = JSON.parse(await readFile(paths.dataFile, "utf8"));
  } catch (error) {
    throw new Error(`Could not read data/${id}.json: ${error.message}`);
  }

  const validationErrors = validateCv(data);
  if (validationErrors.length) {
    throw new Error(
      `CV data error in data/${id}.json:\n- ${validationErrors.join("\n- ")}`,
    );
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

  const photoTarget = resolve(outDir, data.basics.photo);
  requireField(
    photoTarget.startsWith(outDir + sep),
    "basics.photo must be inside the output folder",
  );

  const tokens = buildTokens(data);
  const variants = variantsFor(paths);

  for (const variant of variants) {
    const html = await renderTemplate(variant, tokens);
    await writeFile(variant.html, html, "utf8");
    await cp(variant.stylesheet, join(outDir, variant.stylesheetName));
    console.log(`✓ ${relative(root, variant.html)}`);
  }

  await mkdir(dirname(photoTarget), { recursive: true });
  await cp(photoSource, photoTarget);

  built.push({ id, data, paths, variants });
}

/* -------------------------------------------------------------------------- */
/* PDF via headless Chrome                                                    */
/* -------------------------------------------------------------------------- */

if (!htmlOnly) {
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

  for (const item of built) {
    for (const variant of item.variants) {
      const profileDir = join(
        tmpdir(),
        `cv-chrome-${process.pid}-${item.id}-${variant.key}`,
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
      requireField(
        info.size > 1000,
        `${variant.label} PDF is unexpectedly small`,
      );

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
  }
}

/* -------------------------------------------------------------------------- */
/* manifest                                                                   */
/* -------------------------------------------------------------------------- */

if (!htmlOnly) {
  const manifest = await readManifest(root);
  const now = new Date().toISOString();
  const knownIds = new Set(availableProfiles.map((profile) => profile.id));
  const profiles = {};

  /* keep entries for profiles that still exist but were not rebuilt now */
  for (const [id, entry] of Object.entries(manifest.profiles)) {
    if (knownIds.has(id) && !built.some((item) => item.id === id)) {
      profiles[id] = entry;
      continue;
    }

    /* the data file is gone: drop its stale HTML/PDF from dist */
    if (!knownIds.has(id)) {
      for (const variant of Object.values(entry?.variants ?? {})) {
        for (const name of [variant.html, variant.pdf]) {
          if (typeof name === "string" && !/[\\/]/.test(name)) {
            await rm(join(outDir, name), { force: true });
          }
        }
      }
    }
  }

  for (const item of built) {
    profiles[item.id] = {
      label: profileLabel(item.data, item.id),
      name: item.data.basics.name,
      data: relative(root, item.paths.dataFile),
      builtAt: now,
      variants: Object.fromEntries(
        item.variants.map((variant) => [
          variant.key,
          {
            label: variant.label,
            html: relative(outDir, variant.html),
            pdf: relative(outDir, variant.pdf),
            pageCount: variant.pageCount ?? null,
            sizeKb: variant.sizeKb ?? null,
          },
        ]),
      ),
    };
  }

  await writeManifest(root, { builtAt: now, profiles });
}
