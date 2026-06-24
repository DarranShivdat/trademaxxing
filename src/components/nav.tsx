"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Overview", hint: "Live instruments & risk" },
  { href: "/signals", label: "Signals", hint: "Detected setups" },
  { href: "/trades", label: "Paper Trades", hint: "Trade log" },
  { href: "/analytics", label: "Analytics", hint: "Performance" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1">
      {LINKS.map((link) => {
        const active =
          link.href === "/"
            ? pathname === "/"
            : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`group rounded-md px-3 py-2 text-sm transition-colors ${
              active
                ? "bg-neutral-800 text-neutral-100"
                : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
            }`}
          >
            <div className="font-medium">{link.label}</div>
            <div
              className={`text-[11px] ${
                active ? "text-neutral-400" : "text-neutral-600"
              }`}
            >
              {link.hint}
            </div>
          </Link>
        );
      })}
    </nav>
  );
}
