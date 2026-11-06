"use client";

import { Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useSyncExternalStore } from "react";

import { applyTheme, savedTheme, saveTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/** Поточна тема — це клас `dark` на <html>; стежимо за ним, а не дублюємо в стані. */
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

function currentTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function ThemeToggle({ className }: { className?: string }) {
  const t = useTranslations("nav");
  // null на сервері: тему знає лише браузер (скрипт у <head> уже її застосував).
  const theme = useSyncExternalStore<Theme | null>(subscribe, currentTheme, () => null);

  // Поки користувач не обирав сам — слідуємо за темою системи і її змінами.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => {
      if (!savedTheme()) applyTheme(media.matches ? "dark" : "light");
    };
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, []);

  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => {
        applyTheme(next);
        saveTheme(next);
      }}
      disabled={theme === null}
      aria-label={t(next === "dark" ? "themeDark" : "themeLight")}
      title={t(next === "dark" ? "themeDark" : "themeLight")}
      className={cn(
        "text-muted-foreground hover:text-primary hover:bg-accent relative grid size-9 place-items-center rounded-lg border bg-card transition-colors disabled:opacity-0",
        className,
      )}
    >
      <Sun
        className="size-4 scale-100 rotate-0 transition-transform duration-300 dark:scale-0 dark:-rotate-90"
        aria-hidden
      />
      <Moon
        className="absolute size-4 scale-0 rotate-90 transition-transform duration-300 dark:scale-100 dark:rotate-0"
        aria-hidden
      />
    </button>
  );
}
