import type { AlertEdit } from "@tickets/shared";
import type { NextRequest } from "next/server";

import { backUrl } from "@/lib/alert-routes";
import { editAlert } from "@/lib/api";

const CONDITIONS = ["below_price", "drop_amount", "drop_percent", "below_typical"] as const;
const BAGGAGE = ["none", "personal_item", "carry_on", "checked", "checked_extra"] as const;

function int(value: FormDataEntryValue | null): number | null {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : null;
}

function day(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function rating(value: FormDataEntryValue | null): number | null {
  const n = int(value);
  return n != null && n >= 1 && n <= 10 ? n : null;
}

/** Редагування підписки звичайною формою (без JS теж). Перевіряє API тими ж правилами. */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const condition = CONDITIONS.find((c) => c === form.get("condition")) ?? "below_price";
  const edit: AlertEdit = {
    departure_date: day(form.get("departure_date")) ?? "",
    return_date: day(form.get("return_date")),
    departure_until: day(form.get("departure_until")),
    min_nights: int(form.get("min_nights")),
    max_nights: int(form.get("max_nights")),
    weekends: form.get("weekends") === "1",
    adults: int(form.get("adults")) ?? 1,
    baggage: BAGGAGE.find((b) => b === form.get("baggage")) ?? "none",
    direct_only: form.get("direct_only") === "1",
    min_rating: rating(form.get("min_rating")),
    condition,
    threshold:
      condition === "below_price"
        ? int(form.get("threshold_price"))
        : condition === "drop_amount"
          ? int(form.get("threshold_drop"))
          : null,
    percent: condition === "drop_percent" ? int(form.get("percent")) : null,
  };
  const result = token ? await editAlert(token, edit) : null;
  return Response.redirect(backUrl(request, form, token, result?.ok ? "edit" : "editFailed"), 303);
}
