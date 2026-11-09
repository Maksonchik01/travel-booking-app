import type { Stay } from "@tickets/shared";
import { Star } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { ShowOnMap } from "@/components/show-on-map";
import { stayAnchor } from "@/components/stay-picks";
import { fractionDigits } from "@/lib/money";

/**
 * Компактний список поруч із картою (модуль 6): назва, тип, рейтинг, відстань, ціна й «На карті».
 * Повна картка — у режимі «Список» («Детальніше»).
 */
export function StayMapList({ stays, listHref }: { stays: Stay[]; listHref: string }) {
  const t = useTranslations("stayCard");
  const tMap = useTranslations("stayMap");
  const format = useFormatter();
  const money = (s: Stay, value: number) =>
    format.number(value, {
      style: "currency",
      currency: s.currency,
      currencyDisplay: "narrowSymbol",
      ...fractionDigits(value),
    });
  return (
    <ol className="grid gap-2" data-testid="stay-map-list">
      {stays.map((s) => {
        const key = `${s.source}:${s.id}`;
        return (
          <li
            key={key}
            className="bg-card grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-lg border p-3"
          >
            <div className="min-w-0">
              <p className="truncate font-semibold">{s.name}</p>
              <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                <span>{t(`kind.${s.kind}`)}</span>
                {s.rating != null && (
                  <span className="flex items-center gap-0.5">
                    <Star className="size-3 fill-amber-400 text-amber-400" aria-hidden />
                    {format.number(s.rating, { maximumFractionDigits: 1 })}
                  </span>
                )}
                {s.distance_to_center_km != null && (
                  <span>
                    {t("toCenter", {
                      km: format.number(s.distance_to_center_km, { maximumFractionDigits: 1 }),
                    })}
                  </span>
                )}
              </p>
            </div>
            <div className="text-right">
              <p className="font-bold tabular-nums">{money(s, s.price_per_night)}</p>
              <p className="text-muted-foreground text-[11px]">{t("perNight")}</p>
            </div>
            <div className="col-span-2 flex flex-wrap items-center gap-2">
              {s.latitude != null && s.longitude != null ? (
                <div className="w-32">
                  <ShowOnMap stayKey={key} />
                </div>
              ) : (
                <span className="text-muted-foreground text-xs">{tMap("noCoordinates")}</span>
              )}
              <a
                href={`${listHref}#${stayAnchor(key)}`}
                className="text-primary text-xs font-medium hover:underline"
              >
                {tMap("details")}
              </a>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
