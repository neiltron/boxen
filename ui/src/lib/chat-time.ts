// Session timestamps are cell receipt times, not tool execution durations.
export function eventTime(value: number | null | undefined): number | null {
  const number = Number(value);
  return number === value && Number.isFinite(number) && number >= 0 && number <= 8640000000000000 ? number : null;
}

export function dayKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function sameDay(a: number | null, b: number | null): boolean {
  return a === null || b === null ? a === b : dayKey(a) === dayKey(b);
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export function exactTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
}

export function dayLabel(ts: number, now: number): string {
  const date = new Date(ts);
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1); // Calendar days, including DST.
  const short = date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  if (sameDay(ts, now)) return `Today · ${short}`;
  if (sameDay(ts, yesterday.getTime())) return `Yesterday · ${short}`;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined });
}

export function messageAge(ts: number, now: number): string {
  // Clock skew must not turn into a negative age or "just now" for a future event.
  if (ts > now) return `${dayLabel(ts, now)} · ${clockTime(ts)}`;
  const minutes = Math.floor((now - ts) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (sameDay(ts, now)) return `${Math.floor(minutes / 60)}h ago`;
  return `${dayLabel(ts, now)} · ${clockTime(ts)}`;
}
