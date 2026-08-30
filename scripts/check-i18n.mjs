#!/usr/bin/env node
/**
 * Localisation guard (US-062).
 *
 * Fails the build on any of:
 *
 *   1. A key in `en` with no translation in `ar`.
 *   2. A key in `ar` that no longer exists in `en`.
 *   3. A key in `en` that nothing references.
 *   4. A user-visible string sitting in a template instead of the catalogue.
 *
 * (1) is also a type error, because `ar.ts` is declared as `Messages`. It is
 * repeated here so the failure is a readable list of key names rather than a
 * wall of TypeScript, and so the check still holds if someone widens that type.
 *
 * (4) is the one no type system can catch: a string that was never given a name
 * is invisible to the compiler. It is a heuristic — it strips tags, bindings,
 * interpolations, comments and control-flow blocks, then treats whatever text
 * survives as suspect. `ALLOWED_LITERALS` below is the escape hatch, and every
 * entry in it should have a reason.
 *
 * Run: node scripts/check-i18n.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORTAL_SRC = join(ROOT, "apps/portal/src");
const I18N_DIR = join(PORTAL_SRC, "app/core/i18n/messages");

/**
 * Strings allowed to sit in a template untranslated.
 *
 * Only two things belong here: text that is identical in every language
 * (product names, technical identifiers), and punctuation the layout needs.
 * "We will translate it later" is not a reason — that is what this check exists
 * to prevent.
 */
const ALLOWED_LITERALS = new Set([
  "Grow Path", // Product name. Not translated, and transliterating it would make it unsearchable.
  "Acme Corporation", // Example value in a placeholder, and a proper noun either way.
  "acme", // Example slug. Slugs are lowercase Latin by schema rule.
  "you@company.com", // Example address.
  // Example address on the create-operator form. Distinct from the one above
  // because that field is filled in for somebody else, and "you@" would be
  // wrong there. `example.com` is the RFC 2606 reserved domain, so it cannot
  // ever be a real address somebody mistakes for a suggestion.
  "operator@example.com",
  "admin@{slug}.local", // Derived address shown verbatim.
  "404", // Digits only.
  "→", // Separator between actor and target in the audit feed.
  "·", // Separator.
  "…", // Ellipsis on its own.
  "%", // Unit suffix on a delta.
  "*" // Required-field marker.
]);

/** Attributes whose literal values reach a user. */
const TRANSLATABLE_ATTRIBUTES = ["placeholder", "aria-label", "title", "alt"];

const failures = [];
const fail = (rule, detail) => failures.push({ rule, detail });

// ── Catalogues ──────────────────────────────────────────────────────────────

const enKeys = keysOf(join(I18N_DIR, "en.ts"));
const arKeys = keysOf(join(I18N_DIR, "ar.ts"));

if (enKeys.size === 0) {
  fail("catalogue", "No keys parsed from en.ts — has the file format changed?");
}

for (const key of enKeys) {
  if (!arKeys.has(key)) fail("missing-translation", `ar is missing "${key}"`);
}

for (const key of arKeys) {
  if (!enKeys.has(key)) fail("orphaned-translation", `ar defines "${key}", en does not`);
}

// ── Usage ───────────────────────────────────────────────────────────────────

const sources = collectSources(join(PORTAL_SRC, "app")).filter(
  (file) => !file.startsWith(I18N_DIR)
);
const allSource = sources.map((file) => readFileSync(file, "utf8")).join("\n");

for (const key of enKeys) {
  // Every key is referenced as a literal — the codebase builds no key by
  // interpolation, which is what makes this check exact rather than a guess.
  if (!allSource.includes(`"${key}"`) && !allSource.includes(`'${key}'`)) {
    fail("unused-key", `"${key}" is defined but never used`);
  }
}

// ── Bare literals in templates ──────────────────────────────────────────────

for (const file of sources) {
  const source = readFileSync(file, "utf8");
  const where = relative(ROOT, file).replace(/\\/g, "/");

  for (const template of templatesIn(source)) {
    for (const literal of attributeLiterals(template)) {
      if (!isAllowed(literal)) {
        fail("untranslated-attribute", `${where}: ${literal}`);
      }
    }

    for (const literal of textLiterals(template)) {
      if (!isAllowed(literal)) {
        fail("untranslated-text", `${where}: ${literal}`);
      }
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

if (failures.length === 0) {
  console.log(
    `i18n: ${enKeys.size} keys, ${sources.length} source files — en and ar agree, no untranslated strings.`
  );
  process.exit(0);
}

const byRule = new Map();
for (const { rule, detail } of failures) {
  if (!byRule.has(rule)) byRule.set(rule, []);
  byRule.get(rule).push(detail);
}

console.error(`i18n check failed with ${failures.length} problem(s):\n`);
for (const [rule, details] of byRule) {
  console.error(`  ${rule} (${details.length})`);
  for (const detail of details) console.error(`    - ${detail}`);
  console.error("");
}
console.error(
  "Every user-visible string belongs in apps/portal/src/app/core/i18n/messages/en.ts,\n" +
    "with its Arabic translation in ar.ts. See US-062."
);
process.exit(1);

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Catalogue keys, read as `"some.key":` at the start of an entry. */
function keysOf(file) {
  const source = readFileSync(file, "utf8");
  const keys = new Set();
  for (const match of source.matchAll(/^\s*"([\w.-]+)":/gm)) keys.add(match[1]);
  return keys;
}

function collectSources(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...collectSources(path));
    else if (entry.endsWith(".ts")) found.push(path);
  }
  return found;
}

/**
 * Inline templates.
 *
 * Non-greedy to the next backtick, which is exact here because a template
 * literal cannot contain an unescaped backtick — and a stray one in a comment
 * inside a template is itself a compile error, so this cannot silently truncate.
 */
function templatesIn(source) {
  return [...source.matchAll(/template:\s*`([\s\S]*?)`/g)].map((match) => match[1]);
}

function attributeLiterals(template) {
  const found = [];
  for (const attribute of TRANSLATABLE_ATTRIBUTES) {
    // `\b<attr>="` deliberately does not match `[attr]="expr"` or
    // `[attr.title]="expr"` — those are bindings, and their value is code.
    const pattern = new RegExp(`\\b${attribute}="([^"]+)"`, "g");
    for (const match of template.matchAll(pattern)) found.push(match[1].trim());
  }
  return found.filter(hasWords);
}

/**
 * Removes tags, respecting quoted attribute values.
 *
 * A regex cannot do this. `<[^>]*>` ends the tag at the first `>`, which in
 * `[name]="count >= 0 ? 'a' : 'b'"` is the one inside the binding — leaving the
 * rest of the expression behind as "text" and reporting it as untranslated.
 */
function stripTags(input) {
  let output = "";
  let index = 0;

  while (index < input.length) {
    if (input[index] !== "<") {
      output += input[index++];
      continue;
    }

    index++; // past '<'
    let quote = null;
    while (index < input.length) {
      const character = input[index];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        index++;
        break;
      }
      index++;
    }
    output += " ";
  }

  return output;
}

/** Text that survives once every non-text construct is removed. */
function textLiterals(template) {
  const withoutComments = template
    .replace(/<!--[\s\S]*?-->/g, " ") // comments
    .replace(/\{\{[\s\S]*?\}\}/g, " "); // interpolations

  const stripped = stripTags(withoutComments)
    .replace(/@(?:if|else if|else|for|switch|case|default|empty|let)\b[^{]*\{/g, " ")
    .replace(/[{}]/g, " "); // stray block braces

  return stripped
    .split("\n")
    .map((line) => line.trim())
    .filter(hasWords);
}

/** Two or more letters in a row, i.e. something a person would read. */
function hasWords(value) {
  return /[A-Za-z؀-ۿ]{2,}/.test(value);
}

function isAllowed(literal) {
  const trimmed = literal.trim();
  if (!trimmed || ALLOWED_LITERALS.has(trimmed)) return true;
  // A run of separators and example tokens, e.g. "· …".
  return trimmed
    .split(/\s+/)
    .every((word) => ALLOWED_LITERALS.has(word) || !hasWords(word));
}
