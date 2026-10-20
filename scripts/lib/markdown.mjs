/**
 * Small, dependency-free Markdown renderer for the cover letter.
 *
 * Supported:
 *   paragraphs, hard line breaks (two trailing spaces or "\")
 *   **bold**, *italic*, `code`, [links](https://…)
 *   - unordered lists, 1. ordered lists
 *   # headings (rendered one level lower, so "#" -> <h2>)
 *   > block quotes, --- horizontal rules, ``` fenced code blocks
 *
 * Everything else is escaped. Raw HTML in the source is shown as text, never
 * interpreted, and links are limited to http(s), mailto, tel and relative
 * targets so a pasted "javascript:" URL cannot end up in the PDF.
 */

const ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (value = "") =>
  String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);

const SLOT = "\u0000";

const FENCE = /^```/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^>\s?/;
const UNORDERED = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;

const startsBlock = (line) =>
  FENCE.test(line) ||
  RULE.test(line) ||
  HEADING.test(line) ||
  QUOTE.test(line) ||
  UNORDERED.test(line) ||
  ORDERED.test(line);

/** Keeps links to safe schemes and paths; anything else is left as text. */
function safeHref(href) {
  if (/^(?:https?:|mailto:|tel:)/i.test(href)) return href;
  if (/^[./#]/.test(href)) return href;
  return null;
}

function renderInline(text) {
  const slots = [];
  const stash = (html) => {
    slots.push(html);
    return `${SLOT}${slots.length - 1}${SLOT}`;
  };

  let output = escapeHtml(text);

  output = output.replace(/`([^`]+)`/g, (_, code) =>
    stash(`<code>${code}</code>`),
  );

  output = output.replace(
    /\[([^\]]+)\]\(([^()\s]+)\)/g,
    (match, label, href) => {
      const safe = safeHref(href);
      return safe ? stash(`<a href="${safe}">${label}</a>`) : match;
    },
  );

  output = output.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, (_, _marker, inner) =>
    stash(`<strong>${inner}</strong>`),
  );

  output = output.replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, (_, _marker, inner) =>
    stash(`<em>${inner}</em>`),
  );

  return output.replace(
    new RegExp(`${SLOT}(\\d+)${SLOT}`, "g"),
    (_, index) => slots[Number(index)],
  );
}

/** Joins the lines of one paragraph, honouring explicit hard breaks. */
function renderParagraph(lines) {
  const parts = [];

  lines.forEach((raw, index) => {
    if (index > 0) {
      const previousHard = /(?:\s{2,}|\\)$/.test(lines[index - 1]);
      parts.push(previousHard ? "<br>" : " ");
    }

    parts.push(renderInline(raw.trim().replace(/\\$/, "")));
  });

  return `<p>${parts.join("")}</p>`;
}

function renderBlocks(lines) {
  const html = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    /* fenced code ------------------------------------------------------- */
    if (FENCE.test(line)) {
      const body = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; /* closing fence, or EOF */
      html.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    /* horizontal rule --------------------------------------------------- */
    if (RULE.test(line)) {
      html.push("<hr>");
      index += 1;
      continue;
    }

    /* heading ----------------------------------------------------------- */
    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6);
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    /* block quote ------------------------------------------------------- */
    if (QUOTE.test(line)) {
      const body = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        body.push(lines[index].replace(QUOTE, ""));
        index += 1;
      }
      html.push(`<blockquote>${renderBlocks(body)}</blockquote>`);
      continue;
    }

    /* lists ------------------------------------------------------------- */
    const unordered = UNORDERED.exec(line);
    const ordered = ORDERED.exec(line);

    if (unordered || ordered) {
      const pattern = ordered ? ORDERED : UNORDERED;
      const items = [];

      while (index < lines.length) {
        const item = pattern.exec(lines[index]);

        if (item) {
          items.push(item[1].trim());
          index += 1;
          continue;
        }

        /* indented continuation of the previous item */
        if (items.length && /^\s{2,}\S/.test(lines[index])) {
          items[items.length - 1] += ` ${lines[index].trim()}`;
          index += 1;
          continue;
        }

        break;
      }

      const tag = ordered ? "ol" : "ul";
      const body = items
        .map((item) => `<li>${renderInline(item)}</li>`)
        .join("\n");
      html.push(`<${tag}>\n${body}\n</${tag}>`);
      continue;
    }

    /* paragraph --------------------------------------------------------- */
    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !startsBlock(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }

    if (paragraph.length) {
      html.push(renderParagraph(paragraph));
      continue;
    }

    /* Defensive: never loop forever on an unhandled block start. */
    html.push(renderParagraph([lines[index]]));
    index += 1;
  }

  return html.join("\n");
}

export function renderMarkdown(markdown) {
  const lines = String(markdown ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .split("\n");

  return renderBlocks(lines);
}
