export type Theme = "light" | "dark";

/** Вибір користувача; немає запису — тема системи (prefers-color-scheme). */
export const THEME_STORAGE_KEY = "tickets.theme";

/**
 * Виконується в <head> до першого малювання (next/script beforeInteractive), щоб темна
 * тема не блимала світлою. Ставить клас `dark` на <html> — від нього залежать токени
 * в globals.css.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});var d=t?t==="dark":window.matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function savedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function saveTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // без сховища тема діє до перезавантаження
  }
}
