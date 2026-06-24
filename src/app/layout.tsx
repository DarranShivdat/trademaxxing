import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/nav";

export const metadata: Metadata = {
  title: "Trademaxxing — Monitor",
  description: "AI-assisted paper-trading monitor for forex & commodities",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
        <div className="flex min-h-screen">
          {/* Sidebar */}
          <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950 px-3 py-5 md:flex">
            <div className="px-3 pb-5">
              <div className="font-mono text-sm font-bold tracking-tight text-neutral-100">
                TRADE<span className="text-emerald-400">MAXX</span>
              </div>
              <div className="text-[11px] text-neutral-600">paper-trading monitor</div>
            </div>
            <Nav />
            <div className="mt-auto px-3 pt-5">
              <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 text-[11px] leading-snug text-amber-500/80">
                Demo data — detection &amp; risk pipeline not yet wired.
              </div>
            </div>
          </aside>

          {/* Mobile top bar */}
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex items-center gap-3 border-b border-neutral-800 px-4 py-3 md:hidden">
              <div className="font-mono text-sm font-bold">
                TRADE<span className="text-emerald-400">MAXX</span>
              </div>
            </header>
            <div className="md:hidden border-b border-neutral-800 px-2 py-2">
              <Nav />
            </div>
            <main className="min-w-0 flex-1 px-4 py-6 md:px-8">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
