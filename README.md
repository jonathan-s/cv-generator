# Wakako Obata – CV

A small pipeline with no npm dependencies that turns one JSON file into two A4 CV variants: a designed two-page CV and a plain single-column ATS version. Both are generated from the same data.

The designed layout follows the **Madelin Parker two-page A4** reference: a circular photo, large name, tagline, contact rows, thin section rules, bold uppercase section headings, single-column body copy, compact multi-column lists for skills, and a repeated name on page 2. The ATS variant deliberately drops the photo, columns, decorative dots and hobbies, using plain text and standard German headings instead.

## Editor

Start the local editor:

```bash
npm run editor
```

Open **http://127.0.0.1:8080**. The page loads `data/wakako-obata.json` into fields. **Save & rebuild** writes the JSON atomically, regenerates both HTMLs and both PDFs, and refreshes the preview. Use the **Designed / ATS** toggle in the preview bar; **Open PDF** follows the selected variant.

The server binds to `127.0.0.1` by default. Use `PORT=8081 npm run editor` to pick another port. It has no npm dependencies and uses the same validation module as the build (`scripts/lib/validate.mjs`), so invalid data is rejected before the JSON file is touched.

Useful endpoints:

```text
GET  /api/cv       current JSON
GET  /api/build    current build manifest (page counts/sizes)
PUT  /api/cv       validate + write JSON + rebuild both variants
POST /api/rebuild  rebuild both variants without writing JSON
```

## Build

Requirements: Node 18+, Google Chrome/Chromium for the PDF, and optionally Ghostscript for the page-count check.

```bash
npm run build
```

Outputs:

```
dist/
├── wakako-obata.html       # designed HTML
├── wakako-obata.pdf        # designed, exactly 2 A4 pages
├── wakako-obata-ats.html   # ATS HTML
├── wakako-obata-ats.pdf    # ATS, 2 A4 pages
├── cv.css                  # designed styles
├── cv-ats.css              # ATS styles
├── build.json              # manifest with page counts and sizes
└── assets/
    └── wakako-obata.jpg
```

`dist/` is generated and git-ignored. Remove the `dist/` line from `.gitignore` if you want to commit the built PDF.

Skip the PDFs and only build both HTML files:

```bash
npm run build:html
```

The PDFs are printed with headless Chrome. If Chrome is not in the default macOS location, point the build at it:

```bash
CHROME_PATH="/path/to/chrome" npm run build
```

## Project structure

```
data/wakako-obata.json      # the CV content (single source of truth)
templates/cv.html           # designed HTML skeleton with {{tokens}}
templates/cv-ats.html       # ATS HTML skeleton with {{tokens}}
styles/cv.css               # designed layout, typography and print rules
styles/cv-ats.css           # ATS layout and print rules
scripts/build.mjs           # JSON → two HTMLs → two PDFs
scripts/lib/validate.mjs    # shared data validation
scripts/extract_docx.py     # helper: raw text extraction from the source DOCX
server.mjs                  # local editor server
editor/                     # editor UI (HTML/CSS/JS)
assets/wakako-obata.jpg     # photo extracted from the DOCX
documents/                  # original DOCX/PDF (git-ignored)
```

## Editing the CV

- **Content** – use `npm run editor` for the form editor, or edit `data/wakako-obata.json` directly and run `npm run build`. Saving in the editor writes the JSON and rebuilds automatically.
- **Look and feel** – edit `styles/cv.css` (designed) or `styles/cv-ats.css` (ATS). Screen preview and print share the same stylesheets; print rules are at the bottom of each file. Use the **Rebuild** button in the preview bar (or `POST /api/rebuild`) to pick up CSS changes without saving form changes.
- **Markup** – edit `templates/cv.html` or `templates/cv-ats.html`. The `{{...}}` tokens are filled by `scripts/build.mjs`.

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

`hobbies` is used by the designed variant only; the ATS variant omits that section.

## How the two pages are kept

The designed variant, `templates/cv.html`, contains two explicit `.page` articles. `styles/cv.css` gives each one an A4 width and a 296 mm minimum height, and the print block sets `@page { size: A4; margin: 0 }`. This makes Chrome emit exactly two pages instead of reflowing into a third.

The ATS variant, `templates/cv-ats.html`, is a single flowing column. Chrome paginates it naturally; it currently fits two pages. The build warns if either variant is not exactly two pages.

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
