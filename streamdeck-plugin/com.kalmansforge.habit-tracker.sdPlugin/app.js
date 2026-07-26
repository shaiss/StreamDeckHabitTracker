/* Habit Tracker AI — Stream Deck plugin.
 *
 * Two actions:
 *  - ...habit  settings: { base, habit, emoji, label, c1, c2, key? }
 *  - ...slot   settings: { base, slot (1-4), key? }
 *
 * Habit keys render a static face from their settings. Slot keys poll
 * <base>/api/slots and repaint whenever the AI coach swaps assignments.
 * keyDown fires <base>/api/log and flashes the built-in OK/alert overlay.
 */
'use strict';

var ws = null;
var keys = {};            // context -> { action, settings }
var slotCache = null;     // latest slots array from the server
var slotCacheAt = 0;
var pollTimer = null;
var POLL_MS = 20000;

var SLOT_COLORS = ['#8b5cf6', '#5b21b6'];   // violet — the AI's color
var SETUP_COLORS = ['#6b7280', '#374151'];

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

function tap(context) {
  var k = keys[context];
  if (!k || !k.settings.base) { showAlert(context); return; }
  var s = k.settings;
  var url = s.base.replace(/\/+$/, '') + '/api/log?' +
    (isSlot(k) ? 'slot=' + encodeURIComponent(s.slot || 1) : 'habit=' + encodeURIComponent(s.habit || '')) +
    (s.key ? '&key=' + encodeURIComponent(s.key) : '');
  fetch(url)
    .then(function (r) {
      if (r.ok) { showOk(context); refreshSlots(true); }
      else { showAlert(context); }
    })
    .catch(function () { showAlert(context); });
}

function ensurePolling() {
  var anySlots = Object.keys(keys).some(function (c) { return isSlot(keys[c]); });
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
  for (var c in keys) { if (isSlot(keys[c]) && keys[c].settings.base) { base = keys[c].settings.base; break; } }
  if (!base) return;
  if (!force && Date.now() - slotCacheAt < POLL_MS / 2) return;
  fetch(base.replace(/\/+$/, '') + '/api/slots')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var next = JSON.stringify(j.slots || []);
      var changed = !slotCache || JSON.stringify(slotCache) !== next;
      slotCache = j.slots || [];
      slotCacheAt = Date.now();
      if (changed) {
        for (var c in keys) if (isSlot(keys[c])) render(c);
      }
    })
    .catch(function () { /* keep last faces on network hiccups */ });
}

// ---- key face rendering ---------------------------------------------------
function render(context) {
  var k = keys[context];
  if (!k) return;
  var s = k.settings;
  if (!s.base) { setImage(context, face('⚙️', 'setup', SETUP_COLORS, '')); return; }
  if (!isSlot(k)) {
    setImage(context, face(s.emoji || '•', s.label || s.habit || '?', [s.c1 || '#6b7280', s.c2 || '#374151'], ''));
    return;
  }
  var n = parseInt(s.slot, 10) || 1;
  var def = slotCache ? slotCache[n - 1] : null;
  if (def) {
    setImage(context, face(def.emoji || '✨', def.label || def.habit, SLOT_COLORS, 'AI ' + n));
  } else {
    setImage(context, face('✨', 'Slot ' + n, SETUP_COLORS, 'AI'));
  }
}

function face(emoji, label, colors, badge) {
  var S = 144;
  var cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  var ctx = cv.getContext('2d');

  var g = ctx.createRadialGradient(S / 2, S * 0.33, 10, S / 2, S * 0.45, S * 0.9);
  g.addColorStop(0, colors[0]);
  g.addColorStop(1, colors[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  ctx.textAlign = 'center';
  ctx.font = '64px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  ctx.fillText(emoji, S / 2, 78);

  ctx.fillStyle = '#fff';
  ctx.shadowColor = 'rgba(0,0,0,.55)';
  ctx.shadowBlur = 4;
  var lbl = String(label);
  ctx.font = '700 ' + (lbl.length > 8 ? 18 : 22) + 'px "Segoe UI",Arial,sans-serif';
  ctx.fillText(lbl.slice(0, 12), S / 2, 118);
  ctx.shadowBlur = 0;

  if (badge) {
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.font = '700 12px "Segoe UI",Arial,sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(badge, S - 7, 16);
  }
  return cv.toDataURL('image/png');
}
