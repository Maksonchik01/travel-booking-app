/**
 * Запит браузера до власних маршрутів `/api/*` з обмеженням часу (модуль 13.2): завантаження
 * ніколи не триває нескінченно — після тайм-ауту компонент показує помилку й «Спробувати ще».
 * Сервер має свої тайм-аути до API; цей — запас зверху.
 */
export const CLIENT_TIMEOUT_MS = 45_000;

export function fetchWithTimeout(
  input: string,
  init?: RequestInit,
  timeoutMs = CLIENT_TIMEOUT_MS,
): Promise<Response> {
  return fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
}
