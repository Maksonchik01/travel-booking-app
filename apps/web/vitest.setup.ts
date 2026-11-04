import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Без `globals: true` RTL не реєструє автоочищення DOM між тестами.
afterEach(cleanup);
