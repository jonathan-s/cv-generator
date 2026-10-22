/**
 * Shared CV data validation, used by both the build and the editor server.
 * Keeping it in one place means the editor rejects exactly what the build
 * would reject.
 */

export const LABEL_KEYS = [
  "summary",
  "experience",
  "education",
  "volunteer",
  "skills",
  "competencies",
  "extras",
  "languages",
  "tools",
  "pagePrefix",
  "hobbies",
];

const isObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isString = (value) => typeof value === "string";

const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => isString(item));

const nonEmptyString = (value) => isString(value) && value.trim().length > 0;

export function validateCv(data) {
  const errors = [];

  if (!isObject(data)) {
    return ["The CV data must be a JSON object."];
  }

  /* meta ------------------------------------------------------------------ */
  if (!isObject(data.meta)) {
    errors.push("meta is required.");
  } else {
    if (!nonEmptyString(data.meta.language)) {
      errors.push("meta.language is required.");
    }
    if (!nonEmptyString(data.meta.title)) {
      errors.push("meta.title is required.");
    }
  }

  /* basics ---------------------------------------------------------------- */
  if (!isObject(data.basics)) {
    errors.push("basics is required.");
  } else {
    for (const key of ["name", "photo"]) {
      if (!nonEmptyString(data.basics[key])) {
        errors.push(`basics.${key} is required.`);
      }
    }
    for (const key of ["tagline", "birth", "address", "phone", "email"]) {
      if (data.basics[key] != null && !isString(data.basics[key])) {
        errors.push(`basics.${key} must be a string.`);
      }
    }
  }

  /* summary --------------------------------------------------------------- */
  if (!isStringArray(data.summary)) {
    errors.push("summary must be an array of strings.");
  }

  /* repeatable entry sections -------------------------------------------- */
  const organisationKeys = {
    experience: "company",
    education: "institution",
    volunteer: "organization",
  };

  for (const [section, organisationKey] of Object.entries(organisationKeys)) {
    if (!Array.isArray(data[section])) {
      errors.push(`${section} must be an array.`);
      continue;
    }

    data[section].forEach((entry, index) => {
      const at = `${section}[${index}]`;
      if (!isObject(entry)) {
        errors.push(`${at} must be an object.`);
        return;
      }
      if (!nonEmptyString(entry.title)) {
        errors.push(`${at}.title is required.`);
      }
      for (const key of [organisationKey, "location", "period"]) {
        if (entry[key] != null && !isString(entry[key])) {
          errors.push(`${at}.${key} must be a string.`);
        }
      }
      if (entry.highlights != null && !isStringArray(entry.highlights)) {
        errors.push(`${at}.highlights must be an array of strings.`);
      }
    });
  }

  /* skills ---------------------------------------------------------------- */
  if (!isObject(data.skills)) {
    errors.push("skills is required.");
  } else {
    for (const key of ["technical", "personal", "tools"]) {
      if (!isStringArray(data.skills[key])) {
        errors.push(`skills.${key} must be an array of strings.`);
      }
    }
  }

  /* languages ------------------------------------------------------------- */
  if (!Array.isArray(data.languages)) {
    errors.push("languages must be an array.");
  } else {
    data.languages.forEach((language, index) => {
      const at = `languages[${index}]`;
      if (!isObject(language)) {
        errors.push(`${at} must be an object.`);
        return;
      }
      if (!nonEmptyString(language.name)) {
        errors.push(`${at}.name is required.`);
      }
      if (!Number.isFinite(language.level) || language.level < 0) {
        errors.push(`${at}.level must be a non-negative number.`);
      }
      if (!Number.isFinite(language.maxLevel) || language.maxLevel < 1) {
        errors.push(`${at}.maxLevel must be a positive number.`);
      }
      if (language.levelLabel != null && !isString(language.levelLabel)) {
        errors.push(`${at}.levelLabel must be a string.`);
      }
    });
  }

  /* hobbies --------------------------------------------------------------- */
  if (!isStringArray(data.hobbies)) {
    errors.push("hobbies must be an array of strings.");
  }

  return errors;
}
