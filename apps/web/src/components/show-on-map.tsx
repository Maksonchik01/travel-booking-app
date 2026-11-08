"use client";

import { MapPin } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { focusStayOnMap } from "@/lib/map-events";

/** «На карті» в картці житла: підсвічує й показує маркер (синхронізація список → карта). */
export function ShowOnMap({ stayKey }: { stayKey: string }) {
  const t = useTranslations("stayMap");
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="w-full"
      onClick={() => focusStayOnMap(stayKey)}
    >
      <MapPin className="size-3.5" aria-hidden />
      {t("showOnMap")}
    </Button>
  );
}
