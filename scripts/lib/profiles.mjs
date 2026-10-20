/**
 * Data profile discovery, shared by the build and the editor server.
 *
 * A profile is one JSON file in data/. Its id is the file name without the
 * ".json" extension, and that id also names its build outputs:
 *
 *   data/<id>.json  ->  dist/<id>.html      dist/<id>.pdf
 *                       dist/<id>-ats.html  dist/<id>-ats.pdf
 */

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function dataDir(root) {
  return join(root, "data");
}

export function assertProfileId(id) {
  if (typeof id !== "string" || !PROFILE_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid profile id ${JSON.stringify(id)}. Use letters, digits, ".", "_" or "-".`,
    );
  }
  return id;
}

export function profilePaths(root, id) {
  assertProfileId(id);

  const outDir = join(root, "dist");

  return {
    id,
    dataFile: join(dataDir(root), `${id}.json`),
    coverLetterFile: join(dataDir(root), `${id}.cover-letter.md`),
    outDir,
    html: join(outDir, `${id}.html`),
    pdf: join(outDir, `${id}.pdf`),
    atsHtml: join(outDir, `${id}-ats.html`),
    atsPdf: join(outDir, `${id}-ats.pdf`),
    coverLetterHtml: join(outDir, `${id}-cover-letter.html`),
    coverLetterPdf: join(outDir, `${id}-cover-letter.pdf`),
  };
}

/**
 * Paths the build always produces. The cover letter is optional (it only
 * exists when data/<id>.cover-letter.md has content), so it is not part of
 * this list.
 */
export function profileOutputs(paths) {
  return [paths.html, paths.pdf, paths.atsHtml, paths.atsPdf];
}

export function profileLabel(data, fallback = "") {
  const name = data?.basics?.name;
  return (typeof name === "string" && name.trim()) || fallback;
}

export async function listProfileIds(root) {
  let entries;
  try {
    entries = await readdir(dataDir(root), { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        !entry.name.startsWith("."),
    )
    .map((entry) => entry.name.slice(0, -".json".length))
    .filter((id) => PROFILE_ID_PATTERN.test(id))
    .sort((a, b) => a.localeCompare(b, "en"));
}

/**
 * Metadata for the profile picker. A broken JSON file must not break the
 * listing, so parse failures fall back to the file name.
 */
export async function listProfiles(root) {
  const ids = await listProfileIds(root);

  return Promise.all(
    ids.map(async (id) => {
      const file = `data/${id}.json`;
      let meta = { name: "", title: "", updated: "", valid: false };

      try {
        const data = JSON.parse(
          await readFile(join(dataDir(root), `${id}.json`), "utf8"),
        );
        meta = {
          name: typeof data?.basics?.name === "string" ? data.basics.name : "",
          title: typeof data?.meta?.title === "string" ? data.meta.title : "",
          updated:
            typeof data?.meta?.updated === "string" ? data.meta.updated : "",
          valid: true,
        };
      } catch {
        /* a broken profile is still listed so the file can be fixed */
      }

      return { id, file, ...meta, label: meta.name || id };
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* build manifest                                                             */
/*                                                                            */
/* dist/build.json holds one entry per built profile so the editor can show   */
/* page counts for whichever profile is selected:                             */
/*                                                                            */
/*   { "builtAt": "…", "profiles": { "<id>": { label, variants: { … } } } }   */
/* -------------------------------------------------------------------------- */

export function manifestFile(root) {
  return join(root, "dist", "build.json");
}

export async function readManifest(root) {
  try {
    const raw = JSON.parse(await readFile(manifestFile(root), "utf8"));

    return {
      builtAt: typeof raw?.builtAt === "string" ? raw.builtAt : null,
      profiles:
        raw?.profiles && typeof raw.profiles === "object" ? raw.profiles : {},
    };
  } catch {
    return { builtAt: null, profiles: {} };
  }
}

export async function writeManifest(root, manifest) {
  const file = manifestFile(root);
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(
    `${file}.tmp`,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await rename(`${file}.tmp`, file);
}
