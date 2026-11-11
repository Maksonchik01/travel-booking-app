const BASE = "https://skypack.invalid";

/**
 * Шлях лише цього сайту для перенаправлення після входу (`next=`), інакше `fallback`.
 * Відсікає `//evil`, `/\evil` (браузер читає `\` як `/`), керівні символи й усе, що після
 * розбору веде на інший origin.
 */
export function safeLocalPath(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 2048) return fallback;
  if (/[\\\u0000-\u001f\u007f]/.test(value) || value.startsWith("//")) return fallback;
  try {
    const url = new URL(value, BASE);
    return url.origin === BASE ? `${url.pathname}${url.search}${url.hash}` : fallback;
  } catch {
    return fallback;
  }
}
