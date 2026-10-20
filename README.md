# Wakako Obata – CV

A small pipeline with no npm dependencies that turns a JSON data profile into two A4 CV variants: a designed two-page CV and a plain single-column ATS version. Both are generated from the same data. An optional cover letter, written as Markdown, is built into its own A4 page that reuses the CV header (without the photo).

Each JSON file in `data/` is one profile. Its file name (without `.json`) is the profile id, and it names the build outputs: `data/<id>.json` → `dist/<id>.html`, `dist/<id>.pdf`, `dist/<id>-ats.html`, `dist/<id>-ats.pdf`. The editor lets you switch between profiles with a dropdown at the top.

The designed layout follows the **Madelin Parker two-page A4** reference: a circular photo, large name, tagline, contact rows, thin section rules, bold uppercase section headings, single-column body copy, compact multi-column lists for skills, and a repeated name on page 2. The ATS variant deliberately drops the photo, columns, decorative dots and hobbies, using plain text and standard German headings instead.

## Editor

Start the local editor:

```bash
npm run editor
```

Open **http://127.0.0.1:8080**. The **Profile** dropdown in the top bar lists every JSON file in `data/`; the selection is kept in the URL (`?profile=<id>`) and in local storage, so a reload returns to the same profile. The page loads the selected profile into fields. **Save & rebuild** writes that JSON (and the cover letter Markdown), regenerates the HTML and PDFs, and refreshes the preview. Use the **Designed / ATS / Cover letter** toggle in the preview bar; **Open PDF** follows the selected variant.

Switching profiles with unsaved changes asks for confirmation, and saving only ever touches the selected `data/<id>.json`, its optional `data/<id>.cover-letter.md` and their outputs — other profiles' files and builds are left alone.

The server binds to `127.0.0.1` by default. Use `PORT=8081 npm run editor` to pick another port. It has no npm dependencies and uses the same validation module as the build (`scripts/lib/validate.mjs`), so invalid data is rejected before the JSON file is touched.

Useful endpoints (`profile` defaults to the first file in `data/` when omitted):

```text
GET  /api/profiles             list profiles in data/ (+ which are built)
GET  /api/cv?profile=<id>      current JSON for a profile
GET  /api/cover-letter?profile=<id>  current cover letter Markdown
GET  /api/build?profile=<id>   current build manifest for a profile
PUT  /api/cv?profile=<id>      validate + write JSON + rebuild that profile
PUT  /api/document?profile=<id> save { cv, coverLetter } in one go + rebuild
POST /api/rebuild?profile=<id> rebuild a profile without writing JSON
```

The editor saves through `PUT /api/document` with `{ "cv": { … }, "coverLetter": "# Markdown…" }`, so the JSON and the Markdown are written before a single rebuild. An empty `coverLetter` deletes the Markdown file instead of writing a blank one.

## Build

Requirements: Node 18+, Google Chrome/Chromium for the PDF, and optionally Ghostscript for the page-count check.

```bash
npm run build
```

By default every `data/*.json` profile is built. Build one profile, or skip the PDFs:

```bash
node scripts/build.mjs --profile wakako-obata
npm run build:html
npm run build:html -- --profile wakako-obata
```

Outputs (one set per profile):

```
dist/
├── wakako-obata.html       # designed HTML
├── wakako-obata.pdf        # designed, exactly 2 A4 pages
├── wakako-obata-ats.html   # ATS HTML
├── wakako-obata-ats.pdf    # ATS, 2 A4 pages
├── wakako-obata-cover-letter.html  # only when the letter exists
├── wakako-obata-cover-letter.pdf   # one A4 page
├── cv.css                  # designed styles (shared)
├── cv-ats.css              # ATS styles (shared)
├── cover-letter.css        # cover letter additions on top of cv.css
├── build.json              # manifest per profile: page counts and sizes
└── assets/
    └── wakako-obata.jpg
```

`dist/` is generated and git-ignored. Remove the `dist/` line from `.gitignore` if you want to commit the built PDFs. A profile build only rewrites that profile's files, so building one profile never wipes another profile's output. Removing a `data/*.json` file prunes its stale HTML/PDF on the next full build.

The PDFs are printed with headless Chrome. If Chrome is not in the default macOS location, point the build at it:

```bash
CHROME_PATH="/path/to/chrome" npm run build
```

## Project structure

```
data/<profile>.json         # the CV content, one file per profile (source of truth)
data/<profile>.cover-letter.md  # optional cover letter, Markdown
templates/cv.html           # designed HTML skeleton with {{tokens}}
templates/cv-ats.html       # ATS HTML skeleton with {{tokens}}
templates/cover-letter.html # cover letter skeleton (header + rendered Markdown)
styles/cv.css               # designed layout, typography and print rules
styles/cv-ats.css           # ATS layout and print rules
styles/cover-letter.css     # letter body: 12pt, full-width measure, Markdown elements
scripts/build.mjs           # JSON profiles → HTMLs → PDFs
scripts/lib/profiles.mjs    # profile discovery, output paths, build manifest
scripts/lib/validate.mjs    # shared data validation
scripts/lib/markdown.mjs    # small Markdown renderer (no dependencies)
scripts/extract_docx.py     # helper: raw text extraction from the source DOCX
server.mjs                  # local editor server
editor/                     # editor UI (HTML/CSS/JS)
assets/wakako-obata.jpg     # photo extracted from the DOCX
documents/                  # original DOCX/PDF (git-ignored)
```

## Editing the CV

- **Content** – use `npm run editor` for the form editor, or edit a `data/<profile>.json` directly and run `npm run build`. Saving in the editor writes that JSON and rebuilds it automatically. To add a profile, copy an existing JSON file in `data/` under a new name and adjust it (the file name is the profile id and the output prefix).
- **Cover letter** – the editor's **Cover letter** card is a plain Markdown textarea backed by `data/<profile>.cover-letter.md`. The file is optional: no file (or an empty one) means no letter and no cover-letter PDF. Markdown support is deliberately small — paragraphs (blank line between them), `**bold**`, `*italic*`, `` `code` ``, `[links](https://…)`, `-`/`1.` lists, `#` headings, `>` quotes, `---` rules and fenced code. A single newline is a soft wrap; end a line with two spaces or `\` for a hard break. Raw HTML is escaped, and links are limited to `http(s)`, `mailto:`, `tel:` and relative targets.
- **Look and feel** – edit `styles/cv.css` (designed), `styles/cv-ats.css` (ATS) or `styles/cover-letter.css` (letter body; it layers on top of `cv.css`). Screen preview and print share the same stylesheets; print rules are at the bottom of each file. Use the **Rebuild** button in the preview bar (or `POST /api/rebuild`) to pick up CSS changes without saving form changes.
- **Markup** – edit `templates/cv.html`, `templates/cv-ats.html` or `templates/cover-letter.html`. The `{{...}}` tokens are filled by `scripts/build.mjs`.

The build validates required fields and fails on unknown template tokens, so a typo in the template does not silently produce an empty section.

### JSON shape

```json
{
  "meta":       { "language": "de", "title": "…" },
  "basics":     { "name": "…", "tagline": "…", "photo": "assets/…", "birth": "…", "address": "…", "phone": "…", "email": "…" },
  "labels":     { "summary": "Profil", "experience": "Beruflicher Werdegang", "extras": "Weitere Kenntnisse", "…": "…" },
  "summary":    ["paragraph", "paragraph"],
  "experience": [{ "title": "…", "company": "…", "location": "…", "period": "…", "highlights": ["…"] }],
  "education":  [{ "title": "…", "institution": "…", "location": "…", "period": "…", "highlights": ["…"] }],
  "volunteer":  [{ "title": "…", "organization": "…", "period": "…", "highlights": ["…"] }],
  "skills":     { "technical": ["…"], "personal": ["…"], "tools": ["…"] },
  "languages":  [{ "name": "Deutsch", "level": 4, "maxLevel": 5, "levelLabel": "verhandlungssicher" }],
  "hobbies":    ["…"],
  "closing":    { "place": "Freiburg im Breisgau", "date": "12.10.2026" }
}
```

`hobbies` is used by the designed variant only; the ATS variant omits that section. The cover letter is not part of this JSON: it is a separate Markdown file, `data/<id>.cover-letter.md`, so letter text never has to be escaped inside JSON.

## How the two pages are kept

The designed variant, `templates/cv.html`, contains two explicit `.page` articles. `styles/cv.css` gives each one an A4 width and a 296 mm minimum height, and the print block sets `@page { size: A4; margin: 0 }`. This makes Chrome emit exactly two pages instead of reflowing into a third.

The ATS variant, `templates/cv-ats.html`, is a single flowing column. Chrome paginates it naturally; it currently fits two pages. The build warns if either variant is not exactly two pages.

The cover letter, `templates/cover-letter.html`, is a single explicit `.page` built from the same `cv.css` page rules, so it prints as exactly one A4 page; the build expects one page and warns otherwise. Its body uses the full 182 mm text column at 12 pt (the clear-print minimum), which works out to roughly 85 characters per line, and it shares the header's left and right edges. A narrower `ch`/`em` cap was rejected: it left a wide empty right margin that no longer lined up with the header rule.

Page 1 holds the profile and full work history. Page 2 holds education, volunteer work, skills, and the extras block: languages, EDV and — designed variant only — hobbies.

## ATS notes

- Single-column, text-only layout with no photo, tables, columns, icons or decorative dots.
- Standard German section headings come from the JSON labels.
- Language proficiency is real text (`Deutsch (verhandlungssicher)`, `Englisch (gute Kenntnisse)`, `Japanisch (Muttersprache)`), not a rating graphic.
- Skills, competencies, languages and tools are inline text lists, so PDF extraction keeps every item in order.
- Hobbies are omitted from the ATS variant.
- Hyphenation and ligatures are disabled, so the PDF text layer stays clean (`Kundenbetreuung`, `Pflege`).

## Extraction notes

`data/wakako-obata.json` was transcribed from `documents/Lebenslauf_Wakako Obata 2026 2.docx` and checked against the PDF. The DOCX stores its content in full-page text boxes, so the paragraphs were extracted from the text-box XML rather than from the document body. Obvious line-break/typo artifacts were normalised (`System anforderungen` → `Systemanforderungen`, `Sozial-Media` → `Social-Media`).

To re-extract the raw paragraphs after replacing the DOCX:

```bash
python3 scripts/extract_docx.py "documents/Lebenslauf_Wakako Obata 2026 2.docx" > /tmp/cv-source.txt
```

The JSON is then curated from that text and the layout is rebuilt.
