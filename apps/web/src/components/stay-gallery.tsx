"use client";

import { ChevronLeft, ChevronRight, ImageOff, Images, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

const PREVIEW = 5;

/**
 * Фото об'єкта (ADR 0044): велике перше й мініатюри; клік — перегляд на весь екран (`<dialog>`:
 * Escape, стрілки, гортання). Фото — лише від джерела; браузер вантажить їх з хоста джерела
 * без Referer (як і на картці житла). Немає — так і пишемо, стокових не підставляємо.
 */
export function StayGallery({ photos, name }: { photos: string[]; name: string }) {
  const t = useTranslations("stayHotel");
  const dialog = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(0);

  const open = (i: number) => {
    setIndex(i);
    dialog.current?.showModal();
  };
  const step = (delta: number) => setIndex((i) => (i + delta + photos.length) % photos.length);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const onKey = (event: KeyboardEvent) => {
      if (!node.open) return;
      if (event.key === "ArrowRight") setIndex((i) => (i + 1) % photos.length);
      if (event.key === "ArrowLeft") setIndex((i) => (i - 1 + photos.length) % photos.length);
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  }, [photos.length]);

  if (photos.length === 0) {
    return (
      <div
        className="bg-muted text-muted-foreground grid h-40 place-items-center rounded-xl text-sm"
        data-testid="stay-gallery-empty"
      >
        <span className="flex items-center gap-2">
          <ImageOff className="size-4" aria-hidden />
          {t("noPhotos")}
        </span>
      </div>
    );
  }

  const preview = photos.slice(0, PREVIEW);
  const rest = photos.length - preview.length;
  return (
    <div data-testid="stay-gallery">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:grid-rows-2">
        {preview.map((url, i) => (
          <button
            key={url}
            type="button"
            onClick={() => open(i)}
            className={cn(
              "group bg-muted relative overflow-hidden rounded-xl",
              i === 0
                ? "col-span-2 aspect-[16/10] sm:row-span-2 sm:aspect-auto"
                : "aspect-[4/3] sm:aspect-auto",
              i === 0 && "sm:min-h-72",
            )}
            aria-label={t("photoOf", { index: i + 1, total: photos.length })}
            data-testid="stay-photo-thumb"
          >
            {/* Хост фото — від джерела; next/image не потрібен: браузер вантажить без Referer. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt=""
              loading={i === 0 ? "eager" : "lazy"}
              decoding="async"
              referrerPolicy="no-referrer"
              className="absolute inset-0 size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            />
            {i === preview.length - 1 && rest > 0 && (
              <span className="absolute inset-0 grid place-items-center bg-black/45 text-sm font-semibold text-white">
                <span className="flex items-center gap-1.5">
                  <Images className="size-4" aria-hidden />
                  {t("morePhotos", { count: rest })}
                </span>
              </span>
            )}
          </button>
        ))}
      </div>

      <dialog
        ref={dialog}
        aria-label={t("galleryTitle", { name })}
        className="m-auto size-full max-h-none max-w-none bg-black/95 p-0 text-white backdrop:bg-black/80"
        data-testid="stay-lightbox"
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        <div className="grid size-full grid-rows-[auto_1fr_auto]">
          <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <span className="truncate font-medium">{name}</span>
            <span className="flex items-center gap-3">
              <span className="tabular-nums" aria-live="polite">
                {t("counter", { index: index + 1, total: photos.length })}
              </span>
              <button
                type="button"
                onClick={() => dialog.current?.close()}
                aria-label={t("close")}
                className="grid size-9 place-items-center rounded-full hover:bg-white/10"
                autoFocus
              >
                <X className="size-5" aria-hidden />
              </button>
            </span>
          </div>
          <div className="relative grid min-h-0 place-items-center px-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photos[index]}
              alt={t("photoOf", { index: index + 1, total: photos.length })}
              referrerPolicy="no-referrer"
              className="max-h-full max-w-full object-contain"
            />
            {photos.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => step(-1)}
                  aria-label={t("previous")}
                  className="absolute top-1/2 left-2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/50 hover:bg-black/70"
                >
                  <ChevronLeft className="size-6" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => step(1)}
                  aria-label={t("next")}
                  className="absolute top-1/2 right-2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/50 hover:bg-black/70"
                  data-testid="stay-lightbox-next"
                >
                  <ChevronRight className="size-6" aria-hidden />
                </button>
              </>
            )}
          </div>
          <div className="flex gap-2 overflow-x-auto px-4 py-3">
            {photos.map((url, i) => (
              <button
                key={url}
                type="button"
                onClick={() => setIndex(i)}
                aria-label={t("photoOf", { index: i + 1, total: photos.length })}
                aria-current={i === index ? "true" : undefined}
                className={cn(
                  "h-14 w-20 shrink-0 overflow-hidden rounded-md opacity-60 ring-white transition hover:opacity-100",
                  i === index && "opacity-100 ring-2",
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="size-full object-cover"
                />
              </button>
            ))}
          </div>
        </div>
      </dialog>
    </div>
  );
}
