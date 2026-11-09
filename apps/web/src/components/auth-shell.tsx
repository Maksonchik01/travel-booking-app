import { HeroBackdrop, SiteFooter } from "@/components/page-chrome";
import { SiteHeader } from "@/components/site-header";
import { Card, CardContent } from "@/components/ui/card";

/** Оформлення сторінок входу: картка по центру на синьому тлі. */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SiteHeader active={null} />
      <main id="main" tabIndex={-1} className="outline-none relative isolate flex-1">
        <HeroBackdrop />
        <div className="mx-auto grid w-full max-w-md gap-5 px-4 py-10 sm:py-14">
          <div className="grid gap-1 text-center">
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
            {subtitle && <p className="text-muted-foreground text-sm">{subtitle}</p>}
          </div>
          <Card className="border-primary/10 shadow-primary/[0.07] py-0 shadow-xl">
            <CardContent className="grid gap-5 p-5 sm:p-6">{children}</CardContent>
          </Card>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
