import Image from "next/image";

import { cn } from "@/lib/utils";

export type AvatarUser = {
  username: string;
  first_name?: string | null;
  last_name?: string | null;
  google_picture?: string | null;
  avatar_version?: number | null;
};

/** Ініціали: ім'я + прізвище, інакше перша літера логіна. */
export function initials(user: AvatarUser): string {
  const letters = [user.first_name, user.last_name]
    .map((part) => part?.trim().slice(0, 1) ?? "")
    .join("");
  return (letters || user.username.slice(0, 1)).toUpperCase();
}

/**
 * Фото профілю (модуль 10b): власне → з Google → ініціали. Власне віддає `/api/account/avatar`
 * лише власнику (сесія), тож без оптимізатора; фото Google — через оптимізатор next/image.
 */
export function UserAvatar({
  user,
  size,
  className,
}: {
  user: AvatarUser;
  size: number;
  className?: string;
}) {
  const box = cn("shrink-0 overflow-hidden", className);
  if (user.avatar_version) {
    return (
      <Image
        src={`/api/account/avatar?v=${user.avatar_version}`}
        alt=""
        width={size}
        height={size}
        unoptimized
        className={cn(box, "object-cover")}
        data-testid="user-avatar"
      />
    );
  }
  if (user.google_picture) {
    return (
      <Image
        src={user.google_picture}
        alt=""
        width={size}
        height={size}
        className={cn(box, "object-cover")}
        data-testid="user-avatar"
      />
    );
  }
  return (
    <span
      className={cn(
        box,
        "from-primary grid place-items-center bg-gradient-to-br to-sky-500 font-bold text-white",
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      aria-hidden
      data-testid="user-avatar"
    >
      {initials(user)}
    </span>
  );
}
