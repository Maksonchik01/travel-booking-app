"use client";

import type { Account } from "@tickets/shared";
import { ImageUp, Loader2, Plus, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState, useRef, useState, useTransition } from "react";

import type { FormState } from "@/app/actions/account";
import {
  removeAvatar,
  resetSearchPrefs,
  savePreferences,
  saveSearchPrefs,
  uploadAvatar,
} from "@/app/actions/profile";
import { FormError, Submit } from "@/components/auth-forms";
import { PlaceInput, type PlaceValue, placeValue } from "@/components/place-input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { UserAvatar } from "@/components/user-avatar";
import { LOCALE_NAMES, type Locale, locales } from "@/i18n/config";
import {
  BAGGAGE_NEEDS,
  CABINS,
  CURRENCIES,
  DEPARTURE_PERIODS,
  MAX_STOPS_OPTIONS,
  PROFILES,
} from "@/lib/search-params";
import {
  AMENITIES,
  MAX_DISTANCE_OPTIONS,
  MIN_RATING_OPTIONS,
  STAY_KINDS,
  STAY_PROFILES,
} from "@/lib/stay-params";
import { SELECT_CLASS } from "@/lib/styles";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

const IDLE: FormState = { status: "idle" };
const MAX_FAVORITE_AIRPORTS = 5;
const AVATAR_PX = 256;

function Saved({ state }: { state: FormState }) {
  const t = useTranslations("account");
  if (state.status !== "ok") return null;
  return (
    <p role="status" className="text-sm text-success">
      {t("saved")}
    </p>
  );
}

function Select({
  id,
  label,
  children,
  ...props
}: React.ComponentProps<"select"> & { id: string; label: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-muted-foreground text-xs font-medium">
        {label}
      </Label>
      <select id={id} className={SELECT_CLASS} {...props}>
        {children}
      </select>
    </div>
  );
}

function Checks<T extends string>({
  legend,
  name,
  options,
  checked,
  label,
}: {
  legend: string;
  name: string;
  options: readonly T[];
  checked: readonly T[] | undefined;
  label: (option: T) => string;
}) {
  return (
    <fieldset className="grid gap-1.5">
      <legend className="text-muted-foreground mb-1.5 text-xs font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <label
            key={option}
            className="has-[:checked]:border-primary has-[:checked]:bg-accent has-[:checked]:text-primary has-[:focus-visible]:ring-ring/50 flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors has-[:focus-visible]:ring-[3px]"
          >
            <input
              type="checkbox"
              name={name}
              value={option}
              defaultChecked={checked?.includes(option)}
              className="sr-only"
            />
            {label(option)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// --- фото профілю ---------------------------------------------------------------------

/** Квадрат 256×256 з центру фото (WebP, інакше JPEG) — щоб не надсилати мегабайти. */
async function shrink(file: File): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_PX;
    canvas.height = AVATAR_PX;
    canvas
      .getContext("2d")
      ?.drawImage(
        bitmap,
        (bitmap.width - side) / 2,
        (bitmap.height - side) / 2,
        side,
        side,
        0,
        0,
        AVATAR_PX,
        AVATAR_PX,
      );
    bitmap.close();
    const blob = (type: string) =>
      new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
    const webp = await blob("image/webp");
    return webp?.type === "image/webp" ? webp : await blob("image/jpeg");
  } catch {
    return null;
  }
}

/**
 * Фото профілю: за замовчуванням — з Google або ініціали; власне можна завантажити й
 * прибрати. З JS фото зменшується в браузері; без JS форма надсилає файл як є (до 300 КБ).
 */
export function AvatarForm({ account }: { account: Account }) {
  const t = useTranslations("account.profile");
  const hydrated = useHydrated();
  const [state, upload] = useActionState(uploadAvatar, IDLE);
  const [removed, remove] = useActionState(removeAvatar, IDLE);
  const [pending, startTransition] = useTransition();
  const [local, setLocal] = useState<FormState>(IDLE);
  const input = useRef<HTMLInputElement>(null);

  function pick(file: File | undefined) {
    if (!file) return;
    startTransition(async () => {
      const small = await shrink(file);
      if (!small) {
        setLocal({ status: "error", code: "invalid_image" });
        return;
      }
      setLocal(IDLE);
      const form = new FormData();
      form.set("avatar", new File([small], "avatar", { type: small.type }));
      upload(form);
    });
    if (input.current) input.current.value = "";
  }

  const error = local.status === "error" ? local : state.status === "error" ? state : removed;
  return (
    <div className="flex flex-wrap items-center gap-4">
      <UserAvatar user={account} size={72} className="rounded-2xl shadow-md" />
      <div className="grid gap-2">
        <div className="flex flex-wrap gap-2">
          <form action={upload} encType="multipart/form-data">
            <label
              className={cn(
                "border-input hover:bg-accent focus-within:ring-ring/50 flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm font-medium shadow-xs transition-colors focus-within:ring-[3px]",
                pending && "pointer-events-none opacity-60",
              )}
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <ImageUp className="size-4" aria-hidden />
              )}
              {t("upload")}
              <input
                ref={input}
                type="file"
                name="avatar"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                data-testid="avatar-input"
                onChange={hydrated ? (e) => pick(e.target.files?.[0]) : undefined}
              />
            </label>
            {/* Без JS вибір файлу нічого не надсилає — потрібна кнопка. */}
            {!hydrated && (
              <Button type="submit" variant="outline" size="sm" className="mt-2">
                {t("uploadSubmit")}
              </Button>
            )}
          </form>
          {account.avatar_version != null && (
            <form action={remove}>
              <Button type="submit" variant="ghost" size="sm" className="h-9">
                <Trash2 className="size-4" aria-hidden />
                {t("removePhoto")}
              </Button>
            </form>
          )}
        </div>
        <p className="text-muted-foreground text-xs">
          {account.avatar_version != null
            ? t("photoCustom")
            : account.google_picture
              ? t("photoGoogle")
              : t("photoInitials")}
        </p>
        <FormError state={error} />
      </div>
    </div>
  );
}

// --- мова, валюта, країна, аеропорти ---------------------------------------------------

export function PreferencesForm({
  account,
  countries,
  locale,
}: {
  account: Account;
  /** Код → назва мовою сторінки (рахує сервер — однаково для SSR і браузера). */
  countries: { code: string; name: string }[];
  locale: Locale;
}) {
  const t = useTranslations("account.profile");
  const tSearch = useTranslations("search");
  const [state, action] = useActionState(savePreferences, IDLE);
  const [home, setHome] = useState(() => placeValue(account.home_airport ?? undefined));
  const [favorites, setFavorites] = useState<{ key: number; value: PlaceValue }[]>(() =>
    (account.favorite_airports ?? []).map((code, key) => ({ key, value: placeValue(code) })),
  );
  const nextKey = useRef(favorites.length);

  function setFavorite(key: number, value: PlaceValue) {
    setFavorites((list) => list.map((item) => (item.key === key ? { key, value } : item)));
  }

  return (
    <form action={action} className="grid gap-4" data-testid="preferences-form">
      <div className="grid gap-3 sm:grid-cols-3">
        <Select
          id="pref-locale"
          name="locale"
          label={t("language")}
          defaultValue={account.locale ?? locale}
        >
          {locales.map((code) => (
            <option key={code} value={code}>
              {LOCALE_NAMES[code]}
            </option>
          ))}
        </Select>
        <Select
          id="pref-currency"
          name="currency"
          label={t("currency")}
          defaultValue={account.currency ?? ""}
        >
          <option value="">{t("currencyDefault")}</option>
          {CURRENCIES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </Select>
        <Select
          id="pref-country"
          name="country"
          label={t("country")}
          defaultValue={account.country ?? ""}
        >
          <option value="">{t("notSet")}</option>
          {countries.map(({ code, name }) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </Select>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="pref-home" className="text-muted-foreground text-xs font-medium">
          {t("homeAirport")}
        </Label>
        <PlaceInput
          id="pref-home"
          name="home_airport"
          value={home}
          onChange={setHome}
          placeholder={tSearch("fromPlaceholder")}
        />
        <p className="text-muted-foreground text-xs">{t("homeAirportHint")}</p>
      </div>

      <fieldset className="grid gap-2">
        <legend className="text-muted-foreground mb-1.5 text-xs font-medium">
          {t("favoriteAirports", { max: MAX_FAVORITE_AIRPORTS })}
        </legend>
        {favorites.map(({ key, value }, i) => (
          <div key={key} className="flex items-center gap-2">
            <div className="flex-1">
              <PlaceInput
                id={`pref-fav-${key}`}
                name="favorite_airports"
                value={value}
                onChange={(v) => setFavorite(key, v)}
                placeholder={tSearch("toPlaceholder")}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("removeAirport", { n: i + 1 })}
              onClick={() => setFavorites((list) => list.filter((item) => item.key !== key))}
            >
              <X className="size-4" aria-hidden />
            </Button>
          </div>
        ))}
        {favorites.length < MAX_FAVORITE_AIRPORTS && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="justify-self-start"
            onClick={() =>
              setFavorites((list) => [...list, { key: nextKey.current++, value: placeValue("") }])
            }
          >
            <Plus className="size-4" aria-hidden />
            {t("addAirport")}
          </Button>
        )}
      </fieldset>

      <FormError state={state} />
      <Saved state={state} />
      <Submit className="justify-self-start">{t("save")}</Submit>
    </form>
  );
}

// --- особисті налаштування пошуку (п. 10.7) ---------------------------------------------

export function SearchPrefsForm({ account }: { account: Account }) {
  const t = useTranslations("account.prefs");
  const tSearch = useTranslations("search");
  const tFilters = useTranslations("filters");
  const tStay = useTranslations("stays");
  const tStayFilters = useTranslations("stayFilters");
  const tCard = useTranslations("stayCard");
  const [state, action] = useActionState(saveSearchPrefs, IDLE);
  const [reset, resetAction] = useActionState(resetSearchPrefs, IDLE);
  const f = account.search_prefs?.flights;
  const s = account.search_prefs?.stays;
  // Після скидання форма має показати порожні значення — ключ перемальовує її.
  const key = JSON.stringify(account.search_prefs ?? {});

  return (
    <div className="grid gap-4">
      <form key={key} action={action} className="grid gap-5" data-testid="search-prefs-form">
        <div className="grid gap-3">
          <h3 className="font-medium">{t("flights")}</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <Select
              id="sp-cabin"
              name="cabin"
              label={tSearch("cabin")}
              defaultValue={f?.cabin ?? ""}
            >
              <option value="">{t("notSet")}</option>
              {CABINS.map((c) => (
                <option key={c} value={c}>
                  {tSearch(`cabins.${c}`)}
                </option>
              ))}
            </Select>
            <Select
              id="sp-bag"
              name="bag"
              label={tSearch("baggage")}
              defaultValue={f?.baggage ?? ""}
            >
              <option value="">{t("notSet")}</option>
              {BAGGAGE_NEEDS.map((b) => (
                <option key={b} value={b}>
                  {tSearch(`bags.${b}`)}
                </option>
              ))}
            </Select>
            <Select
              id="sp-stops"
              name="stops"
              label={tFilters("stops")}
              defaultValue={f?.max_stops != null ? String(f.max_stops) : ""}
            >
              <option value="">{tFilters("anyStops")}</option>
              {MAX_STOPS_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {tFilters("maxStops", { count: n })}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sp-airlines" className="text-muted-foreground text-xs font-medium">
              {t("airlines")}
            </Label>
            <input
              id="sp-airlines"
              name="airlines"
              defaultValue={f?.airlines?.join(", ") ?? ""}
              placeholder="LO, LH"
              maxLength={60}
              autoCapitalize="characters"
              className={SELECT_CLASS}
            />
            <p className="text-muted-foreground text-xs">{t("airlinesHint")}</p>
          </div>
          <Checks
            legend={t("departure")}
            name="dep"
            options={DEPARTURE_PERIODS}
            checked={f?.departure_periods}
            label={(p) => tFilters(`period.${p}`)}
          />
          <Radios
            legend={tSearch("profile")}
            name="profile"
            options={PROFILES}
            checked={f?.profile ?? null}
            label={(p) => tSearch(`profiles.${p}`)}
            none={t("notSet")}
          />
        </div>

        <div className="grid gap-3 border-t pt-4">
          <h3 className="font-medium">{t("stays")}</h3>
          <Checks
            legend={tStayFilters("kind")}
            name="kind"
            options={STAY_KINDS}
            checked={s?.kinds}
            label={(k) => tCard(`kind.${k}`)}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              id="sp-rating"
              name="rating"
              label={tStayFilters("rating")}
              defaultValue={s?.min_rating != null ? String(s.min_rating) : ""}
            >
              <option value="">{tStayFilters("anyRating")}</option>
              {MIN_RATING_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {tStayFilters("ratingFrom", { rating: r })}
                </option>
              ))}
            </Select>
            <Select
              id="sp-dist"
              name="dist"
              label={tStayFilters("distance")}
              defaultValue={s?.max_distance_km != null ? String(s.max_distance_km) : ""}
            >
              <option value="">{tStayFilters("any")}</option>
              {MAX_DISTANCE_OPTIONS.map((km) => (
                <option key={km} value={km}>
                  {tStayFilters("upToKm", { km })}
                </option>
              ))}
            </Select>
          </div>
          <Checks
            legend={tStayFilters("amenities")}
            name="am"
            options={AMENITIES}
            checked={s?.amenities}
            label={(a) => tCard(`amenity.${a}`)}
          />
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="cancel"
              value="1"
              defaultChecked={s?.free_cancellation}
              className="accent-primary size-4"
            />
            {tStayFilters("freeCancellation")}
          </label>
          <Radios
            legend={tStay("priority")}
            name="prio"
            options={STAY_PROFILES}
            checked={s?.profile ?? null}
            label={(p) => tStay(`priorities.${p}`)}
            none={t("notSet")}
          />
        </div>

        <p className="text-muted-foreground text-xs">{t("howApplied")}</p>
        <FormError state={state} />
        <Saved state={state} />
        <Submit className="justify-self-start">{t("save")}</Submit>
      </form>
      <form action={resetAction}>
        <Button type="submit" variant="ghost" size="sm">
          {t("reset")}
        </Button>
        <FormError state={reset} />
      </form>
    </div>
  );
}

function Radios<T extends string>({
  legend,
  name,
  options,
  checked,
  label,
  none,
}: {
  legend: string;
  name: string;
  options: readonly T[];
  checked: T | null;
  label: (option: T) => string;
  none: string;
}) {
  return (
    <fieldset className="grid gap-1.5">
      <legend className="text-muted-foreground mb-1.5 text-xs font-medium">{legend}</legend>
      <div className="bg-muted inline-flex w-fit flex-wrap rounded-lg p-1 text-sm">
        {(["", ...options] as const).map((option) => (
          <label
            key={option || "none"}
            className="text-muted-foreground hover:text-foreground has-[:checked]:bg-card has-[:checked]:text-primary has-[:focus-visible]:ring-ring/50 cursor-pointer rounded-md px-3 py-1.5 transition-all has-[:checked]:font-medium has-[:checked]:shadow-sm has-[:focus-visible]:ring-[3px]"
          >
            <input
              type="radio"
              name={name}
              value={option}
              defaultChecked={(checked ?? "") === option}
              className="sr-only"
            />
            {option ? label(option as T) : none}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
