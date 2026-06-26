// bookingLogic.js
// Pure functions for computing availability. Ported from the original artifact's
// client-side logic, but this copy is the SERVER's source of truth — the client
// only uses logic like this for a responsive UI; the server re-checks everything
// before accepting a booking, since client-side checks can't be trusted alone.

export const MIN_BOOKING_LENGTH = 30; // minutes

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function toHHMM(mins) {
  mins = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function sortBookings(bookings) {
  return [...bookings].sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time));
}

export function buildBlockedRanges(bookings, interval) {
  return sortBookings(bookings).map((b) => ({
    blockStart: toMinutes(b.start_time) - interval,
    blockEnd: toMinutes(b.end_time) + interval,
  }));
}

function isWithinBlockedRange(minute, blocked) {
  return blocked.some((r) => minute >= r.blockStart && minute < r.blockEnd);
}

export function getAvailableFromOptions(windowObj, bookings) {
  const winStart = toMinutes(windowObj.window_start);
  const winEnd = toMinutes(windowObj.window_end);
  const blocked = buildBlockedRanges(bookings, Number(windowObj.interval_minutes) || 0);
  const options = [];
  for (let t = winStart; t <= winEnd - MIN_BOOKING_LENGTH; t += 15) {
    if (isWithinBlockedRange(t, blocked)) continue;
    const nextBlockStart = blocked
      .map((r) => r.blockStart)
      .filter((bs) => bs > t)
      .sort((a, b) => a - b)[0];
    const ceiling = Math.min(winEnd, nextBlockStart !== undefined ? nextBlockStart : winEnd);
    if (ceiling - t >= MIN_BOOKING_LENGTH) {
      options.push(t);
    }
  }
  return options;
}

export function getAvailableToOptions(windowObj, bookings, fromMinute) {
  if (fromMinute === null || fromMinute === undefined) return [];
  const winEnd = toMinutes(windowObj.window_end);
  const blocked = buildBlockedRanges(bookings, Number(windowObj.interval_minutes) || 0);
  const nextBlockStart = blocked
    .map((r) => r.blockStart)
    .filter((bs) => bs > fromMinute)
    .sort((a, b) => a - b)[0];
  const ceiling = Math.min(winEnd, nextBlockStart !== undefined ? nextBlockStart : winEnd);
  const options = [];
  for (let t = fromMinute + MIN_BOOKING_LENGTH; t <= ceiling; t += 15) {
    options.push(t);
  }
  return options;
}

// The critical server-side check: given a proposed start/end and the day's existing
// bookings + window, is this booking actually valid? Never trust the client's own
// From/To dropdown filtering as a substitute for this — a malicious or buggy client
// could submit any start/end pair directly to the API.
export function validateBookingRequest({ window, existingBookings, startHHMM, endHHMM }) {
  const start = toMinutes(startHHMM);
  const end = toMinutes(endHHMM);

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { ok: false, message: "Invalid time format." };
  }
  if (end - start < MIN_BOOKING_LENGTH) {
    return { ok: false, message: `Bookings must be at least ${MIN_BOOKING_LENGTH} minutes long.` };
  }
  const winStart = toMinutes(window.window_start);
  const winEnd = toMinutes(window.window_end);
  if (start < winStart || end > winEnd) {
    return { ok: false, message: "Requested time is outside the available window for this day." };
  }

  const interval = Number(window.interval_minutes) || 0;
  const blocked = buildBlockedRanges(existingBookings, interval);
  const overlapsBlocked = blocked.some((r) => start < r.blockEnd && end > r.blockStart);
  if (overlapsBlocked) {
    return { ok: false, message: "That time is no longer available — it may have just been booked. Please choose another time." };
  }

  return { ok: true };
}

export function computeLoadFraction(windowRow, bookings) {
  if (!windowRow) return null;
  const winStart = toMinutes(windowRow.window_start);
  const winEnd = toMinutes(windowRow.window_end);
  const totalSpan = winEnd - winStart;
  if (totalSpan <= 0) return null;
  const interval = Number(windowRow.interval_minutes) || 0;
  if (!bookings || bookings.length === 0) return 0;

  const ranges = sortBookings(bookings)
    .map((b) => ({
      start: Math.max(winStart, toMinutes(b.start_time) - interval),
      end: Math.min(winEnd, toMinutes(b.end_time) + interval),
    }))
    .sort((a, b) => a.start - b.start);

  let consumed = 0;
  let curStart = null;
  let curEnd = null;
  for (const r of ranges) {
    if (curStart === null) {
      curStart = r.start;
      curEnd = r.end;
    } else if (r.start <= curEnd) {
      curEnd = Math.max(curEnd, r.end);
    } else {
      consumed += curEnd - curStart;
      curStart = r.start;
      curEnd = r.end;
    }
  }
  if (curStart !== null) consumed += curEnd - curStart;

  return Math.min(1, consumed / totalSpan);
}
