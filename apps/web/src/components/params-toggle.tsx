"use client";

import { useState } from "react";

/**
 * Збережені параметри для нового пошуку: додаються прихованими полями, поки позначку не
 * знято. Зняти — змінити лише цей пошук; збережене в профілі чи браузері лишається.
 */
export function ParamsToggle({
  entries,
  label,
  testId,
}: {
  entries: [string, string][];
  label: string;
  testId?: string;
}) {
  const [use, setUse] = useState(true);
  if (entries.length === 0) return null;
  return (
    <label
      className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs"
      data-testid={testId}
    >
      <input
        type="checkbox"
        checked={use}
        onChange={(e) => setUse(e.target.checked)}
        className="accent-primary size-4"
      />
      {label}
      {use &&
        entries.map(([key, value]) => (
          <input key={`${key}=${value}`} type="hidden" name={key} value={value} />
        ))}
    </label>
  );
}
