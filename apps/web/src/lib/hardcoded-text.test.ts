import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Модуль 18.1: увесь текст інтерфейсу — у messages/{en,uk,ru}.json. Українських чи російських
 * рядків у коді (поза коментарями) немає; єдиний виняток — самоназви мов (i18n/config.ts).
 */
const ROOT = join(__dirname, "..");
const ALLOWED = new Set([join(ROOT, "i18n", "config.ts")]);
const CYRILLIC = /[А-Яа-яЇїІіЄєҐґЁёЪъЫыЭэ]/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Код без коментарів: рядкових, блокових і JSX `{/* … *\/}`. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("тексти інтерфейсу — лише в перекладах", () => {
  it.each(sources(ROOT).map((p) => [p.slice(ROOT.length + 1)]))("%s", (relative) => {
    const path = join(ROOT, relative);
    if (ALLOWED.has(path)) return;
    const lines = withoutComments(readFileSync(path, "utf8"))
      .split("\n")
      .filter((line) => CYRILLIC.test(line));
    expect(lines).toEqual([]);
  });
});
