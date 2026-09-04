/**
 * OffHours — which US equities session a timestamp falls in.
 *
 * This is the axis the whole product turns on: a premium measured at 03:00 ET
 * means something completely different from one measured at 10:00 ET. Chainlink
 * marks these feeds `us_equities_24/5`, so the reference stops tracking a live
 * market outside the regular session while the AMM keeps trading.
 *
 * Exchange holidays are not modelled — a holiday reads as "regular" here. The
 * collector records the phase alongside the raw timestamp so a later pass can
 * reclassify without recollecting.
 */

export type Phase = "regular" | "pre" | "after" | "overnight" | "weekend";

export function marketPhase(d: Date = new Date()): { phase: Phase; etTime: string; offHours: boolean } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const weekday = get("weekday");
  const minutes = Number(get("hour")) % 24 * 60 + Number(get("minute"));
  const etTime = `${get("weekday")} ${String(Number(get("hour")) % 24).padStart(2, "0")}:${get("minute")} ET`;

  if (weekday === "Sat" || weekday === "Sun") return { phase: "weekend", etTime, offHours: true };
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return { phase: "regular", etTime, offHours: false };
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return { phase: "pre", etTime, offHours: true };
  if (minutes >= 16 * 60 && minutes < 20 * 60) return { phase: "after", etTime, offHours: true };
  return { phase: "overnight", etTime, offHours: true };
}
