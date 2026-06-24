// Display-only formatting helpers for the dashboard. These are presentation
// utilities — they do not encode any trading logic, only how numbers/dates are
// shown. All inputs are plain values; callers pass shapes from "@/lib/types".

/** Format a price using an instrument's quote precision (defaults to 2). */
export function formatPrice(price: number, precision = 2): string {
  return price.toLocaleString("en-US", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

/** Format a reward/risk multiple with an explicit sign, e.g. "+1.85R". */
export function formatR(r: number | null | undefined): string {
  if (r === null || r === undefined || Number.isNaN(r)) return "—";
  const sign = r > 0 ? "+" : "";
  return `${sign}${r.toFixed(2)}R`;
}

/** Format a plain ratio (e.g. profit factor) to 2dp, with ∞ for divide-by-zero. */
export function formatRatio(n: number): string {
  if (!Number.isFinite(n)) return "∞";
  return n.toFixed(2);
}

/** Format a 0..1 fraction as a percentage, e.g. 0.625 -> "62.5%". */
export function formatPct(fraction: number, digits = 1): string {
  if (!Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Compact local time, e.g. "14:32". */
export function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Date + time, e.g. "Jun 24, 14:32". */
export function formatDateTime(date: Date): string {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Signed currency for USD-quoted P/L, e.g. "+$420.00". */
export function formatUsd(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
