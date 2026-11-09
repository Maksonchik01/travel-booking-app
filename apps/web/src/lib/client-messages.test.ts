import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

import { describe, expect, it } from "vitest";

import messages from "../../messages/uk.json";
import { CLIENT_NAMESPACES, clientMessages } from "./client-messages";

const SRC = join(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function resolve(spec: string, from: string): string | null {
  const base = spec.startsWith("@/")
    ? join(SRC, spec.slice(2))
    : spec.startsWith(".")
      ? normalize(join(dirname(from), spec))
      : null;
  if (!base) return null;
  return (
    [`${base}.tsx`, `${base}.ts`, join(base, "index.ts"), join(base, "index.tsx")].find(
      existsSync,
    ) ?? null
  );
}

/** Усе, що виконується в браузері: "use client" і транзитивно все, що воно імпортує. */
function clientCode(): string[] {
  const all = sources(SRC);
  const stack = all.filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
  const seen = new Set<string>();
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const [, spec] of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      const next = resolve(spec!, file);
      if (next) stack.push(next);
    }
  }
  return [...seen];
}

describe("переклади для браузера", () => {
  it("містять кожен розділ, який читає клієнтський код", () => {
    const used = new Set<string>();
    for (const file of clientCode()) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file}: useTranslations() без розділу`).not.toMatch(
        /useTranslations\(\s*\)/,
      );
      for (const [, ns] of source.matchAll(
        /(?:useTranslations|getTranslations)\(\s*["']([\w.]+)["']/g,
      )) {
        used.add(ns!.split(".")[0]!);
      }
    }
    const missing = [...used].filter(
      (ns) => !(CLIENT_NAMESPACES as readonly string[]).includes(ns),
    );
    expect(missing).toEqual([]);
  });

  it("усі розділи списку існують, а юридичних текстів у браузері немає", () => {
    const picked = clientMessages(messages);
    expect(Object.keys(picked).sort()).toEqual([...CLIENT_NAMESPACES].sort());
    expect(picked).not.toHaveProperty("legal");
    expect(JSON.stringify(picked).length).toBeLessThan(JSON.stringify(messages).length * 0.7);
  });
});
