import { badRequest } from "../../../shared/errors";
const months = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const weekdays = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
const connectors = new Set(["today", "yesterday", "this", "last", "past", "ago", "of"]);
type Unit = "day" | "week" | "month" | "year";
function named(names: string[], word: string) {
  return word.length >= 3 ? names.findIndex((name) => name.startsWith(word)) : -1;
}
function unitNamed(word: string): Unit | undefined {
  const unit = word.replace(/s$/, "");
  return unit === "day" || unit === "week" || unit === "month" || unit === "year"
    ? unit
    : undefined;
}
export function isDateWord(word: string) {
  return (
    named(months, word) >= 0 ||
    named(weekdays, word) >= 0 ||
    !!unitNamed(word) ||
    connectors.has(word) ||
    /^\d+(st|nd|rd|th)?,?$|^\d{1,4}([-/.]\d{1,4}){1,2}$/.test(word)
  );
}
function civil(year: number, month: number, day: number) {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}
function add(date: Date, unit: Unit, amount: number) {
  return civil(
    date.getUTCFullYear() + (unit === "year" ? amount : 0),
    date.getUTCMonth() + (unit === "month" ? amount : 0),
    date.getUTCDate() + (unit === "day" ? amount : unit === "week" ? amount * 7 : 0),
  );
}
function zoneFormatter(zone: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: zone || "UTC",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    });
  } catch {
    return badRequest("invalid tz");
  }
}
function zoneParts(formatter: Intl.DateTimeFormat, date: Date) {
  const parts = formatter.formatToParts(date);
  const get = (name: string) => Number(parts.find((part) => part.type === name)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}
// Convert local midnight separately for both ends, including DST transitions.
function instant(date: Date, formatter: Intl.DateTimeFormat) {
  const target = date.getTime();
  let result = target;
  for (let i = 0; i < 4; i++) {
    const parts = zoneParts(formatter, new Date(result));
    const local =
      civil(parts.year, parts.month - 1, parts.day).getTime() +
      (parts.hour * 3600 + parts.minute * 60 + parts.second) * 1000;
    const correction = target - local;
    result += correction;
    if (!correction) break;
  }
  return new Date(result).toISOString();
}
export function searchDateContext(now = new Date(), zone = "UTC") {
  const formatter = zoneFormatter(zone),
    parts = zoneParts(formatter, now);
  return { today: civil(parts.year, parts.month - 1, parts.day), formatter };
}
export type SearchDateContext = ReturnType<typeof searchDateContext>;
export function searchPeriod(
  phrase: string,
  context: SearchDateContext,
): [string, string] | undefined {
  const words = phrase
    .toLowerCase()
    .replaceAll(",", " ")
    .split(/\s+/)
    .filter((word) => word && word !== "of")
    .map((word) => word.replace(/^(\d+)(st|nd|rd|th)$/, "$1"));
  const { today, formatter } = context;
  let period: [Date, Date] | undefined;
  const day = (date: Date): [Date, Date] => [date, add(date, "day", 1)];
  const daysSince = (date: Date, weekday: number) =>
    (date.getUTCDay() - weekday + 7) % 7;
  if (words.length === 1) {
    if (words[0] === "today") period = day(today);
    else if (words[0] === "yesterday") period = day(add(today, "day", -1));
    else if (named(weekdays, words[0]) >= 0)
      period = day(add(today, "day", -daysSince(today, named(weekdays, words[0]))));
  }
  if (words.length === 2) {
    const weekday = named(weekdays, words[1]),
      unit = unitNamed(words[1]);
    if (words[0] === "last" && weekday >= 0)
      period = day(add(today, "day", -(daysSince(add(today, "day", -1), weekday) + 1)));
    else if (unit && ["this", "last"].includes(words[0])) {
      const start =
        unit === "year"
          ? civil(today.getUTCFullYear(), 0, 1)
          : unit === "month"
            ? civil(today.getUTCFullYear(), today.getUTCMonth(), 1)
            : unit === "week"
              ? add(today, "day", -daysSince(today, 1))
              : today;
      period =
        words[0] === "this"
          ? [start, add(start, unit, 1)]
          : [add(start, unit, -1), start];
    }
  }
  if (words.length === 3) {
    const unit = unitNamed(words[2]),
      agoUnit = unitNamed(words[1]);
    if (
      unit &&
      /^(?:[+-]?\d+)$/.test(words[1]) &&
      ["last", "past"].includes(words[0])
    ) {
      const end = add(today, "day", 1);
      period = [add(end, unit, -Number(words[1])), end];
    } else if (agoUnit && /^[+-]?\d+$/.test(words[0]) && words[2] === "ago")
      period = day(add(today, agoUnit, -Number(words[0])));
  }
  function calendarDay(month: number, value: number, year = 0) {
    if (month < 0 || month > 11 || value < 1 || value > 31) return;
    if (!year) {
      year = today.getUTCFullYear();
      if (
        month > today.getUTCMonth() ||
        (month === today.getUTCMonth() && value > today.getUTCDate())
      )
        year--;
    }
    const date = civil(year, month, value);
    if (date.getUTCDate() === value) return day(date);
  }
  if (!period && words.length === 1) {
    const raw = words[0].replace(/[/.]/g, "-");
    const parts = raw.split("-");
    if (parts.every((part) => /^\d+$/.test(part))) {
      const values = parts.map(Number);
      if (parts.length === 3) {
        if (parts[0].length === 4)
          period = calendarDay(values[1] - 1, values[2], values[0]);
        else if (parts[2].length === 2 || parts[2].length === 4)
          period = calendarDay(
            values[1] - 1,
            values[0],
            parts[2].length === 2
              ? values[2] + (values[2] >= 69 ? 1900 : 2000)
              : values[2],
          );
      } else if (parts.length === 2) {
        if (parts[0].length === 4 && values[1] >= 1 && values[1] <= 12) {
          const start = civil(values[0], values[1] - 1, 1);
          period = [start, add(start, "month", 1)];
        } else if (parts[0].length <= 2) period = calendarDay(values[1] - 1, values[0]);
      } else if (parts[0].length === 4) {
        const start = civil(values[0], 0, 1);
        period = [start, add(start, "year", 1)];
      }
    }
  }
  if (!period) {
    let month = -1,
      value = 0,
      year = 0,
      valid = true;
    for (const word of words) {
      const m = named(months, word);
      if (m >= 0 && month < 0) month = m;
      else if (/^\d{4}$/.test(word) && !year) year = Number(word);
      else if (/^\d{1,2}$/.test(word) && !value) value = Number(word);
      else valid = false;
    }
    if (valid && month >= 0) {
      if (value > 0) period = calendarDay(month, value, year);
      else {
        if (!year)
          year = today.getUTCFullYear() - (month > today.getUTCMonth() ? 1 : 0);
        const start = civil(year, month, 1);
        period = [start, add(start, "month", 1)];
      }
    }
  }
  return period
    ? [instant(period[0], formatter), instant(period[1], formatter)]
    : undefined;
}
