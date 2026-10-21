// Rule: one module owns the writes to each table (plan, "Stop duplication at the source").
// Fails when any other file writes to the tag tables or the people tables, so a new writer
// cannot bypass the deduplication and the unique keys those modules apply.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..", "src");

const OWNERS: Record<string, string[]> = {
  tags: ["content/tags.ts"],
  people: ["content/people.ts"],
};
// One-time storage steps and schema setup may touch any table.
const ALWAYS_ALLOWED = ["db/storageMigrations.ts", "db/index.ts"];

const TAG_TABLES = "content_genres|content_countries|content_themes";
const PEOPLE_TABLES = "people|title_people";
const Q = String.raw`[\x60"]?`; // an optional backtick or double quote around a table name
const sqlWrite = (tables: string) =>
  new RegExp(
    String.raw`(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+${Q}(?:${tables})\b` +
      String.raw`|UPDATE\s+(?:OR\s+\w+\s+)?${Q}(?:${tables})\b` +
      String.raw`|DELETE\s+FROM\s+${Q}(?:${tables})\b`,
    "i",
  );
const RULES = [
  { owner: "tags", pattern: sqlWrite(TAG_TABLES) },
  { owner: "tags", pattern: /\b(?:ContentGenre|ContentCountry|ContentTheme)\.(?:create|bulkCreate|destroy|update|upsert)\b/ },
  { owner: "people", pattern: sqlWrite(PEOPLE_TABLES) },
];

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}

test("the write patterns catch the forms used in this code", () => {
  const caught = (s: string) => RULES.some(({ pattern }) => pattern.test(s));
  for (const s of [
    "DELETE FROM title_people WHERE titleKey = ?",
    "INSERT OR IGNORE INTO title_people (titleKey) VALUES (?)",
    "INSERT INTO people (tmdbPersonId, name, photo) VALUES (?, ?, ?)",
    "UPDATE people SET biography = ?",
    "UPDATE `content_genres` SET isRepresentative = 1",
    "await ContentGenre.destroy({ where: { contentId } })",
    "await ContentTheme.bulkCreate(rows)",
  ]) assert.ok(caught(s), s);
  for (const s of ["SELECT id FROM people WHERE name = ?", "ContentGenre.findAll({ where })", "CREATE INDEX idx_people_name ON people (name)"]) {
    assert.ok(!caught(s), s);
  }
});

test("only the owning module writes the tag and people tables", () => {
  const offenders: string[] = [];
  for (const file of files(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    if (ALWAYS_ALLOWED.includes(rel)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const { owner, pattern } of RULES) {
      if (OWNERS[owner].includes(rel)) continue;
      const m = text.match(pattern);
      if (m) offenders.push(`${rel}: "${m[0]}" (owner: ${OWNERS[owner].join(", ")})`);
    }
  }
  assert.deepEqual(offenders, []);
});
