# Wakako Obata – CV

A small pipeline with no npm dependencies that turns one JSON file into an HTML CV and a two-page A4 PDF.

The visual layout follows the **Madelin Parker two-page A4** reference: a circular photo, large name, tagline, contact rows, thin section rules, bold uppercase section headings, single-column body copy, compact multi-column lists for skills/extras, and a repeated name on page 2.

## Build

Requirements: Node 18+, Google Chrome/Chromium for the PDF, and optionally Ghostscript for the page-count check.

```bash
npm run build
```

Outputs:

```
dist/
├── wakako-obata.html   # standalone HTML (links ./cv.css)
├── wakako-obata.pdf    # exactly 2 A4 pages
├── cv.css              # copy of styles/cv.css
└── assets/
    └── wakako-obata.jpg
```

`dist/` is generated and git-ignored. Remove the `dist/` line from `.gitignore` if you want to commit the built PDF.

Skip the PDF and only build the HTML:

```bash
npm run build:html
```

The PDF is printed with headless Chrome. If Chrome is not in the default macOS location, point the build at it:

```bash
CHROME_PATH="/path/to/chrome" npm run build
```

## Project structure

```
data/wakako-obata.json    # the CV content (single source of truth)
templates/cv.html         # HTML skeleton with {{tokens}}
styles/cv.css             # all layout, typography and @media print rules
scripts/build.mjs         # JSON → HTML → PDF
scripts/extract_docx.py   # helper: raw text extraction from the source DOCX
assets/wakako-obata.jpg   # photo extracted from the DOCX
documents/                # original DOCX/PDF (git-ignored)
```

## Editing the CV

- **Content** – edit `data/wakako-obata.json`, then run `npm run build`.
- **Look and feel** – edit `styles/cv.css`. Screen preview and print share the same stylesheet; print rules are at the bottom of the file.
- **Markup** – edit `templates/cv.html`. The `{{...}}` tokens are filled by `scripts/build.mjs`.

The build validates required fields and fails on unknown template tokens, so a typo in the template does not silently produce an empty section.

### JSON shape

```json
{
  "meta":       { "language": "de", "title": "…" },
  "basics":     { "name": "…", "tagline": "…", "photo": "assets/…", "birth": "…", "address": "…", "phone": "…", "email": "…" },
  "labels":     { "summary": "Profil", "experience": "Beruflicher Werdegang", "…": "…" },
  "summary":    ["paragraph", "paragraph"],
  "experience": [{ "title": "…", "company": "…", "location": "…", "period": "…", "highlights": ["…"] }],
  "education":  [{ "title": "…", "institution": "…", "location": "…", "period": "…", "highlights": ["…"] }],
  "volunteer":  [{ "title": "…", "organization": "…", "period": "…", "highlights": ["…"] }],
  "skills":     { "technical": ["…"], "personal": ["…"], "tools": ["…"] },
  "languages":  [{ "name": "Deutsch", "level": 4, "maxLevel": 5 }],
  "hobbies":    ["…"],
  "closing":    { "place": "Freiburg im Breisgau", "date": "12.10.2026" }
}
```

## How the two pages are kept

`templates/cv.html` contains two explicit `.page` articles. `styles/cv.css` gives each one an A4 width and a 296 mm minimum height, and the print block sets `@page { size: A4; margin: 0 }`. This makes Chrome emit exactly two pages instead of reflowing into a third.

Page 1 holds the profile and full work history. Page 2 holds education, volunteer work, skills, languages, tools and hobbies. If you add substantially more content, either tighten the spacing at the bottom of `styles/cv.css` or split a section across the pages.

## Extraction notes

`data/wakako-obata.json` was transcribed from `documents/Lebenslauf_Wakako Obata 2026 2.docx` and checked against the PDF. The DOCX stores its content in full-page text boxes, so the paragraphs were extracted from the text-box XML rather than from the document body. Obvious line-break/typo artifacts were normalised (`System anforderungen` → `Systemanforderungen`, `Sozial-Media` → `Social-Media`).

To re-extract the raw paragraphs after replacing the DOCX:

```bash
python3 scripts/extract_docx.py "documents/Lebenslauf_Wakako Obata 2026 2.docx" > /tmp/cv-source.txt
```

The JSON is then curated from that text and the layout is rebuilt.
