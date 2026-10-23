// Спільні типи API. Згенеровані з OpenAPI-схеми FastAPI (`npm run gen:types`),
// тому вручну тут нічого не пишемо: джерело істини — Pydantic-моделі в apps/api.
import type { components } from "./api.gen";

export type { components, operations, paths } from "./api.gen";

type Schemas = components["schemas"];

export type HealthResponse = Schemas["HealthResponse"];
export type ReadinessResponse = Schemas["ReadinessResponse"];
