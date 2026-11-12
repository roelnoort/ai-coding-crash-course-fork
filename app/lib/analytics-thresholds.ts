// ─── Analytics Thresholds ───
// Shared by the analytics service and the UI. Kept out of the service so
// components can import them without pulling the database into the browser.

/** A student who watched at least this share of a video finished it. */
export const FINISHED_SHARE = 0.9;
