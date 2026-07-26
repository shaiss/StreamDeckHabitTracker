/* Habit Tracker AI — Stream Deck plugin.
 *
 * Two actions:
 *  - ...habit  settings: { base, index (0-based position), key? }
 *  - ...slot   settings: { base, slot (1-4), key? }
 *
 * Everything renders from live server state: one poll of <base>/api/slots
 * carries both the habit list and the AI slot assignments, so habit-manager
 * edits and coach swaps repaint physical keys within one poll. Taps resolve
 * server-side (?hkey= / ?slot=) so history records what the key showed.
 *
 * LIVENESS — why the clock is built the way it is:
 * this page is a CEF page that is never visible, and Chromium throttles page
 * timers on hidden pages (~1/min under intensive throttling, and page freezing
 * can stop them entirely). A plain setInterval therefore does NOT keep the
 * faces live on hardware, even though a visible browser tab polling the same
 * endpoint stays current. Four layers, cheapest first:
 *   1. ticker.js — a Web Worker beat, off-thread where throttling does not
 *      apply (Elgato's own `streamdeck-timerfix` workaround).
 *   2. Wall-clock deadlines (nextPollAt / rechecks), re-evaluated on every
 *      wake rather than trusted to fire on time — a throttled or frozen clock
 *      converges late instead of dropping the work.
 *   3. Inbound Stream Deck WebSocket traffic (keyDown, willAppear, wake, device
 *      connect) pumps the same deadline check. That socket is a native push
 *      channel page throttling cannot touch, so any interaction un-sticks a
 *      frozen page.
 *   4. A page setInterval as a last-resort backstop, in case Worker is
 *      unavailable in this CEF build.
 */
'use strict';

var VERSION = '1.6.0';    // reported to the server so the dashboard can show
                          // which plugin build a physical deck is running

var ws = null;
var keys = {};            // context -> { action, settings }
var slotCache = null;     // latest slots array from the server
var habitCache = null;    // latest habit list from the server (live-editable)
var slotCacheAt = 0;

var POLL_MS = 15000;
var TICK_MS = 3000;       // heartbeat granularity; deadlines resolve on a tick
// The coach reacts to taps in a background pass, so one recheck can easily land
// before the swap exists. Chain a few wall-clock rechecks instead of betting on
// a single delay.
var RECHECK_MS = [2000, 5000, 9000, 15000, 25000];

// A hung fetch must not be able to wedge the sync: `inflight` is a wall-clock
// DEADLINE, not a boolean, so pump() can expire and retry a stuck poll. Driving
// this from setTimeout (as is idiomatic) would be self-defeating — page timers
// are the thing that doesn't fire here.
var POLL_TIMEOUT_MS = 10000;

var ticker = null;
var clockStarted = false;
var nextPollAt = 0;       // wall-clock deadline for the routine poll
var rechecks = [];        // pending wall-clock deadlines from taps
var inflightAt = 0;       // when the in-flight poll started; 0 = idle
var inflightCtrl = null;  // AbortController for that poll, when supported
var pollSeq = 0;          // generation, so an aborted poll's late rejection
                          // can't clear the guard belonging to its replacement

var VIOLET_HUE = 262;   // reserved: the coach speaking
var NUDGE_HUE = 38;     // the coach speaking LOUDER — proactive nudge keys
var SILVER_HUE = 222;   // neutral / pending

// ---- Stream Deck registration (the app calls this global) -----------------
window.connectElgatoStreamDeckSocket = function (port, pluginUUID, registerEvent) {
  ws = new WebSocket('ws://127.0.0.1:' + port);
  ws.onopen = function () {
    ws.send(JSON.stringify({ event: registerEvent, uuid: pluginUUID }));
  };
  ws.onmessage = function (msg) {
    var ev;
    try { ev = JSON.parse(msg.data); } catch (e) { return; }
    handle(ev);
  };
};

function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function setImage(context, dataUri) { send({ event: 'setImage', context: context, payload: { image: dataUri, target: 0 } }); }
function showOk(context) { send({ event: 'showOk', context: context }); }
function showAlert(context) { send({ event: 'showAlert', context: context }); }

function handle(ev) {
  var c = ev.context;
  switch (ev.event) {
    case 'willAppear':
      keys[c] = { action: ev.action, settings: (ev.payload && ev.payload.settings) || {} };
      render(c);
      startClock();
      nextPollAt = 0;              // a key just appeared — refresh on this pump
      break;
    case 'didReceiveSettings':
      if (keys[c]) { keys[c].settings = (ev.payload && ev.payload.settings) || {}; render(c); }
      break;
    case 'willDisappear':
      delete keys[c];
      break;
    case 'keyDown':
      tap(c);
      break;
    case 'systemDidWakeUp':
    case 'deviceDidConnect':
      nextPollAt = 0;              // faces are certainly stale after a wake
      break;
  }
  // Every inbound event is a free wake for the deadline check (layer 3).
  pump();
}

// ---- behavior -------------------------------------------------------------
function isSlot(k) { return k && /\.slot$/.test(k.action); }
function isHabit(k) { return k && /\.habit$/.test(k.action); }

// Stable per-habit hue derived from the name (same formula as tools/make-icons)
// so a habit keeps its color for life, across icons and live-rendered faces.
function hueFor(name) {
  // FNV-1a for spread, then skip the reserved viovar band [245,285) — violet
  // always means "the coach speaking", never a habit.
  var h = 2166136261;
  for (var i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  var hue = h % 320;
  if (hue >= 245) hue += 40;
  return hue;
}

function tap(context) {
  var k = keys[context];
  if (!k || !k.settings.base) { showAlert(context); return; }
  var s = k.settings;
  var q = isSlot(k)
    ? 'slot=' + encodeURIComponent(s.slot || 1)
    : 'hkey=' + encodeURIComponent((+s.index || 0) + 1);
  var url = s.base.replace(/\/+$/, '') + '/api/log?' + q +
    (s.key ? '&key=' + encodeURIComponent(s.key) : '');
  fetch(url)
    .then(function (r) {
      if (r.ok) {
        showOk(context);
        // The reactive coach pass runs in the background after /api/log
        // answers, so watch for the swap across a chain of deadlines.
        nextPollAt = 0;
        var now = Date.now();
        for (var i = 0; i < RECHECK_MS.length; i++) rechecks.push(now + RECHECK_MS[i]);
        pump();
      } else { showAlert(context); }
    })
    .catch(function () { showAlert(context); });
}

// ---- clock ----------------------------------------------------------------
// Both slot keys AND habit keys render from live server state.
function liveKeys() {
  var n = 0;
  for (var c in keys) { if (isSlot(keys[c]) || isHabit(keys[c])) n++; }
  return n;
}

// The same beat as ticker.js, inline. If Stream Deck serves this page from a
// file:// origin, loading a sibling worker script is an opaque-origin failure —
// and it fails ASYNCHRONOUSLY via onerror, not by throwing — so the blob form
// is the fallback that actually runs there.
function blobTicker() {
  var src = 'var t=null;self.onmessage=function(e){var m=(e.data&&e.data.every)||3000;' +
    'if(t)clearInterval(t);t=setInterval(function(){self.postMessage(Date.now());},m);};';
  return new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
}

function useTicker(w, onFail) {
  ticker = w;
  window.__ticker = w;   // tests/e2e/plugin.e2e.mjs stops the beat to prove the
                         // WebSocket wake path carries the sync on its own
  w.onmessage = function () { pump(); };
  w.onerror = function () {
    w.onerror = null;
    try { w.terminate(); } catch (e) { /* already gone */ }
    ticker = null;
    if (onFail) onFail();
  };
  w.postMessage({ every: TICK_MS });
}

function startClock() {
  if (clockStarted) return;
  clockStarted = true;
  // Layer 1: off-thread beat. Sibling script first (debuggable, cached), blob
  // second. If both fail, layers 3 and 4 still carry the sync.
  try {
    useTicker(new Worker('ticker.js'), function () {
      try { useTicker(blobTicker(), null); } catch (e) { ticker = null; }
    });
  } catch (e) {
    try { useTicker(blobTicker(), null); } catch (e2) { ticker = null; }
  }
  // Layer 4: page timer backstop. Throttled when hidden — which is the whole
  // reason the worker exists — but free, and it covers a Worker that never ran.
  setInterval(function () { pump(); }, TICK_MS);
}

// Resolve every wall-clock deadline that has come due. Safe to call as often
// as we like: nextPollAt and the single-flight guard do the rate limiting.
function pump() {
  if (!liveKeys()) return;
  var now = Date.now();
  // Expire a poll that never came back, so the layers below can retry. Without
  // this the single-flight guard would outlive the request and stall every one
  // of them — the exact staleness this file exists to prevent.
  if (inflightAt && now - inflightAt > POLL_TIMEOUT_MS) {
    if (inflightCtrl) { try { inflightCtrl.abort(); } catch (e) { /* best effort */ } }
    inflightAt = 0;
    inflightCtrl = null;
    pollSeq++;            // orphan the stuck poll: its late settle is ignored
  }
  var due = now >= nextPollAt;
  for (var i = rechecks.length - 1; i >= 0; i--) {
    if (now >= rechecks[i]) { rechecks.splice(i, 1); due = true; }
  }
  if (due) refreshSlots();
}

function refreshSlots() {
  if (inflightAt) return;
  var base = null, secret = null;
  for (var c in keys) {
    if ((isSlot(keys[c]) || isHabit(keys[c])) && keys[c].settings.base) {
      base = keys[c].settings.base;
      secret = keys[c].settings.key || null;
      break;
    }
  }
  if (!base) return;
  var mySeq = ++pollSeq;
  inflightAt = Date.now();
  nextPollAt = inflightAt + POLL_MS;
  // ?deck= marks this as the hardware plugin's poll (not the dashboard's), so
  // the server can record a heartbeat and the dashboard can show whether a
  // physical deck is actually live — see issue #5. ?key= rides along because
  // that heartbeat is a write, gated by HABIT_KEY when it's set.
  var url = base.replace(/\/+$/, '') + '/api/slots?deck=' + encodeURIComponent(VERSION) +
    '&keys=' + liveKeys() + (secret ? '&key=' + encodeURIComponent(secret) : '');
  var opts;
  if (typeof AbortController !== 'undefined') {
    inflightCtrl = new AbortController();
    opts = { signal: inflightCtrl.signal };
  }
  var settle = function () {
    if (mySeq !== pollSeq) return false;   // pump() already gave up on us
    inflightAt = 0;
    inflightCtrl = null;
    return true;
  };
  fetch(url, opts)
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!settle()) return;
      var slotsChanged = !slotCache || JSON.stringify(slotCache) !== JSON.stringify(j.slots || []);
      var habitsChanged = !habitCache || JSON.stringify(habitCache) !== JSON.stringify(j.habits || []);
      slotCache = j.slots || [];
      habitCache = j.habits || [];
      slotCacheAt = Date.now();
      for (var c in keys) {
        // One bad face must not strand the rest of the deck on stale images.
        try {
          if (slotsChanged && isSlot(keys[c])) render(c);
          if (habitsChanged && isHabit(keys[c])) render(c);
        } catch (e) { /* next poll retries this key */ }
      }
    })
    .catch(function () { settle(); /* keep last faces on hiccups */ });
}

// ---- key face rendering ---------------------------------------------------
function render(context) {
  var k = keys[context];
  if (!k) return;
  var s = k.settings;
  if (!s.base) { setImage(context, face('⚙️', 'setup', SILVER_HUE, '')); return; }
  if (isHabit(k)) {
    var idx = +s.index || 0;
    var def = habitCache ? habitCache[idx] : null;
    if (def) setImage(context, face(def.emoji || '•', def.label || def.habit, hueFor(def.name), ''));
    else if (habitCache) setImage(context, face('·', 'empty', SILVER_HUE, '', 22)); // habit removed in manager
    else setImage(context, face('⏳', '…', SILVER_HUE, '', 22)); // first poll pending
    return;
  }
  var n = parseInt(s.slot, 10) || 1;
  var def = slotCache ? slotCache[n - 1] : null;
  if (def && def.nudge) {
    // Proactive nudge: amber halo + ❗ so the poke reads across the room.
    setImage(context, face(def.emoji || '✨', def.label || def.habit, NUDGE_HUE, '❗ ' + n, 90));
  } else if (def) {
    setImage(context, face(def.emoji || '✨', def.label || def.habit, VIOLET_HUE, 'AI ' + n));
  } else {
    setImage(context, face('✨', 'Slot ' + n, SILVER_HUE, 'AI', 22));
  }
}

// Nocturne Ritual face: night base, votive halo in the key's hue, hairline
// inner ring, oversized glyph, whispered label (design/PHILOSOPHY.md).
function face(emoji, label, hue, badge, sat) {
  sat = sat === undefined ? 72 : sat;
  var S = 144;
  var cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  var ctx = cv.getContext('2d');

  var base = ctx.createLinearGradient(0, 0, 0, S);
  base.addColorStop(0, '#141827');
  base.addColorStop(1, '#0a0c13');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, S, S);

  var halo = ctx.createRadialGradient(S / 2, S * 0.36, 6, S / 2, S * 0.36, S * 0.62);
  halo.addColorStop(0, 'hsla(' + hue + ',' + sat + '%,58%,.62)');
  halo.addColorStop(0.42, 'hsla(' + hue + ',' + sat + '%,45%,.18)');
  halo.addColorStop(1, 'hsla(' + hue + ',' + sat + '%,45%,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, S, S);

  ctx.strokeStyle = 'hsla(' + hue + ',' + sat + '%,65%,.30)';
  ctx.lineWidth = 1.5;
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(6, 6, S - 12, S - 12, 17); ctx.stroke(); }

  ctx.textAlign = 'center';
  ctx.font = '62px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  ctx.fillText(emoji, S / 2, 76);

  ctx.fillStyle = '#e9edf4';
  ctx.shadowColor = 'rgba(0,0,0,.6)';
  ctx.shadowBlur = 4;
  var lbl = String(label);
  ctx.font = '600 ' + (lbl.length > 8 ? 17 : 20) + 'px "Segoe UI",Arial,sans-serif';
  ctx.fillText(lbl.slice(0, 12), S / 2, 116);
  ctx.shadowBlur = 0;

  if (badge) {
    ctx.fillStyle = 'hsla(' + hue + ',80%,80%,.9)';
    ctx.font = '700 11px "Segoe UI",Arial,sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(badge, S - 10, 18);
  }
  return cv.toDataURL('image/png');
}
