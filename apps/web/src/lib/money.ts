/**
 * Округлення грошей в інтерфейсі (модуль 18.2, ADR 0037): нічого не ховаємо. Ціла сума —
 * без копійок (88 €), дробова — з копійками (88,40 €): 88,40 не стане «88», а 39,60 зекономлених —
 * «40». Самі суми рахує API (Decimal, до центів, половина вгору) — тут лише показ.
 */
export function fractionDigits(value: number | string): {
  minimumFractionDigits: number;
  maximumFractionDigits: number;
} {
  const cents = Math.round(Number(value) * 100);
  const digits = cents % 100 === 0 ? 0 : 2;
  return { minimumFractionDigits: digits, maximumFractionDigits: digits };
}
