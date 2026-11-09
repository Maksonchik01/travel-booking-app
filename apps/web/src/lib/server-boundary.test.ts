import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Модуль 17.4: ключі й серверні операції не потрапляють у браузер. Клієнтські компоненти
 * не імпортують модулі, що читають секрети чи cookie (INTERNAL_API_KEY, токен сесії), а
 * змінні середовища в клієнтському коді — лише публічні NEXT_PUBLIC_*.
 */
const SERVER_ONLY = ["@/lib/session", "@/lib/client-ip", "@/lib/api"];
const ROOT = join(__dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const clientFiles = files(ROOT).filter((path) =>
  /^\s*["']use client["']/.test(readFileSync(path, "utf8")),
);

describe("межа сервер / браузер", () => {
  it("клієнтські компоненти існують (тест щось перевіряє)", () => {
    expect(clientFiles.length).toBeGreaterThan(10);
  });

  it.each(clientFiles.map((p) => [p.slice(ROOT.length + 1)]))(
    "%s не імпортує серверних модулів і секретів",
    (relative) => {
      const source = readFileSync(join(ROOT, relative), "utf8");
      for (const name of SERVER_ONLY) {
        expect(source, name).not.toMatch(new RegExp(`from ["']${name}["']`));
      }
      const env = [...source.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
      expect(env.filter((name) => !name!.startsWith("NEXT_PUBLIC_"))).toEqual([]);
    },
  );
});
