/**
 * Режими пошуку (модуль 12.2): авіаквитки, житло, поїздка. Під час перемикання переносимо
 * спільне — куди, дати, людей; у житла місто — це «куди» перельоту, заїзд/виїзд — виліт/
 * повернення. Інше (клас, фільтри, бюджет) у кожного режиму своє й не переноситься.
 */
export type SearchMode = "flights" | "stays" | "trip";
export const SEARCH_MODES: readonly SearchMode[] = ["flights", "stays", "trip"];
export const MODE_PATH: Record<SearchMode, string> = {
  flights: "/",
  stays: "/stays",
  trip: "/trip",
};

/** Спільні параметри режимів (лише перевірені значення). */
export type CommonSearch = {
  from?: string;
  to?: string;
  /** Додаткові аеропорти (модуль 2) — лише між перельотами й поїздкою. */
  fromAlso?: string[];
  toAlso?: string[];
  depart?: string;
  return?: string;
  adults?: number;
  children?: number;
};

const IATA = /^[A-Z]{3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Source = URLSearchParams | FormData | Record<string, string | string[] | undefined>;

function read(source: Source, key: string): string | undefined {
  if (source instanceof URLSearchParams || source instanceof FormData) {
    const value = source.get(key);
    return typeof value === "string" && value !== "" ? value : undefined;
  }
  const value = source[key];
  const first = Array.isArray(value) ? value[0] : value;
  return first || undefined;
}

/** Усі значення ключа (повторювані поля форми, `from=AMS&from=RTM`). */
function readAll(source: Source, key: string): string[] {
  if (source instanceof URLSearchParams || source instanceof FormData) {
    return source.getAll(key).filter((v): v is string => typeof v === "string" && v !== "");
  }
  const value = source[key];
  return (Array.isArray(value) ? value : value ? [value] : []).filter(Boolean);
}

function extraCodes(source: Source, key: string): string[] | undefined {
  const codes = [
    ...new Set(
      readAll(source, key)
        .map(code)
        .filter((c): c is string => !!c),
    ),
  ];
  return codes.length > 1 ? codes.slice(1, 4) : undefined;
}

function code(value: string | undefined): string | undefined {
  const upper = value?.trim().toUpperCase();
  return upper && IATA.test(upper) ? upper : undefined;
}

function day(value: string | undefined): string | undefined {
  return value && DAY.test(value) ? value : undefined;
}

function count(value: string | undefined, min: number, max: number): number | undefined {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/** Спільне з параметрів (URL чи форми) поточного режиму. */
export function commonFrom(mode: SearchMode, source: Source): CommonSearch {
  const stays = mode === "stays";
  const oneWay = mode === "flights" && read(source, "trip") === "ow";
  const common: CommonSearch = {
    from: stays ? undefined : code(read(source, "from")),
    to: code(read(source, stays ? "city" : "to")),
    fromAlso: stays ? undefined : extraCodes(source, "from"),
    toAlso: stays ? undefined : extraCodes(source, "to"),
    depart: day(read(source, stays ? "in" : "depart")),
    return: oneWay ? undefined : day(read(source, stays ? "out" : "return")),
    adults: count(read(source, "adults"), 1, 9),
    children: count(read(source, "children"), 0, 8),
  };
  return Object.fromEntries(
    Object.entries(common).filter(([, v]) => v !== undefined),
  ) as CommonSearch;
}

/** Адреса режиму `target` зі спільними параметрами (порожньо — просто сторінка режиму). */
export function modeHref(target: SearchMode, common: CommonSearch): string {
  const params = new URLSearchParams();
  const set = (key: string, value: string | number | undefined) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  };
  if (target === "stays") {
    set("city", common.to);
    set("in", common.depart);
    set("out", common.return);
  } else {
    set("from", common.from);
    for (const extra of common.fromAlso ?? []) params.append("from", extra);
    set("to", common.to);
    for (const extra of common.toAlso ?? []) params.append("to", extra);
    set("depart", common.depart);
    set("return", common.return);
  }
  set("adults", common.adults);
  if (common.children) set("children", common.children);
  const query = params.toString();
  return query ? `${MODE_PATH[target]}?${query}` : MODE_PATH[target];
}

/**
 * Чернетка форми в адресі (модуль 20.4): поки результатів немає, введене в форму (куди, дати,
 * люди) тримаємо в URL з `draft=1` — випадкове оновлення сторінки його не губить. Адреса з
 * `draft=1` НЕ запускає пошук, навіть повна: шукати — лише кнопкою (живі джерела мають квоту).
 */
export const DRAFT_PARAM = "draft";

export function isDraft(source: Source): boolean {
  return read(source, DRAFT_PARAM) === "1";
}

export function draftHref(mode: SearchMode, common: CommonSearch): string {
  const meaningful = common.from || common.to || common.depart || common.return;
  const href = modeHref(mode, meaningful ? common : {});
  if (!meaningful) return href;
  return `${href}${href.includes("?") ? "&" : "?"}${DRAFT_PARAM}=1`;
}

const LAST_SEARCH_KEY = "tickets.lastSearch.";
const SAME_TRIP_KEYS = ["from", "to", "depart", "return", "adults", "children"] as const;

/**
 * Останній пошук кожного розділу у вкладці (sessionStorage, модуль 23b): повернення в розділ
 * відкриває саме його — з обраним рейсом і житлом, фільтрами, сортуванням, — а не новий пошук.
 */
export function rememberSearch(mode: SearchMode, href: string): void {
  try {
    sessionStorage.setItem(LAST_SEARCH_KEY + mode, href);
  } catch {
    // без сховища повертаємось звичайним посиланням
  }
}

export function lastSearch(mode: SearchMode): string | null {
  try {
    return sessionStorage.getItem(LAST_SEARCH_KEY + mode);
  } catch {
    return null;
  }
}

/**
 * Куди веде перемикач розділів: останній пошук розділу, якщо він про ту саму подорож (куди,
 * дати, люди — що задано в обох), інакше — новий пошук зі спільним (`modeHref`).
 */
export function returnHref(target: SearchMode, common: CommonSearch): string {
  const last = lastSearch(target);
  if (last) {
    const query = new URLSearchParams(last.split("?")[1] ?? "");
    const remembered = commonFrom(target, query);
    const same = SAME_TRIP_KEYS.every(
      (key) =>
        remembered[key] === undefined ||
        common[key] === undefined ||
        remembered[key] === common[key],
    );
    if (same && remembered.to !== undefined && remembered.to === common.to) return last;
  }
  return modeHref(target, common);
}
