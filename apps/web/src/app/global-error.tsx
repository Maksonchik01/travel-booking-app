"use client";

import NextError from "next/error";
import { useEffect } from "react";

import { reportError } from "@/lib/sentry-client";

/** Падіння кореневого layout: звітуємо в Sentry і показуємо стандартну сторінку помилки. */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    reportError(error);
  }, [error]);

  return (
    <html lang="uk">
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
