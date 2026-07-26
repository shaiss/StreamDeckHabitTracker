// The human's timezone. Server clocks are UTC; without this the coach thinks
// a 9 PM snack happened at 2 AM. Override with HOME_TZ (IANA name).
export const HOME_TZ = process.env.HOME_TZ || 'America/New_York';

const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: HOME_TZ, hour: 'numeric', hour12: false });
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: HOME_TZ }); // YYYY-MM-DD

export function localHour(t) {
  return parseInt(hourFmt.format(new Date(t)), 10) % 24;
}

export function localDay(t) {
  return dayFmt.format(new Date(t));
}
