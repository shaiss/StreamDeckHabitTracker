// Habit Tracker AI — Stream Deck plugin (Node runtime).
//
// Two actions:
//  - …habit  settings: { base, index (0-based position), key? }
//  - …slot   settings: { base, slot (1-4), key? }
//
// Everything renders from live server state: one poll of <base>/api/slots
// carries both the habit list and the AI slot assignments, so habit-manager
// edits and coach swaps repaint physical keys within one poll. Taps resolve
// server-side (?hkey= / ?slot=) so history records what the key showed.
//
// This runs as an ordinary Node process (Stream Deck ≥7.1 spawns it), so
// timers are reliable — the wall-clock deadline scheduler survives from the
// HTML-runtime era because it defends against a HUNG BACKEND, not a throttled
// page: the single-flight guard expires, retries, and orphans late settles.
//
// ⚠️ Faces only repaint on keys whose profile entry carries NO baked
// States[].Image — a profile/user image beats plugin setImage in SD 7.x. The
// generator emits image-less keys for the plugin flavor for exactly this
// reason; keys show the manifest's default action images until the first
// poll paints them.
import streamDeck, { SingletonAction, action } from '@elgato/streamdeck';
import { face, hueFor } from './faces.mjs';
import { createScheduler } from './scheduler.mjs';

const POLL_MS = +(process.env.HT_POLL_MS || 15000);
const TICK_MS = +(process.env.HT_TICK_MS || 3000);
const POLL_TIMEOUT_MS = +(process.env.HT_POLL_TIMEOUT_MS || 10000);
// The coach reacts to taps in a background pass; chain rechecks so one lands
// after the swap exists.
const RECHECK_MS = (process.env.HT_RECHECK_MS || '2000,5000,9000,15000,25000').split(',').map(Number);

const VIOLET_HUE = 262;   // reserved: the coach speaking
const NUDGE_HUE = 38;     // the coach speaking LOUDER — proactive nudge keys
const SILVER_HUE = 222;   // neutral / pending

// Reported to the server (?deck=) so the dashboard can show which build a
// physical deck runs; falls back for runs outside the app.
let VERSION = '2.0.0';
try { VERSION = streamDeck.info.plugin.version || VERSION; } catch { /* no registration info */ }

const keys = new Map();   // action instance id -> { kind: 'habit'|'slot', settings, action }
let slotCache = null;     // latest slots array from the server
let habitCache = null;    // latest habit list from the server (live-editable)

const sched = createScheduler({ pollMs: POLL_MS, timeoutMs: POLL_TIMEOUT_MS, recheckMs: RECHECK_MS });
let inflightCtrl = null;
let clock = null;

const log = streamDeck.logger.createScope('habit-tracker');

// A rejected fire-and-forget send (setImage/showOk while the app's socket
// drops) must not kill the process — the old runtime's sync ws.send couldn't.
// Stream Deck would restart us, but a restart drops the poll caches and reads
// as flicker on the deck. Log it; the next poll converges.
process.on('unhandledRejection', (err) => {
  try { log.error('unhandled rejection: ' + (err && err.message ? err.message : err)); } catch { /* logger gone */ }
});

function startClock() {
  if (!clock) clock = setInterval(pump, TICK_MS);
}

// Resolve every wall-clock deadline that has come due. Safe to call as often
// as we like: the scheduler's deadlines do the rate limiting.
function pump() {
  if (keys.size === 0) return;
  const now = Date.now();
  const { expired, poll } = sched.pump(now);
  if (expired && inflightCtrl) {
    try { inflightCtrl.abort(); } catch { /* best effort */ }
    inflightCtrl = null;
  }
  if (poll) refreshSlots(now);
}

function refreshSlots(now) {
  let base = null, secret = null;
  for (const k of keys.values()) {
    if (k.settings.base) { base = k.settings.base; secret = k.settings.key || null; break; }
  }
  if (!base) return;
  const seq = sched.pollStarted(now);
  // ?deck= marks this as the hardware plugin's poll (not the dashboard's), so
  // the server records a heartbeat and /api/health can say whether a physical
  // deck is live. ?key= rides along because that heartbeat is a write, gated
  // by HABIT_KEY when it's set.
  const url = base.replace(/\/+$/, '') + '/api/slots?deck=' + encodeURIComponent(VERSION) +
    '&keys=' + keys.size + (secret ? '&key=' + encodeURIComponent(secret) : '');
  inflightCtrl = new AbortController();
  fetch(url, { signal: inflightCtrl.signal })
    .then((r) => r.json())
    .then((j) => {
      if (!sched.pollSettled(seq)) return;   // pump() already orphaned this poll
      inflightCtrl = null;
      const slots = j.slots || [];
      const habits = j.habits || [];
      const slotsChanged = !slotCache || JSON.stringify(slotCache) !== JSON.stringify(slots);
      const habitsChanged = !habitCache || JSON.stringify(habitCache) !== JSON.stringify(habits);
      slotCache = slots;
      habitCache = habits;
      for (const k of keys.values()) {
        // One bad face must not strand the rest of the deck on stale images.
        try {
          if (slotsChanged && k.kind === 'slot') render(k);
          if (habitsChanged && k.kind === 'habit') render(k);
        } catch { /* next poll retries this key */ }
      }
    })
    .catch(() => {
      if (sched.pollSettled(seq)) inflightCtrl = null;   // keep last faces on hiccups
    });
}

function render(k) {
  const s = k.settings;
  if (!s.base) { k.action.setImage(face('⚙️', 'setup', SILVER_HUE, '')); return; }
  if (k.kind === 'habit') {
    const idx = +s.index || 0;
    const def = habitCache ? habitCache[idx] : null;
    if (def) k.action.setImage(face(def.emoji || '•', def.label || def.habit, hueFor(def.name), ''));
    else if (habitCache) k.action.setImage(face('·', 'empty', SILVER_HUE, '', 22));  // removed in manager
    else k.action.setImage(face('⏳', '…', SILVER_HUE, '', 22));                     // first poll pending
    return;
  }
  const n = parseInt(s.slot, 10) || 1;
  const def = slotCache ? slotCache[n - 1] : null;
  if (def && def.nudge) {
    // Proactive nudge: amber halo + ❗ so the poke reads across the room.
    k.action.setImage(face(def.emoji || '✨', def.label || def.habit, NUDGE_HUE, '❗ ' + n, 90));
  } else if (def) {
    k.action.setImage(face(def.emoji || '✨', def.label || def.habit, VIOLET_HUE, 'AI ' + n));
  } else {
    k.action.setImage(face('✨', 'Slot ' + n, SILVER_HUE, 'AI', 22));
  }
}

function tap(k) {
  const s = k.settings;
  if (!s.base) { k.action.showAlert(); return; }
  const q = k.kind === 'slot'
    ? 'slot=' + encodeURIComponent(s.slot || 1)
    : 'hkey=' + encodeURIComponent((+s.index || 0) + 1);
  const url = s.base.replace(/\/+$/, '') + '/api/log?' + q +
    (s.key ? '&key=' + encodeURIComponent(s.key) : '');
  fetch(url)
    .then((r) => {
      if (r.ok) {
        k.action.showOk();
        sched.tapped(Date.now());   // watch for the reactive coach swap
        pump();
      } else { k.action.showAlert(); }
    })
    .catch(() => k.action.showAlert());
}

// Plain-JS equivalent of the @action decorator: apply it as a function so
// manifestId is stamped the supported way, with a belt-and-braces fallback.
function defineAction(uuid, kind) {
  const wrapped = action({ UUID: uuid })(class extends SingletonAction {});
  const inst = new (wrapped || class extends SingletonAction {})();
  if (!inst.manifestId) {
    try { inst.manifestId = uuid; } catch { Object.defineProperty(inst, 'manifestId', { value: uuid }); }
  }
  inst.onWillAppear = (ev) => {
    keys.set(ev.action.id, { kind, settings: (ev.payload && ev.payload.settings) || {}, action: ev.action });
    render(keys.get(ev.action.id));
    startClock();
    sched.forcePoll();   // a key just appeared — refresh on this pump
    pump();
  };
  inst.onDidReceiveSettings = (ev) => {
    const k = keys.get(ev.action.id);
    if (k) { k.settings = (ev.payload && ev.payload.settings) || {}; render(k); }
    pump();
  };
  inst.onWillDisappear = (ev) => { keys.delete(ev.action.id); };
  inst.onKeyDown = (ev) => {
    const k = keys.get(ev.action.id);
    if (k) tap(k); else ev.action.showAlert();
    pump();
  };
  return inst;
}

streamDeck.actions.registerAction(defineAction('com.shaiss.habit-tracker.habit', 'habit'));
streamDeck.actions.registerAction(defineAction('com.shaiss.habit-tracker.slot', 'slot'));

// System wake / device reconnect = faces are certainly stale. Guarded: these
// namespaces vary across SDK minors, and losing them only costs a faster
// refresh (the routine poll still converges).
try { streamDeck.system.onSystemDidWakeUp(() => { sched.forcePoll(); pump(); }); } catch { /* optional */ }
try { streamDeck.devices.onDeviceDidConnect(() => { sched.forcePoll(); pump(); }); } catch { /* optional */ }

await streamDeck.connect();
log.info(`habit-tracker ${VERSION} connected (poll=${POLL_MS}ms tick=${TICK_MS}ms)`);
