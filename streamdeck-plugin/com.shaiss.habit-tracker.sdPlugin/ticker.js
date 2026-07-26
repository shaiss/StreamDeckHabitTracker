/* Off-thread heartbeat for the plugin page.
 *
 * The Stream Deck plugin page is a CEF page that is NEVER visible, and
 * Chromium throttles page timers on hidden pages — intensive throttling caps
 * them at roughly once a minute, and page freezing can stop them outright.
 * A 15s setInterval in the page therefore does not stay a 15s interval, which
 * is why physical key faces go stale while a visible browser tab polling the
 * same endpoint stays current.
 *
 * Worker timers run off the page's thread and are not subject to that
 * throttling, so the beat lives here and app.js only reacts to it. Elgato
 * shipped the same workaround as `streamdeck-timerfix`; this is the minimal
 * version of it — one message per tick, no state.
 */
'use strict';

var timer = null;

self.onmessage = function (e) {
  var every = (e.data && e.data.every) || 3000;
  if (timer) clearInterval(timer);
  timer = setInterval(function () {
    self.postMessage(Date.now());
  }, every);
};
