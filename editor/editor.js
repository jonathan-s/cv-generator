"use strict";

/* ==========================================================================
   CV editor – reads/writes the same JSON the build uses.
   ========================================================================== */

const DEFAULT_LABELS = {
  summary: "Profil",
  experience: "Beruflicher Werdegang",
  education: "Studium und Weiterbildung",
  volunteer: "Aktivitäten für Verkehrswende",
  skills: "Kernkompetenz",
  extras: "Weitere Kenntnisse",
  languages: "Sprachen",
  tools: "EDV",
  pagePrefix: "Seite",
};

const LABEL_FIELDS = [
  ["summary", "Profile"],
  ["experience", "Work experience"],
  ["education", "Education"],
  ["volunteer", "Volunteer work"],
  ["skills", "Technical skills"],
  ["extras", "Further skills"],
  ["languages", "Languages"],
  ["tools", "Software / tools"],
  [
    "pagePrefix",
    "Running banner label",
    "The banner on every page but the first prints this label, then the page counters. Only the word belongs here — numbers are generated.",
  ],
];

const ENTRY_SECTIONS = [
  {
    key: "experience",
    title: "Work experience",
    singular: "role",
    description: "Roles, companies, dates and bullet points.",
    orgKey: "company",
    orgLabel: "Company",
  },
  {
    key: "education",
    title: "Education",
    singular: "entry",
    description: "Degrees, certificates and further training.",
    orgKey: "institution",
    orgLabel: "Institution",
  },
  {
    key: "volunteer",
    title: "Volunteer work",
    singular: "entry",
    description: "Unpaid roles and community involvement.",
    orgKey: "organization",
    orgLabel: "Organization",
  },
];

const VARIANT_LABELS = {
  designed: "Designed",
  ats: "ATS",
  coverLetter: "Cover letter",
};

const PROFILE_STORAGE_KEY = "cv-editor.profile";

const state = {
  data: null,
  coverLetter: "",
  dirty: false,
  saving: false,
  revision: 0,
  variant: "designed",
  variants: null,
  /** id of the selected data profile (= JSON file name without extension) */
  profile: null,
  profiles: [],
};

/** Preview URLs for the selected profile's build outputs. */
function variantFiles() {
  const id = state.profile;

  return {
    designed: {
      html: `/preview/${id}.html`,
      pdf: `/preview/${id}.pdf`,
      label: VARIANT_LABELS.designed,
    },
    ats: {
      html: `/preview/${id}-ats.html`,
      pdf: `/preview/${id}-ats.pdf`,
      label: VARIANT_LABELS.ats,
    },
    coverLetter: {
      html: `/preview/${id}-cover-letter.html`,
      pdf: `/preview/${id}-cover-letter.pdf`,
      label: VARIANT_LABELS.coverLetter,
    },
  };
}

let photoThumb = null;

const dom = {
  form: document.getElementById("form"),
  status: document.getElementById("status"),
  save: document.getElementById("save"),
  reload: document.getElementById("reload"),
  rebuild: document.getElementById("rebuild"),
  refresh: document.getElementById("refresh"),
  preview: document.getElementById("preview"),
  previewMeta: document.getElementById("preview-meta"),
  pdfLink: document.getElementById("pdf-link"),
  variantDesigned: document.getElementById("variant-designed"),
  variantAts: document.getElementById("variant-ats"),
  variantCover: document.getElementById("variant-cover"),
  jumpNav: document.getElementById("jump-nav"),
  profileSelect: document.getElementById("profile"),
  brandMark: document.getElementById("brand-mark"),
  brandName: document.getElementById("brand-name"),
  dataPath: document.getElementById("data-path"),
};

/* -------------------------------------------------------------------------- */
/* tiny DOM helpers                                                           */
/* -------------------------------------------------------------------------- */

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;

    if (key === "class") {
      node.className = value;
    } else if (key === "text") {
      node.textContent = value;
    } else if (key === "disabled") {
      node.disabled = Boolean(value);
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(key, value);
    }
  }

  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(node, child);
    } else {
      node.append(
        child instanceof Node ? child : document.createTextNode(String(child)),
      );
    }
  }
}

function textInput(value, onInput, placeholder = "") {
  const input = h("input", { class: "input", type: "text", placeholder });
  input.value = value ?? "";
  input.addEventListener("input", () => {
    onInput(input.value);
    markDirty();
  });
  return input;
}

function textArea(value, onInput, rows, placeholder = "") {
  const area = h("textarea", {
    class: "input",
    rows: String(rows),
    placeholder,
  });
  area.value = value ?? "";
  area.addEventListener("input", () => {
    onInput(area.value);
    markDirty();
  });
  return area;
}

function numberInput(value, onInput, min = 0, max = 10) {
  const input = h("input", {
    class: "input",
    type: "number",
    min: String(min),
    max: String(max),
    step: "1",
  });
  input.value = value == null ? "" : String(value);
  input.addEventListener("input", () => {
    onInput(input.value === "" ? null : Number(input.value));
    markDirty();
  });
  return input;
}

function readOnlyInput(value) {
  const input = h("input", {
    class: "input input--readonly",
    type: "text",
  });
  input.value = value ?? "";
  input.readOnly = true;
  return input;
}

function field(label, control, hint = "") {
  return h(
    "label",
    { class: "field" },
    h("span", { class: "field__label" }, label),
    control,
    hint ? h("span", { class: "field__hint" }, hint) : null,
  );
}

function full(node) {
  node.classList.add("field--full");
  return node;
}

function grid(...children) {
  return h("div", { class: "field-grid" }, ...children);
}

function button(label, onClick, props = {}) {
  return h("button", { ...props, type: "button", onClick }, label);
}

function iconButton(label, title, onClick, disabled = false, extraClass = "") {
  return h(
    "button",
    {
      class: `icon ${extraClass}`.trim(),
      type: "button",
      title,
      disabled,
      onClick,
    },
    label,
  );
}

function card(id, title, description, children) {
  return h(
    "section",
    {
      class: "card",
      id: `section-${id}`,
      "data-title": title,
    },
    h(
      "div",
      { class: "card__head" },
      h("h2", { class: "card__title" }, title),
      description ? h("p", { class: "card__desc" }, description) : null,
    ),
    h("div", { class: "card__body" }, children),
  );
}

function subcard(title, child) {
  return h(
    "div",
    { class: "subcard" },
    h("h3", { class: "subcard__title" }, title),
    child,
  );
}

/* -------------------------------------------------------------------------- */
/* data normalization                                                        */
/* -------------------------------------------------------------------------- */

function normalizeData(input) {
  const data =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};

  data.meta = data.meta && typeof data.meta === "object" ? data.meta : {};
  data.basics =
    data.basics && typeof data.basics === "object" ? data.basics : {};
  data.labels = {
    ...DEFAULT_LABELS,
    ...(data.labels && typeof data.labels === "object" ? data.labels : {}),
  };

  data.summary = Array.isArray(data.summary) ? data.summary : [];

  for (const section of ENTRY_SECTIONS) {
    data[section.key] = Array.isArray(data[section.key])
      ? data[section.key].filter(
          (entry) => entry && typeof entry === "object",
        )
      : [];

    for (const entry of data[section.key]) {
      entry.highlights = Array.isArray(entry.highlights)
        ? entry.highlights
        : [];
    }
  }

  data.skills =
    data.skills && typeof data.skills === "object" ? data.skills : {};
  for (const key of ["technical", "tools"]) {
    data.skills[key] = Array.isArray(data.skills[key])
      ? data.skills[key]
      : [];
  }

  data.languages = Array.isArray(data.languages) ? data.languages : [];
  for (const language of data.languages) {
    if (!language || typeof language !== "object") continue;
    if (!Number.isFinite(language.level)) language.level = 0;
    if (!Number.isFinite(language.maxLevel)) language.maxLevel = 5;
    if (typeof language.levelLabel !== "string") language.levelLabel = "";
  }

  data.closing =
    data.closing && typeof data.closing === "object" ? data.closing : {};

  return data;
}

/* -------------------------------------------------------------------------- */
/* render                                                                    */
/* -------------------------------------------------------------------------- */

function render() {
  if (!state.data) return;
  const data = state.data;

  dom.form.replaceChildren(
    renderMeta(data),
    renderBasics(data),
    renderCoverLetter(),
    renderLabels(data),
    renderSummary(data),
    ...ENTRY_SECTIONS.map((section) => renderEntrySection(section, data)),
    renderSkills(data),
    renderLanguages(data),
    renderClosing(data),
  );

  renderJumpNav();
  updateSaveButton();
}

function renderMeta(data) {
  return card("meta", "Document", "Metadata used for the HTML title and language.", [
    grid(
      field(
        "Language",
        textInput(data.meta.language ?? "", (value) => {
          data.meta.language = value;
        }),
        "e.g. de",
      ),
      field(
        "Title",
        textInput(data.meta.title ?? "", (value) => {
          data.meta.title = value;
        }),
      ),
      field(
        "Last updated",
        textInput(data.meta.updated ?? "", (value) => {
          data.meta.updated = value;
        }),
        "Free text, e.g. 2026-10-12.",
      ),
      field(
        "Source",
        readOnlyInput(data.meta.source ?? ""),
        "Original DOCX/PDF used for the extraction.",
      ),
    ),
  ]);
}

function renderBasics(data) {
  const photo = h("img", { class: "photo-thumb", alt: "" });
  photoThumb = photo;

  photo.addEventListener("error", () =>
    photo.classList.add("photo-thumb--missing"),
  );
  photo.addEventListener("load", () =>
    photo.classList.remove("photo-thumb--missing"),
  );
  updatePhotoPreview();

  return card(
    "basics",
    "Basics",
    "Name, tagline and contact details shown in the header.",
    [
      grid(
        field(
          "Name",
          textInput(data.basics.name ?? "", (value) => {
            data.basics.name = value;
          }),
        ),
        field(
          "Tagline",
          textInput(data.basics.tagline ?? "", (value) => {
            data.basics.tagline = value;
          }),
        ),
        full(
          field(
            "Photo path",
            textInput(
              data.basics.photo ?? "",
              (value) => {
                data.basics.photo = value;
                updatePhotoPreview();
              },
              "assets/photo.jpg",
            ),
            "Relative to the project root. Saving copies the photo into dist/.",
          ),
        ),
        full(
          h(
            "div",
            { class: "photo-row" },
            photo,
            h(
              "div",
              { class: "field__hint" },
              "Thumbnail from the generated preview. Replace the image file, update the path, then save.",
            ),
          ),
        ),
        field(
          "Birth",
          textInput(data.basics.birth ?? "", (value) => {
            data.basics.birth = value;
          }),
        ),
        field(
          "Address",
          textInput(data.basics.address ?? "", (value) => {
            data.basics.address = value;
          }),
        ),
        field(
          "Phone",
          textInput(data.basics.phone ?? "", (value) => {
            data.basics.phone = value;
          }),
        ),
        field(
          "Email",
          textInput(data.basics.email ?? "", (value) => {
            data.basics.email = value;
          }),
        ),
      ),
    ],
  );
}

function updatePhotoPreview() {
  if (!photoThumb || !state.data) return;

  const path = state.data.basics.photo;
  photoThumb.classList.remove("photo-thumb--missing");

  if (!path) {
    photoThumb.removeAttribute("src");
    photoThumb.classList.add("photo-thumb--missing");
    return;
  }

  photoThumb.src = `/preview/${encodeURI(path)}?v=${Date.now()}`;
}

function renderCoverLetter() {
  return card(
    "coverLetter",
    "Cover letter",
    "Saved as Markdown next to the CV data and rendered as its own A4 page. It reuses the CV header, without the photo.",
    [
      field(
        `Markdown — data/${state.profile}.cover-letter.md`,
        textArea(
          state.coverLetter,
          (value) => {
            state.coverLetter = value;
          },
          26,
          "Sehr geehrte Damen und Herren,\n\n…",
        ),
        "Paragraphs, **bold**, *italic*, `code`, [links](https://…), - lists, ## headings, > quotes. An empty letter removes the file and its PDF.",
      ),
    ],
  );
}

function renderLabels(data) {
  return card(
    "labels",
    "Section headings",
    "Rendered as uppercase headings in the CV. The running banner label is the exception: it sits beside the page numbers.",
    [
      grid(
        ...LABEL_FIELDS.map(([key, label, hint]) =>
          field(
            label,
            textInput(data.labels[key] ?? "", (value) => {
              data.labels[key] = value;
            }),
            hint,
          ),
        ),
      ),
    ],
  );
}

function renderSummary(data) {
  return card(
    "summary",
    "Profile",
    "Each item is a paragraph in the profile section.",
    [
      listEditor(data.summary, {
        rows: 3,
        addLabel: "Add paragraph",
        placeholder: "Profile paragraph…",
      }),
    ],
  );
}

function renderEntrySection(section, data) {
  const entries = data[section.key];
  const body = entries.map((entry, index) =>
    entryCard(entry, index, entries, section),
  );

  body.push(
    button(
      `Add ${section.singular}`,
      () => {
        entries.push(newEntry(section.orgKey));
        markDirty();
        render();
      },
      { class: "btn btn--small" },
    ),
  );

  return card(section.key, section.title, section.description, body);
}

function newEntry(orgKey) {
  return {
    title: "",
    [orgKey]: "",
    location: "",
    period: "",
    highlights: [],
  };
}

function entryCard(entry, index, entries, section) {
  const fields = grid(
    field(
      "Title",
      textInput(entry.title ?? "", (value) => {
        entry.title = value;
      }),
    ),
    field(
      section.orgLabel,
      textInput(entry[section.orgKey] ?? "", (value) => {
        entry[section.orgKey] = value;
      }),
    ),
    field(
      "Location",
      textInput(entry.location ?? "", (value) => {
        entry.location = value;
      }),
    ),
    field(
      "Period",
      textInput(entry.period ?? "", (value) => {
        entry.period = value;
      }),
      "e.g. 07/2021 bis heute",
    ),
  );

  return h(
    "div",
    { class: "entry-card" },
    h(
      "div",
      { class: "entry-card__head" },
      h(
        "span",
        { class: "entry-card__index" },
        `${section.title} ${index + 1}`,
      ),
      h(
        "div",
        { class: "entry-card__actions" },
        iconButton(
          "↑",
          "Move up",
          () => moveItem(entries, index, -1),
          index === 0,
        ),
        iconButton(
          "↓",
          "Move down",
          () => moveItem(entries, index, 1),
          index === entries.length - 1,
        ),
        iconButton(
          "×",
          "Remove",
          () => {
            entries.splice(index, 1);
            markDirty();
            render();
          },
          false,
          "icon--danger",
        ),
      ),
    ),
    fields,
    h(
      "div",
      { class: "subfield" },
      h("span", { class: "subfield__label" }, "Highlights / bullets"),
      listEditor(entry.highlights, {
        rows: 2,
        addLabel: "Add bullet",
        placeholder: "One bullet per line",
      }),
    ),
  );
}

function renderSkills(data) {
  return card(
    "skills",
    "Skills",
    "Three lists used for the skills, competencies and software sections.",
    [
      subcard(
        "Technical skills",
        listEditor(data.skills.technical, {
          addLabel: "Add skill",
          placeholder: "Skill",
        }),
      ),
      subcard(
        "Software / tools",
        listEditor(data.skills.tools, {
          addLabel: "Add tool",
          placeholder: "Tool",
        }),
      ),
    ],
  );
}

function renderLanguages(data) {
  const rows = data.languages.map((language, index) =>
    h(
      "div",
      { class: "lang-row" },
      textInput(
        language.name ?? "",
        (value) => {
          language.name = value;
        },
        "Language",
      ),
      numberInput(
        language.level,
        (value) => {
          language.level = value ?? 0;
        },
        0,
        10,
      ),
      numberInput(
        language.maxLevel,
        (value) => {
          language.maxLevel = value ?? 5;
        },
        1,
        10,
      ),
      textInput(
        language.levelLabel ?? "",
        (value) => {
          language.levelLabel = value;
        },
        "e.g. verhandlungssicher",
      ),
      iconButton(
        "×",
        "Remove language",
        () => {
          data.languages.splice(index, 1);
          markDirty();
          render();
        },
        false,
        "icon--danger",
      ),
    ),
  );

  return card(
    "languages",
    "Languages",
    "Level labels are shown as text in the ATS variant and in the Weitere Kenntnisse block.",
    [
      h(
        "div",
        {},
        h(
          "div",
          { class: "lang-head" },
          h("span", {}, "Language"),
          h("span", {}, "Level"),
          h("span", {}, "Max"),
          h("span", {}, "Level label"),
          h("span", {}),
        ),
        ...rows,
        button(
          "Add language",
          () => {
            data.languages.push({ name: "", level: 3, maxLevel: 5, levelLabel: "" });
            markDirty();
            render();
          },
          { class: "btn btn--small list-add" },
        ),
      ),
    ],
  );
}

function renderClosing(data) {
  return card(
    "closing",
    "Closing",
    "Place and date shown at the end of page 2.",
    [
      grid(
        field(
          "Place",
          textInput(data.closing.place ?? "", (value) => {
            data.closing.place = value;
          }),
        ),
        field(
          "Date",
          textInput(data.closing.date ?? "", (value) => {
            data.closing.date = value;
          }),
        ),
      ),
    ],
  );
}

function listEditor(
  items,
  { rows = 0, addLabel = "Add item", placeholder = "" } = {},
) {
  const list = h("div", { class: "list" });

  items.forEach((item, index) => {
    const control =
      rows > 0
        ? textArea(
            item,
            (value) => {
              items[index] = value;
            },
            rows,
            placeholder,
          )
        : textInput(
            item,
            (value) => {
              items[index] = value;
            },
            placeholder,
          );

    const actions = h(
      "div",
      { class: "list-row__actions" },
      iconButton(
        "↑",
        "Move up",
        () => moveItem(items, index, -1),
        index === 0,
      ),
      iconButton(
        "↓",
        "Move down",
        () => moveItem(items, index, 1),
        index === items.length - 1,
      ),
      iconButton(
        "×",
        "Remove",
        () => {
          items.splice(index, 1);
          markDirty();
          render();
        },
        false,
        "icon--danger",
      ),
    );

    list.append(
      h(
        "div",
        { class: `list-row${rows > 0 ? "" : " list-row--single"}` },
        control,
        actions,
      ),
    );
  });

  list.append(
    button(
      addLabel,
      () => {
        items.push("");
        markDirty();
        render();
      },
      { class: "btn btn--small list-add" },
    ),
  );

  return list;
}

function moveItem(items, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= items.length) return;

  [items[index], items[target]] = [items[target], items[index]];
  markDirty();
  render();
}

function renderJumpNav() {
  const cards = Array.from(dom.form.querySelectorAll(".card[data-title]"));

  dom.jumpNav.replaceChildren(
    ...cards.map((item) =>
      h(
        "a",
        { class: "jump-link", href: `#${item.id}` },
        item.dataset.title,
      ),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* state / status                                                            */
/* -------------------------------------------------------------------------- */

function markDirty() {
  state.dirty = true;
  state.revision += 1;
  setStatus("Unsaved changes", "warn");
  updateSaveButton();
}

function updateSaveButton() {
  dom.save.disabled = state.saving;
  dom.save.textContent = state.saving ? "Saving…" : "Save & rebuild";
  dom.reload.disabled = state.saving;
  dom.rebuild.disabled = state.saving;
  dom.profileSelect.disabled = state.saving || state.profiles.length === 0;
}

function setStatus(message, kind = "") {
  dom.status.textContent = message;
  dom.status.className = `status${kind ? ` status--${kind}` : ""}`;
}

/* -------------------------------------------------------------------------- */
/* load / save / preview                                                     */
/* -------------------------------------------------------------------------- */

function profileLabel(profile) {
  if (!profile) return "";
  return profile.name && profile.name !== profile.id
    ? `${profile.name} (${profile.id})`
    : profile.id;
}

function initials(name) {
  return (
    String(name)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join("") || "CV"
  );
}

function applyProfileChrome() {
  const profile = state.profiles.find((item) => item.id === state.profile);
  const name =
    state.data?.basics?.name?.trim() ||
    profile?.name ||
    state.profile ||
    "CV editor";

  dom.brandName.textContent = name;
  dom.brandMark.textContent = initials(name);
  dom.dataPath.textContent =
    profile?.file ??
    (state.profile ? `data/${state.profile}.json` : "data/*.json");
  document.title = `CV editor – ${name}`;
}

function renderProfileSelect() {
  const options = state.profiles.map((profile) =>
    h("option", { value: profile.id }, profileLabel(profile)),
  );

  dom.profileSelect.replaceChildren(
    ...(options.length
      ? options
      : [h("option", { value: "" }, "No profiles in data/")]),
  );
  dom.profileSelect.value = state.profile ?? "";
  dom.profileSelect.disabled = state.saving || options.length === 0;
}

function persistProfile() {
  if (!state.profile) return;

  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, state.profile);
  } catch {
    /* storage may be unavailable; the URL still carries the selection */
  }

  const url = new URL(window.location.href);
  url.searchParams.set("profile", state.profile);
  window.history.replaceState(null, "", url);
}

async function loadProfiles() {
  const response = await fetch("/api/profiles", { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      payload.error || `Could not load the profile list (${response.status}).`,
    );
  }

  state.profiles = Array.isArray(payload.profiles) ? payload.profiles : [];

  let stored = null;
  try {
    stored =
      new URLSearchParams(window.location.search).get("profile") ||
      localStorage.getItem(PROFILE_STORAGE_KEY);
  } catch {
    stored = null;
  }

  const known = state.profiles.some((profile) => profile.id === stored);
  state.profile = known
    ? stored
    : (payload.default ?? state.profiles[0]?.id ?? null);

  renderProfileSelect();
  persistProfile();
}

async function switchProfile(id) {
  if (!id || id === state.profile) {
    renderProfileSelect();
    return;
  }

  if (
    state.saving ||
    (state.dirty &&
      !window.confirm("Switch profile and discard unsaved changes?"))
  ) {
    renderProfileSelect();
    return;
  }

  state.profile = id;
  state.data = null;
  state.dirty = false;
  state.revision = 0;
  state.variants = null;

  persistProfile();
  renderProfileSelect();
  await load();
}

async function load() {
  if (!state.profile) {
    state.data = null;
    dom.form.replaceChildren(
      h("p", { class: "loading" }, "No data profiles found in data/."),
    );
    applyProfileChrome();
    setStatus("No data profile found. Add a JSON file to data/.", "error");
    return;
  }

  setStatus("Loading…", "busy");

  try {
    const query = `?profile=${encodeURIComponent(state.profile)}`;
    const [cvResponse, buildResponse, letterResponse] = await Promise.all([
      fetch(`/api/cv${query}`, { cache: "no-store" }),
      fetch(`/api/build${query}`, { cache: "no-store" }),
      fetch(`/api/cover-letter${query}`, { cache: "no-store" }),
    ]);
    const payload = await cvResponse.json().catch(() => ({}));
    const build = await buildResponse.json().catch(() => ({ variants: {} }));
    const letter = await letterResponse.json().catch(() => ({}));

    if (!cvResponse.ok) {
      throw new Error(
        payload.error || `Could not load the CV data (${cvResponse.status}).`,
      );
    }

    state.data = normalizeData(payload);
    state.coverLetter =
      typeof letter.markdown === "string" ? letter.markdown : "";
    state.variants = build.variants ?? {};
    state.dirty = false;
    state.revision = 0;
    render();
    setVariant(state.variant);
    applyProfileChrome();
    setStatus(`Loaded data/${state.profile}.json`, "ok");
  } catch (error) {
    state.data = null;
    dom.form.replaceChildren(h("p", { class: "loading" }, error.message));
    applyProfileChrome();
    setStatus(error.message, "error");
  }
}

async function save() {
  if (!state.data || state.saving) return;

  const revisionAtSave = state.revision;
  state.saving = true;
  updateSaveButton();
  setStatus("Saving JSON and Markdown, rebuilding PDFs…", "busy");

  try {
    const response = await fetch(
      `/api/document?profile=${encodeURIComponent(state.profile)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cv: state.data,
          coverLetter: state.coverLetter,
        }),
      },
    );

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const messages = payload.errors?.length
        ? payload.errors
        : [payload.error || `Save failed (${response.status}).`];
      const error = new Error(messages.join(" · "));
      error.payload = payload;
      throw error;
    }

    state.variants = payload.variants ?? state.variants;
    const newerEdits = state.revision !== revisionAtSave;
    state.dirty = newerEdits;
    updatePdfLink();
    refreshPreview();
    updatePreviewMeta(payload);
    updatePhotoPreview();

    const summary = Object.values(payload.variants ?? {})
      .map(
        (variant) =>
          `${variant.label ?? "Variant"}: ${variant.pageCount ?? "?"} ${
            variant.pageCount === 1 ? "page" : "pages"
          }`,
      )
      .join(" · ");

    if (newerEdits) {
      setStatus("Saved snapshot; newer edits are not in the PDF yet.", "warn");
    } else if (payload.warnings) {
      setStatus(
        `Saved${summary ? ` · ${summary}` : ""} · ${payload.warnings}`,
        "warn",
      );
    } else {
      setStatus(`Saved${summary ? ` · ${summary}` : ""}`, "ok");
    }
  } catch (error) {
    const saved = Boolean(error.payload?.saved);
    const detail =
      typeof error.payload?.details === "string"
        ? error.payload.details.split("\n")[0]
        : "";

    if (saved) {
      state.dirty = state.revision !== revisionAtSave;
      setStatus(
        `JSON saved, but rebuild failed: ${error.message}${detail ? ` — ${detail}` : ""}`,
        "error",
      );
    } else {
      state.dirty = true;
      setStatus(error.message, "error");
    }

    if (error.payload?.details) console.error(error.payload.details);
  } finally {
    state.saving = false;
    updateSaveButton();
  }
}

async function rebuild() {
  if (state.saving) return;

  if (
    state.dirty &&
    !window.confirm(
      "Rebuild from the saved JSON? Unsaved form changes will not be included.",
    )
  ) {
    return;
  }

  state.saving = true;
  updateSaveButton();
  setStatus("Rebuilding from saved JSON…", "busy");

  try {
    const response = await fetch(
      `/api/rebuild?profile=${encodeURIComponent(state.profile)}`,
      { method: "POST" },
    );
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const detail =
        typeof payload.details === "string"
          ? payload.details.split("\n")[0]
          : "";
      throw new Error(
        `${payload.error || `Rebuild failed (${response.status}).`}${detail ? ` — ${detail}` : ""}`,
      );
    }

    state.variants = payload.variants ?? state.variants;
    updatePdfLink();
    refreshPreview();
    updatePreviewMeta(payload);
    updatePhotoPreview();

    const summary = Object.values(payload.variants ?? {})
      .map(
        (variant) =>
          `${variant.label ?? "Variant"}: ${variant.pageCount ?? "?"} ${
            variant.pageCount === 1 ? "page" : "pages"
          }`,
      )
      .join(" · ");
    const suffix = state.dirty
      ? " · unsaved form changes are not included"
      : "";
    setStatus(
      `Rebuilt${summary ? ` · ${summary}` : ""}${suffix}`,
      state.dirty ? "warn" : "ok",
    );
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    state.saving = false;
    updateSaveButton();
  }
}

async function reload() {
  if (state.saving) return;
  if (
    state.dirty &&
    !window.confirm("Discard unsaved changes and reload from disk?")
  ) {
    return;
  }
  await load();
}

function refreshPreview() {
  const files = variantFiles();
  const file = files[state.variant];
  if (!file) return;

  if (!state.variants?.[state.variant]) {
    showEmptyPreview();
    return;
  }

  dom.preview.removeAttribute("srcdoc");
  dom.preview.src = `${file.html}?v=${Date.now()}`;
}

function showEmptyPreview() {
  const isLetter = state.variant === "coverLetter";
  const message = isLetter
    ? state.coverLetter.trim()
      ? "The cover letter has not been generated yet. Save to build the preview."
      : "No cover letter yet. Write one in the editor and save."
    : "This variant has not been built yet. Save or rebuild to generate it.";

  dom.preview.removeAttribute("src");
  dom.preview.srcdoc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  html, body { height: 100%; }
  body {
    display: grid;
    place-items: center;
    margin: 0;
    background: #fff;
    color: #6f6963;
    font: 14px/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif;
    text-align: center;
  }
  p { max-width: 36ch; margin: 0; }
</style>
</head>
<body><p>${message}</p></body>
</html>`;
}

function updatePdfLink() {
  const files = variantFiles()[state.variant];
  const built = Boolean(files && state.variants?.[state.variant]);

  if (!built) {
    dom.pdfLink.href = "#";
    dom.pdfLink.classList.add("is-disabled");
    dom.pdfLink.setAttribute("aria-disabled", "true");
    dom.pdfLink.setAttribute("tabindex", "-1");
    dom.pdfLink.title = "Not generated yet — save or rebuild first.";
    return;
  }

  dom.pdfLink.href = `${files.pdf}?v=${Date.now()}`;
  dom.pdfLink.classList.remove("is-disabled");
  dom.pdfLink.removeAttribute("aria-disabled");
  dom.pdfLink.removeAttribute("tabindex");
  dom.pdfLink.removeAttribute("title");
}

function variantToggles() {
  return {
    designed: dom.variantDesigned,
    ats: dom.variantAts,
    coverLetter: dom.variantCover,
  };
}

function setVariant(variant) {
  const files = variantFiles();
  if (!files[variant]) return;

  state.variant = variant;

  for (const [key, node] of Object.entries(variantToggles())) {
    const active = key === variant;
    node.classList.toggle("is-active", active);
    node.setAttribute("aria-pressed", String(active));
  }

  updatePdfLink();
  updatePreviewMeta();
  refreshPreview();
}

function updatePreviewMeta(payload = null) {
  const variants = payload?.variants ?? state.variants;
  const variant = variants?.[state.variant];

  if (!variant) {
    dom.previewMeta.textContent =
      state.variant === "coverLetter" ? "not built yet" : "";
    return;
  }

  const parts = [];
  if (variant.pageCount) parts.push(`${variant.pageCount} pages`);
  if (variant.sizeKb) parts.push(`${variant.sizeKb} KB`);
  dom.previewMeta.textContent = parts.join(" · ");
}

/* -------------------------------------------------------------------------- */
/* init                                                                      */
/* -------------------------------------------------------------------------- */

function init() {
  dom.save.addEventListener("click", save);
  dom.reload.addEventListener("click", reload);
  dom.rebuild.addEventListener("click", rebuild);
  dom.refresh.addEventListener("click", () => refreshPreview());
  dom.variantDesigned.addEventListener("click", () => setVariant("designed"));
  dom.variantAts.addEventListener("click", () => setVariant("ats"));
  dom.variantCover.addEventListener("click", () => setVariant("coverLetter"));
  dom.profileSelect.addEventListener("change", () =>
    switchProfile(dom.profileSelect.value),
  );

  dom.form.addEventListener("submit", (event) => {
    event.preventDefault();
  });

  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
    }
  });

  loadProfiles()
    .then(load)
    .catch((error) => {
      setStatus(error.message, "error");
      dom.form.replaceChildren(h("p", { class: "loading" }, error.message));
      dom.profileSelect.disabled = true;
    });
}

init();
