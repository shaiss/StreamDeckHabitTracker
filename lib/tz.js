// Timezone helpers. Priority: the human's saved profile tz (settings on the
// dashboard) > HOME_TZ env > Eastern. Server clocks are UTC; without this the
// coach thinks a 9 PM snack happened at 2 AM.
export const HOME_TZ = process.env.HOME_TZ || 'America/New_York';

export function isValidTz(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const cache = new Map();

// tzHelpers('America/New_York') -> { tz, hour(t), day(t) }
export function tzHelpers(tz) {
  const zone = tz && isValidTz(tz) ? tz : HOME_TZ;
  if (!cache.has(zone)) {
    const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hour12: false });
    const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: zone }); // YYYY-MM-DD
    cache.set(zone, {
      tz: zone,
      hour: (t) => parseInt(hourFmt.format(new Date(t)), 10) % 24,
      day: (t) => dayFmt.format(new Date(t))
    });
  }
  return cache.get(zone);
}
