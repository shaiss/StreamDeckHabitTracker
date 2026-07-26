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
 */
'use strict';

var ws = null;
var keys = {};            // context -> { action, settings }
var slotCache = null;     // latest slots array from the server
var habitCache = null;    // latest habit list from the server (live-editable)
var slotCacheAt = 0;
var pollTimer = null;
var POLL_MS = 15000;
var REACT_RECHECK_MS = 9000; // the coach reacts to taps in the background;
                             // re-poll shortly after a tap to catch the swap

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
      ensurePolling();
      break;
    case 'didReceiveSettings':
      if (keys[c]) { keys[c].settings = (ev.payload && ev.payload.settings) || {}; render(c); }
      break;
    case 'willDisappear':
      delete keys[c];
      ensurePolling();
      break;
    case 'keyDown':
      tap(c);
      break;
  }
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
        refreshSlots(true);
        setTimeout(function () { refreshSlots(true); }, REACT_RECHECK_MS);
      } else { showAlert(context); }
    })
    .catch(function () { showAlert(context); });
}

function ensurePolling() {
  // Both slot keys AND habit keys render from live server state now.
  var anySlots = Object.keys(keys).some(function (c) { return isSlot(keys[c]) || isHabit(keys[c]); });
  if (anySlots && !pollTimer) {
    refreshSlots(true);
    pollTimer = setInterval(function () { refreshSlots(false); }, POLL_MS);
  } else if (!anySlots && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function refreshSlots(force) {
  var base = null;
  for (var c in keys) { if ((isSlot(keys[c]) || isHabit(keys[c])) && keys[c].settings.base) { base = keys[c].settings.base; break; } }
  if (!base) return;
  if (!force && Date.now() - slotCacheAt < POLL_MS / 2) return;
  fetch(base.replace(/\/+$/, '') + '/api/slots')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var slotsChanged = !slotCache || JSON.stringify(slotCache) !== JSON.stringify(j.slots || []);
      var habitsChanged = !habitCache || JSON.stringify(habitCache) !== JSON.stringify(j.habits || []);
      slotCache = j.slots || [];
      habitCache = j.habits || [];
      slotCacheAt = Date.now();
      for (var c in keys) {
        if (slotsChanged && isSlot(keys[c])) render(c);
        if (habitsChanged && isHabit(keys[c])) render(c);
      }
    })
    .catch(function () { /* keep last faces on network hiccups */ });
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
