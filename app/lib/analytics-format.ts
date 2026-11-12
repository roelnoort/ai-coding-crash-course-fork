import { formatPrice } from "~/lib/utils";

// ─── Analytics Formatting ───
// Display helpers for analytics figures. Averages with no data are null and
// render as "—", so "no data" isn't mistaken for a bad result.

export const NO_DATA = "—";

export function formatPercent(value: number | null) {
  return value === null ? NO_DATA : `${Math.round(value * 100)}%`;
}

export function formatRating(value: number | null) {
  return value === null ? NO_DATA : value.toFixed(1);
}

export function formatRevenue(cents: number) {
  // formatPrice renders 0 as "Free", which reads wrong for earnings.
  return cents === 0 ? "$0.00" : formatPrice(cents);
}
