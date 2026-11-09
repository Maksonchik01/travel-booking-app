import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Без `globals: true` RTL не реєструє автоочищення DOM між тестами.
afterEach(cleanup);

// Аналітика (модуль 19) у тестах не ходить у мережу: sendBeacon «приймає» подію. Тести самої
// аналітики підміняють navigator окремо.
Object.defineProperty(navigator, "sendBeacon", { value: () => true, configurable: true });
