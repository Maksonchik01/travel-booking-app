import type { OpsSummary } from "@tickets/shared";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { connection } from "next/server";
import { Suspense } from "react";

import { setBudget } from "@/app/actions/ops";
import { SiteFooter } from "@/components/page-chrome";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { fetchOpsSummary, isOpsAdmin } from "@/lib/ops";
import { currentAccount } from "@/lib/session";
import { FIELD_CLASS, SELECT_CLASS } from "@/lib/styles";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Технічний стан SkyPack для власника (V3, етап 10, ADR 0062): бюджети й витрати платних API,
 * собівартість пошуку, кеш, джерела, ліміти запитів, ШІ — і зміна лімітів без редеплою.
 * Доступ — лише `OPS_ADMINS` (інакше 404); дані — `/ops/summary` API, лише агрегати.
 */
export default function OpsPage({ searchParams }: PageProps<"/[locale]/ops">) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader active={null} />
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 outline-none"
      >
        <Suspense fallback={<div className="shimmer h-96 rounded-xl" aria-hidden />}>
          <Ops searchParams={searchParams} />
        </Suspense>
      </main>
      <SiteFooter />
    </div>
  );
}

async function Ops({ searchParams }: { searchParams: PageProps<"/[locale]/ops">["searchParams"] }) {
  await connection();
  if (!isOpsAdmin(await currentAccount())) notFound();
  const [summary, raw] = await Promise.all([fetchOpsSummary(), searchParams]);
  const done = raw.done === "budget";
  const error = typeof raw.error === "string";
  return <Dashboard summary={summary} done={done} error={error} />;
}

const TH = "text-muted-foreground px-2 py-1.5 text-left text-xs font-medium";
const TD = "px-2 py-1.5 tabular-nums";

function Dashboard({
  summary,
  done,
  error,
}: {
  summary: OpsSummary | null;
  done: boolean;
  error: boolean;
}) {
  const t = useTranslations("ops");
  const format = useFormatter();
  const usd = (value: number | string | null | undefined, digits = 2) =>
    value == null
      ? "—"
      : format.number(Number(value), {
          style: "currency",
          currency: "USD",
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        });
  const percent = (value: number | null | undefined) =>
    value == null ? "—" : format.number(value, { style: "percent", maximumFractionDigits: 0 });

  if (!summary) {
    return (
      <p role="alert" className="text-destructive" data-testid="ops-unavailable">
        {t("unavailable")}
      </p>
    );
  }
  const spend = summary.api_spend;

  return (
    <div className="grid gap-6" data-testid="ops">
      <header className="grid gap-1">
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground text-xs">
          {t("generated", {
            at: format.dateTime(new Date(summary.generated_at), {
              dateStyle: "medium",
              timeStyle: "short",
            }),
          })}
        </p>
      </header>

      {done && (
        <p
          role="status"
          className="border-success/40 bg-success/5 text-success rounded-lg border px-3 py-2 text-sm"
        >
          {t("saved")}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="border-destructive/30 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
        >
          {t("failed")}
        </p>
      )}
      {summary.problems.length > 0 && (
        <section
          className="bg-warning/10 grid gap-1 rounded-lg px-3 py-2 text-sm"
          aria-label={t("problems")}
        >
          <h2 className="font-semibold">{t("problems")}</h2>
          <ul className="list-disc pl-5">
            {summary.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </section>
      )}

      {spend && (
        <Section title={t("budgets.title")} note={t("budgets.note")}>
          <Table>
            <thead>
              <tr>
                <th className={TH}>{t("budgets.account")}</th>
                <th className={TH}>{t("period.hour")}</th>
                <th className={TH}>{t("period.day")}</th>
                <th className={TH}>{t("period.month")}</th>
                <th className={TH}>{t("budgets.costToday")}</th>
                <th className={TH}>{t("budgets.costMonth")}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(spend.accounts).map(([name, a]) => (
                <tr key={name} className={cn("border-t", a.near_limit && "bg-warning/10")}>
                  <td className={cn(TD, "font-medium")}>
                    {name}
                    {a.near_limit && (
                      <span className="text-warning ml-2 text-xs font-semibold">
                        {t("budgets.near")}
                      </span>
                    )}
                  </td>
                  {(["hour", "day", "month"] as const).map((p) => (
                    <td key={p} className={TD}>
                      {a.used[p] ?? 0} / {a.limits[p] ?? "∞"}
                    </td>
                  ))}
                  <td className={TD}>{usd(a.cost_usd_today, 4)}</td>
                  <td className={TD}>{usd(a.cost_usd_month, 4)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <form
            action={setBudget}
            className="flex flex-wrap items-end gap-2"
            data-testid="ops-budget-form"
          >
            <label className="grid gap-1 text-xs">
              {t("budgets.account")}
              <select name="account" className={SELECT_CLASS} defaultValue="serpapi">
                <option value="serpapi">serpapi</option>
                <option value="scrapedo">scrapedo</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs">
              {t("budgets.period")}
              <select name="period" className={SELECT_CLASS} defaultValue="day">
                {(["hour", "day", "month"] as const).map((p) => (
                  <option key={p} value={p}>
                    {t(`period.${p}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs">
              {t("budgets.limit")}
              <input
                name="limit"
                type="number"
                min={0}
                inputMode="numeric"
                placeholder={t("budgets.unlimited")}
                className={cn(FIELD_CLASS, "w-36")}
              />
            </label>
            <label className="flex items-center gap-2 pb-2.5 text-xs">
              <input type="checkbox" name="reset" value="1" className="size-4" />
              {t("budgets.reset")}
            </label>
            <Button type="submit">{t("budgets.save")}</Button>
          </form>
        </Section>
      )}

      {spend && (
        <Section title={t("searches.title")}>
          <p className="text-sm">
            {t("searches.cost", {
              total: usd(spend.cost_usd_7d, 4),
              perSearch: usd(spend.cost_per_successful_search_usd_7d, 4),
            })}
          </p>
          <Table>
            <thead>
              <tr>
                <th className={TH}>{t("searches.kind")}</th>
                <th className={TH}>{t("searches.ok")}</th>
                <th className={TH}>{t("searches.empty")}</th>
                <th className={TH}>{t("searches.avgMs")}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(spend.searches_7d).map(([kind, s]) => (
                <tr key={kind} className="border-t">
                  <td className={cn(TD, "font-medium")}>{kind}</td>
                  <td className={TD}>{s.ok ?? 0}</td>
                  <td className={TD}>{s.empty ?? 0}</td>
                  <td className={TD}>{s.avg_ms ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Section>
      )}

      {spend && (
        <Section title={t("sources.title")}>
          <Table>
            <thead>
              <tr>
                <th className={TH}>{t("sources.operation")}</th>
                <th className={TH}>{t("sources.requests")}</th>
                <th className={TH}>{t("sources.errors")}</th>
                <th className={TH}>{t("sources.blocked")}</th>
                <th className={TH}>{t("sources.avgMs")}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(spend.operations_7d).map(([op, s]) => (
                <tr
                  key={op}
                  className={cn(
                    "border-t",
                    s.requests > 0 && s.errors / s.requests >= 0.5 && "bg-warning/10",
                  )}
                >
                  <td className={cn(TD, "font-medium")}>{op}</td>
                  <td className={TD}>{s.requests}</td>
                  <td className={TD}>{s.errors}</td>
                  <td className={TD}>{s.blocked}</td>
                  <td className={TD}>{s.avg_ms ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Table>
            <thead>
              <tr>
                <th className={TH}>{t("cache.source")}</th>
                <th className={TH}>{t("cache.hitRate")}</th>
                <th className={TH}>{t("cache.hits")}</th>
                <th className={TH}>{t("cache.shared")}</th>
                <th className={TH}>{t("cache.misses")}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(spend.cache_7d ?? {}).map(([source, c]) => (
                <tr key={source} className="border-t">
                  <td className={cn(TD, "font-medium")}>{source}</td>
                  <td className={TD}>{percent(c.hit_rate)}</td>
                  <td className={TD}>{c.hits}</td>
                  <td className={TD}>{c.shared}</td>
                  <td className={TD}>{c.misses}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {Object.keys(spend.rate_limited_7d ?? {}).length > 0 && (
            <p className="text-sm">
              {t("rateLimited")}{" "}
              {Object.entries(spend.rate_limited_7d ?? {})
                .map(([bucket, count]) => `${bucket}: ${count}`)
                .join(" · ")}
            </p>
          )}
        </Section>
      )}

      <Section title={t("ai.title")}>
        {summary.llm ? (
          <p className="text-sm">
            {t("ai.text", {
              calls: summary.llm.calls_24h,
              errors: summary.llm.errors_24h,
              day: usd(summary.llm.cost_usd_24h, 4),
              month: usd(summary.llm.cost_usd_30d, 2),
            })}
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">—</p>
        )}
        {summary.serpapi && (
          <p className="text-sm">
            {t("serpapiQuota", {
              used: summary.serpapi.this_month_usage ?? 0,
              total: summary.serpapi.searches_per_month ?? 0,
              left: summary.serpapi.total_searches_left ?? 0,
            })}
          </p>
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-card grid gap-3 rounded-xl border p-4 shadow-xs">
      <div className="grid gap-0.5">
        <h2 className="font-semibold">{title}</h2>
        {note && <p className="text-muted-foreground text-xs">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[28rem] text-sm">{children}</table>
    </div>
  );
}
