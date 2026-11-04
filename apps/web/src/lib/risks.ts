import type { Layover } from "@tickets/shared";

export type LayoverRisk = "short" | "long" | "overnight" | "selfTransfer";

// Пороги — ті самі, що в ТЗ і промпті Flight-Deal-Advisor: < 60 хв або > 8 год.
export const SHORT_LAYOVER_MIN = 60;
export const LONG_LAYOVER_MIN = 8 * 60;

/** Факти про пересадку для підписів у UI. Скоринг (етап 2) рахується на бекенді. */
export function layoverRisks(layover: Layover): LayoverRisk[] {
  const risks: LayoverRisk[] = [];
  if (layover.duration_min < SHORT_LAYOVER_MIN) risks.push("short");
  if (layover.duration_min > LONG_LAYOVER_MIN) risks.push("long");
  if (layover.overnight) risks.push("overnight");
  if (layover.self_transfer) risks.push("selfTransfer");
  return risks;
}
