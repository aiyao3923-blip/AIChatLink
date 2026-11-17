/**
 * Room context figures are character estimates, never token counts. Keep one
 * compact unit per magnitude and promote at the boundary so a value just under
 * a million reads "1.0M" instead of "1000k".
 */
export function formatCharacterEstimate(value: number): string {
  const magnitude = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (magnitude < 1_000) {
    return String(Math.round(magnitude));
  }
  const thousands = magnitude / 1_000;
  // 999,950 would otherwise round up inside the k unit and print "1000k".
  if (thousands < 999.5) {
    return `${trimTrailingZero(thousands.toFixed(thousands >= 100 ? 0 : 1))}k`;
  }
  const millions = magnitude / 1_000_000;
  if (millions < 999.95) {
    return `${millions.toFixed(millions >= 100 ? 0 : 1)}M`;
  }
  const billions = magnitude / 1_000_000_000;
  return `${billions.toFixed(billions >= 100 ? 0 : 1)}G`;
}

function trimTrailingZero(fixed: string): string {
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}
