import { LogIn } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { UserAvatar } from "@/components/user-avatar";
import { currentUser } from "@/lib/session";

/** Гість — «Увійти»; користувач — фото (чи ініціали) і ім'я, перехід у кабінет. */
export async function UserMenu() {
  const [user, t] = await Promise.all([currentUser(), getTranslations("nav")]);
  if (!user) {
    return (
      <Link
        href="/login"
        aria-label={t("signIn")}
        className="bg-primary text-primary-foreground hover:bg-primary/90 flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium shadow-sm transition-colors"
      >
        <LogIn className="size-4" aria-hidden />
        <span className="hidden sm:inline">{t("signIn")}</span>
      </Link>
    );
  }
  const name = user.first_name || user.username;
  return (
    <Link
      href="/account"
      aria-label={t("account")}
      className="hover:bg-accent flex h-9 items-center gap-2 rounded-lg border px-1.5 text-sm font-medium transition-colors sm:pr-3"
    >
      <UserAvatar user={user} size={24} className="rounded-md" />
      <span className="hidden max-w-28 truncate sm:inline">{name}</span>
    </Link>
  );
}
