// Воркер MapLibre v6 — окремий ES-модуль, який збирач Next не підхоплює (він шукає його
// поряд із власним чанком). Копіюємо в public/ і задаємо шлях через setWorkerUrl
// (src/components/stay-map.tsx). Запускається перед dev і build — копія в git не потрібна.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve("maplibre-gl/package.json"));
const target = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "maplibre");
mkdirSync(target, { recursive: true });
copyFileSync(join(dist, "dist", "maplibre-gl-worker.mjs"), join(target, "maplibre-gl-worker.mjs"));
