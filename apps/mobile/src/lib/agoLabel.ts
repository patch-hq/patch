// "4s ago" / "3m ago" / "5h ago" / "4d ago" for a past timestamp; "never" when
// there is none. Shared by the Hosts/Devices settings rows and the Jobs tab's
// last-fired column (spec/15 § Jobs screen).
export function agoLabel(at: number | null, now: number = Date.now()): string {
  if (at === null) return 'never';
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 60) return `${secs}s ago`;
  // Pick the unit from the ROUNDED count, so 59m40s reads "1h ago", not "60m ago".
  if (Math.round(secs / 60) < 60) return `${Math.round(secs / 60)}m ago`;
  if (Math.round(secs / 3600) < 48) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}
