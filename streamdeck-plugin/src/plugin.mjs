// Habit Tracker AI — Stream Deck plugin (Node runtime).
//
// Three actions:
//  - …habit  settings: { base, index (0-based position), key? }
//  - …slot   settings: { base, slot (1-16), key? } — 1-4 render from the
//    front slots array, 5-16 from the coach page (#52)
//  - …coach  settings: { base, coachPage (default 1), key? } — a persistent
//    key with a live attention face (silent / asking / nudging); tap jumps
//    to the Coach page of the bundled profile (#53, needs #50)
//
// Generated keys also carry { page: N } so the appeared-key set derives which
// page of our profile is visible — see visibility.mjs (#53).
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
import { createGestures } from './gestures.mjs';
import { deriveVisibility } from './visibility.mjs';
// The escalation curve lives beside NUDGE_TTL_MS on the server (lib/nudge.js,
// dependency-free and unit-pinned) so the deck and the backend cannot disagree
// about how loud a nudge should be. esbuild bundles it in.
import { nudgeUrgency, urgencyStep } from '../../lib/nudge.js';
// The takeover gate (#54) lives server-adjacent for the same reason: the
// deck and the backend must not disagree about when the coach may navigate.
import { takeoverDue, RESTORE_MS, SUPPRESS_MS } from '../../lib/takeover.js';

// A key dragged straight from the action list arrives with Settings: {} —
// there is no Property Inspector, so without a compiled-in default it would
// stay a dead ⚙️ face forever (issue #55). The production origin is the same
// constant the rest of the repo already hardcodes (setup.ps1, spike, docs).
const DEFAULT_BASE = 'https://stream-deck-habit-tracker.vercel.app';
const baseOf = (s) => ((s && s.base) || DEFAULT_BASE).replace(/\/+$/, '');

const POLL_MS = +(process.env.HT_POLL_MS || 15000);
const TICK_MS = +(process.env.HT_TICK_MS || 3000);
const POLL_TIMEOUT_MS = +(process.env.HT_POLL_TIMEOUT_MS || 10000);
// The coach reacts to taps in a background pass; chain rechecks so one lands
// after the swap exists.
const RECHECK_MS = (process.env.HT_RECHECK_MS || '2000,5000,9000,15000,25000').split(',').map(Number);

const VIOLET_HUE = 262;   // reserved: the coach speaking
const NUDGE_HUE = 38;     // the coach speaking LOUDER — proactive nudge keys
const QUESTION_HUE = 300; // the coach ASKING — a linked 👍/👎 pair (#34)
const SILVER_HUE = 222;   // neutral / pending

// Reported to the server (?deck=) so the dashboard can show which build a
// physical deck runs; falls back for runs outside the app.
let VERSION = '2.5.0';
try { VERSION = streamDeck.info.plugin.version || VERSION; } catch { /* no registration info */ }

// The bundled profile's manifest name (#50) — the ONLY profile
// switchToProfile can ever reach, per the SDK: plugins "may only switch to
// profiles distributed with the plugin, as defined within the manifest".
const PROFILE_NAME = 'profiles/Habit Tracker AI';

const keys = new Map();   // action instance id -> { kind: 'habit'|'slot'|'coach', settings, action, deviceId }
let slotCache = null;     // latest slots array from the server
let coachCache = null;    // latest coach-page array (#52) — slots 5..16 render from it
let habitCache = null;    // latest habit list from the server (live-editable)
let todayCache = null;    // { habitName: {count, goal, doneToday, streak, ringFill} } (#32)

// Takeover state (#54). The pure gate is lib/takeover.js; these are its
// plugin-side inputs. Budget and kill switch are ALSO held server-side
// (habits:nudge) and re-checked at claim time — the local copies just avoid
// pointless HTTP when the answer is already no.
let consentCache = 'off';        // coachNav from the poll; off until told otherwise
let lastKeypressAt = 0;          // human-priority lock: last physical keypress
let lastPageChangeAt = 0;        // …and last page change (appeared-key churn)
let lastTakeoverDay = '';        // local memory of a spent budget
let suppressedUntilLocal = 0;    // local memory of the kill switch
let takeover = null;             // { deviceId, returnPage, timer } while we hold the glass

const localDay = (t) => {
  const d = new Date(t);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

const sched = createScheduler({ pollMs: POLL_MS, timeoutMs: POLL_TIMEOUT_MS, recheckMs: RECHECK_MS });
// Three gestures per key: tap logs, hold undoes, double-tap says "big one".
// Timings are pinned in gestures.mjs and deliberately NOT env-overridable —
// they are a shared contract with the nudge keys, not a tuning knob.
const gest = createGestures();
let inflightCtrl = null;
let clock = null;
let gestTimer = null;

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
  escalate(now);
}

// A nudge's face has to change as its TTL burns down, but the poll payload
// does NOT change while that happens — so change-detection on the payload
// would never repaint, and repainting every tick would be invisible churn.
// Repaint only when the quantized urgency step moves.
function escalate(now) {
  if (!slotCache) return;
  for (const k of keys.values()) {
    if (k.kind === 'slot' && k.isNudge) {
      const def = slotCache[(parseInt(k.settings.slot, 10) || 1) - 1];
      if (!def || !def.nudge) continue;
      if (urgencyStep(def, now) === k.urgencyStep) continue;
      try { render(k); } catch { /* next tick retries */ }
    } else if (k.kind === 'coach') {
      // The coach face mirrors the loudest live nudge, so it escalates on
      // the same quantized steps as the nudge key itself (#53).
      const def = liveNudge(now);
      if (!def || urgencyStep(def, now) === k.urgencyStep) continue;
      try { render(k); } catch { /* next tick retries */ }
    }
  }
}

// The live nudge on the FRONT page, if any — nudges never land on the coach
// page (#52), so the front array is the whole search space.
function liveNudge(now = Date.now()) {
  return (slotCache || []).find((s) => s && s.nudge && (!s.expiresAt || s.expiresAt > now)) || null;
}

// Which page of our profile is on the glass right now, and whether any of it
// is (#53). Derived purely from the appeared-key set; #54's takeover gate
// reads this — if anyVisible is false, our profile isn't on screen and
// navigation is refused.
function visibility() {
  return deriveVisibility([...keys.values()].map((k) => k.settings));
}

function refreshSlots(now) {
  // Prefer a key that names its own base (a generated profile); fall back to
  // the compiled-in default so hand-placed keys still poll (issue #55).
  let base = null, secret = null;
  for (const k of keys.values()) {
    if (k.settings.base) { base = baseOf(k.settings); secret = k.settings.key || null; break; }
  }
  if (!base) {
    if (keys.size === 0) return;
    base = DEFAULT_BASE;
  }
  const seq = sched.pollStarted(now);
  // ?deck= marks this as the hardware plugin's poll (not the dashboard's), so
  // the server records a heartbeat and /api/health can say whether a physical
  // deck is live. ?key= rides along because that heartbeat is a write, gated
  // by HABIT_KEY when it's set. ?tz= is this machine's UTC offset — the deck
  // sits next to its human, so the host timezone IS the right day boundary
  // for the `today` map (#32).
  const url = base.replace(/\/+$/, '') + '/api/slots?deck=' + encodeURIComponent(VERSION) +
    '&keys=' + keys.size + '&tz=' + new Date().getTimezoneOffset() +
    (secret ? '&key=' + encodeURIComponent(secret) : '');
  inflightCtrl = new AbortController();
  fetch(url, { signal: inflightCtrl.signal })
    .then((r) => r.json())
    .then((j) => {
      if (!sched.pollSettled(seq)) return;   // pump() already orphaned this poll
      inflightCtrl = null;
      const slots = j.slots || [];
      const coachPage = j.coachPage || [];
      const habits = j.habits || [];
      const today = j.today || {};
      consentCache = j.coachNav || 'off';   // #54: flipping consent off lands within one poll
      const slotsChanged = !slotCache || JSON.stringify(slotCache) !== JSON.stringify(slots) ||
        !coachCache || JSON.stringify(coachCache) !== JSON.stringify(coachPage);
      const habitsChanged = !habitCache || JSON.stringify(habitCache) !== JSON.stringify(habits);
      const todayChanged = !todayCache || JSON.stringify(todayCache) !== JSON.stringify(today);
      slotCache = slots;
      coachCache = coachPage;
      habitCache = habits;
      todayCache = today;
      for (const k of keys.values()) {
        // One bad face must not strand the rest of the deck on stale images.
        try {
          if (slotsChanged && (k.kind === 'slot' || k.kind === 'coach')) render(k);
          if (k.kind === 'habit' && (habitsChanged || todayChanged)) render(k);
        } catch { /* next poll retries this key */ }
      }
      maybeTakeover();   // #54: evaluated on the poll beat, never more often
    })
    .catch(() => {
      if (sched.pollSettled(seq)) inflightCtrl = null;   // keep last faces on hiccups
    });
}

// The coach key's attention face (#53): silent, asking (a live question
// pair), or nudging — mirroring the loudest thing on the front page so the
// coach has an ambient presence that consumes no slot.
function renderCoach(k) {
  const now = Date.now();
  const nudge = liveNudge(now);
  const asking = (slotCache || []).find((s) => s && s.qid && (!s.expiresAt || s.expiresAt > now));
  k.urgencyStep = nudge ? urgencyStep(nudge, now) : undefined;
  if (nudge) {
    k.action.setImage(face(nudge.emoji || '🧭', 'Coach', NUDGE_HUE, '❗', 90, { urgency: nudgeUrgency(nudge, now) }));
  } else if (asking) {
    k.action.setImage(face('🧭', 'Coach', QUESTION_HUE, '❓', 78));
  } else if (slotCache) {
    k.action.setImage(face('🧭', 'Coach', VIOLET_HUE, ''));
  } else {
    k.action.setImage(face('🧭', '…', SILVER_HUE, '', 22));   // first poll pending
  }
}

// Tap on the coach key: jump to the Coach page of the bundled profile. Only
// reachable because the profile ships in the manifest (#50); page is a
// positional index into Pages.Pages, which is why the profile is Readonly.
function coachNavigate(k) {
  const raw = parseInt(k.settings.coachPage, 10);
  const page = Number.isInteger(raw) && raw >= 0 ? raw : 1;
  if (!k.deviceId) { k.action.showAlert(); return; }
  Promise.resolve(streamDeck.profiles.switchToProfile(k.deviceId, PROFILE_NAME, page))
    .catch(() => { try { k.action.showAlert(); } catch { /* key gone */ } });
}

// --- takeover (#54) ---------------------------------------------------------
// The coach may raise its voice inside the room it is already in; it may not
// walk into another room. switchToProfile can only reach OUR bundled profile
// anyway (SDK contract), so the remaining risk is page-flipping under the
// human — which is what the gate, the server-side budget claim, and the
// auto-restore below exist to fence.

function restoreTakeover() {
  if (!takeover) return;
  const t = takeover;
  takeover = null;
  if (t.timer) clearTimeout(t.timer);
  Promise.resolve(streamDeck.profiles.switchToProfile(t.deviceId, PROFILE_NAME, t.returnPage))
    .catch(() => { /* never retry a restore into the human's hands */ });
}

function maybeTakeover() {
  if (takeover) return;                          // already holding the glass
  const now = Date.now();
  const vis = visibility();
  const gate = takeoverDue({
    now,
    hour: new Date(now).getHours(),              // host-local: the deck sits next to its human
    day: localDay(now),
    consent: consentCache,
    nudge: liveNudge(now),
    visible: vis.anyVisible,
    lastKeypressAt,
    lastPageChangeAt,
    takeoverDay: lastTakeoverDay,
    suppressedUntil: suppressedUntilLocal
  });
  if (!gate.due) return;
  if (vis.visiblePage === 0) return;             // the nudge is already on the glass
  const dev = [...keys.values()].map((k) => k.deviceId).find(Boolean);
  if (!dev) return;
  let base = DEFAULT_BASE, secret = null;
  for (const k of keys.values()) {
    if (k.settings.base) { base = baseOf(k.settings); secret = k.settings.key || null; break; }
  }
  // Claim the day's budget server-side FIRST — a refusal (budget spent on a
  // previous process, kill switch engaged) means stay silent.
  fetch(base + '/api/nudge?takeover=1' + (secret ? '&key=' + encodeURIComponent(secret) : ''), { method: 'POST' })
    .then((r) => {
      if (!r.ok) return;
      lastTakeoverDay = localDay(Date.now());
      const returnPage = vis.visiblePage == null ? 1 : vis.visiblePage;
      Promise.resolve(streamDeck.profiles.switchToProfile(dev, PROFILE_NAME, 0))
        .then(() => {
          // Auto-restore: give the page back after RESTORE_MS or on any tap
          // (see onKeyUp). Never strand someone on a page they didn't choose.
          const timer = setTimeout(restoreTakeover, RESTORE_MS);
          if (timer.unref) timer.unref();
          takeover = { deviceId: dev, returnPage, timer };
          log.info('takeover: navigated to the nudge; restoring to page ' + returnPage + ' in ' + RESTORE_MS + 'ms');
        })
        .catch(() => { /* navigation refused — nothing to restore */ });
    })
    .catch(() => { /* offline: no claim, no navigation */ });
}

// Long-press on the Coach key: the hardware kill switch (#54). Saying "not
// now" must not require a browser — 24h of takeover silence, persisted
// server-side so a plugin restart cannot forget it.
function suppressTakeovers(k) {
  const s = k.settings;
  const url = baseOf(s) + '/api/nudge?suppress=1' + (s.key ? '&key=' + encodeURIComponent(s.key) : '');
  fetch(url, { method: 'POST' })
    .then((r) => {
      if (r.ok) {
        suppressedUntilLocal = Date.now() + SUPPRESS_MS;
        restoreTakeover();                       // and give the glass back immediately
        k.action.showOk();
      } else { k.action.showAlert(); }
    })
    .catch(() => k.action.showAlert());
}

function render(k) {
  const s = k.settings;
  if (k.kind === 'coach') { renderCoach(k); return; }
  if (k.kind === 'habit') {
    const idx = +s.index || 0;
    const def = habitCache ? habitCache[idx] : null;
    if (def) {
      // Living key faces (#32): ring/dim/dots from the server's today map.
      const st = (todayCache && todayCache[def.name]) || null;
      k.action.setImage(face(def.emoji || '•', def.label || def.habit, hueFor(def.name), '', undefined, st));
    }
    else if (habitCache) k.action.setImage(face('·', 'empty', SILVER_HUE, '', 22));  // removed in manager
    else k.action.setImage(face('⏳', '…', SILVER_HUE, '', 22));                     // first poll pending
    return;
  }
  // One integer namespace across pages (#52): 1..4 are the front keys,
  // 5..16 index the coach page at n-5. Taps stay ?slot=n either way —
  // the server owns the same split.
  const n = parseInt(s.slot, 10) || 1;
  const def = n <= 4
    ? (slotCache ? slotCache[n - 1] : null)
    : (coachCache ? coachCache[n - 5] : null);
  // Nudges and questions both answer a hold with a refusal rather than an undo,
  // and neither registers a double-tap: a poke and an answer are single,
  // immediate acts, so their taps stay instant on release (#35, #34).
  const was = [k.isNudge, k.isQuestion];
  k.isNudge = !!(def && def.nudge);
  k.isQuestion = !!(def && def.qid);
  if (was[0] !== k.isNudge || was[1] !== k.isQuestion) {
    gest.register(k.action.id, { doubleTap: !k.isNudge && !k.isQuestion });
  }
  if (def && def.qid) {
    // One half of a 👍/👎 pair. Both halves share a hue so they read as one
    // question rather than two unrelated asks.
    k.action.setImage(face(def.emoji || '❓', def.label || def.habit, QUESTION_HUE, '❓ ' + n, 78));
  } else if (def && def.nudge) {
    // Proactive nudge: amber halo + ❗ so the poke reads across the room, and
    // it brightens as its TTL runs down.
    k.urgencyStep = urgencyStep(def);
    k.action.setImage(face(def.emoji || '✨', def.label || def.habit, NUDGE_HUE, '❗ ' + n, 90,
      { urgency: nudgeUrgency(def) }));
  } else if (def) {
    k.action.setImage(face(def.emoji || '✨', def.label || def.habit, VIOLET_HUE, 'AI ' + n));
  } else {
    k.action.setImage(face('✨', 'Slot ' + n, SILVER_HUE, 'AI', 22));
  }
}

// Which row on the server this key stands for. The key never names a habit —
// ?hkey=/?slot= resolve at tap time so history records what the key showed.
function logUrl(k, extra = '') {
  const s = k.settings;
  const q = k.kind === 'slot'
    ? 'slot=' + encodeURIComponent(s.slot || 1)
    : 'hkey=' + encodeURIComponent((+s.index || 0) + 1);
  return baseOf(s) + '/api/log?' + q + extra +
    (s.key ? '&key=' + encodeURIComponent(s.key) : '');
}

function tap(k, { intensity = '' } = {}) {
  fetch(logUrl(k, intensity ? '&intensity=' + encodeURIComponent(intensity) : ''))
    .then((r) => {
      if (r.ok) {
        k.action.showOk();
        sched.tapped(Date.now());   // watch for the reactive coach swap
        pump();
      } else { k.action.showAlert(); }
    })
    .catch(() => k.action.showAlert());
}

// Long-press: take back the last log for this key today. There is no
// confirmation dialog on purpose — the hold IS the confirmation, and the ⚠️
// flash when there was nothing to remove is the only "are you sure" a key can
// honestly offer.
function undo(k) {
  fetch(logUrl(k), { method: 'DELETE' })
    .then((r) => {
      if (r.ok) {
        k.action.showOk();
        sched.tapped(Date.now());   // the ring/streak face is now stale
        pump();
      } else { k.action.showAlert(); }
    })
    .catch(() => k.action.showAlert());
}

// Long-press on a NUDGE means "not today" — an explicit dismissal, which the
// scorer records as something other than never having noticed it (#35). The
// key is a poke, not a log, so there is nothing to undo here.
function dismissNudge(k) {
  const s = k.settings;
  const url = baseOf(s) + '/api/nudge?dismiss=1&slot=' +
    encodeURIComponent(s.slot || 1) + (s.key ? '&key=' + encodeURIComponent(s.key) : '');
  fetch(url, { method: 'POST' })
    .then((r) => {
      if (r.ok) {
        k.action.showOk();
        sched.forcePoll();   // the slot is empty now — repaint on this pump
        pump();
      } else { k.action.showAlert(); }
    })
    .catch(() => k.action.showAlert());
}

// Long-press on a QUESTION key means "I'm not answering that" — recorded as a
// refusal, which the coach must be able to tell apart from a question that
// simply lapsed unseen. Either half of the pair dismisses the whole thing.
function dismissQuestion(k) {
  const s = k.settings;
  const url = baseOf(s) + '/api/question?dismiss=1&slot=' +
    encodeURIComponent(s.slot || 1) + (s.key ? '&key=' + encodeURIComponent(s.key) : '');
  fetch(url, { method: 'POST' })
    .then((r) => {
      if (r.ok) {
        k.action.showOk();
        sched.forcePoll();   // both halves are gone now — repaint this pump
        pump();
      } else { k.action.showAlert(); }
    })
    .catch(() => k.action.showAlert());
}

function dispatch({ id, gesture }) {
  const k = keys.get(id);
  if (!k) return;                                  // key vanished mid-gesture
  if (k.kind === 'coach') {
    // The coach key logs nothing. Tap navigates (#53); long-press is the
    // hardware kill switch — 24h of takeover silence (#54).
    if (gesture === 'longpress') suppressTakeovers(k);
    else coachNavigate(k);
    return;
  }
  if (gesture === 'longpress') {
    if (k.isQuestion) dismissQuestion(k);
    else if (k.isNudge) dismissNudge(k);
    else undo(k);
  } else if (gesture === 'doubletap') tap(k, { intensity: 'high' });
  else tap(k);
}

// One timer, armed for the single soonest gesture deadline — a 3s pump could
// never resolve a 500ms hold, and a dedicated fast interval would burn CPU
// whenever nobody is touching the deck.
function armGestures() {
  if (gestTimer) { clearTimeout(gestTimer); gestTimer = null; }
  const at = gest.nextDeadline();
  if (!at) return;
  gestTimer = setTimeout(() => {
    gestTimer = null;
    for (const g of gest.tick(Date.now())) dispatch(g);
    armGestures();                                 // a hold may still be held
  }, Math.max(0, at - Date.now()));
  if (gestTimer.unref) gestTimer.unref();          // never hold the process open
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
    keys.set(ev.action.id, {
      kind,
      settings: (ev.payload && ev.payload.settings) || {},
      action: ev.action,
      // switchToProfile needs the device (#53); the SDK stamps it on the action.
      deviceId: (ev.action.device && ev.action.device.id) || undefined
    });
    // Habit and slot keys both log something undoable and quantifiable, so
    // both answer to all three gestures. The coach key logs nothing — a
    // double-tap would only defer its single meaning (navigate).
    gest.register(ev.action.id, { doubleTap: kind !== 'coach' });
    lastPageChangeAt = Date.now();   // page churn = the human (or we) moved (#54)
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
  inst.onWillDisappear = (ev) => {
    keys.delete(ev.action.id);
    gest.forget(ev.action.id);
    lastPageChangeAt = Date.now();   // (#54)
  };
  // Both edges now matter: keyDown starts the hold clock, keyUp resolves the
  // press. ⚠️ Behavior change from the tap-on-keyDown era — a plain tap on a
  // double-tap key now lands DOUBLE_TAP_MS after release. That deferral is the
  // price of clean double-tap detection, and it is why keys that don't need it
  // (nudges) register without it.
  inst.onKeyDown = (ev) => {
    if (!keys.has(ev.action.id)) { ev.action.showAlert(); return; }
    lastKeypressAt = Date.now();     // human-priority lock input (#54)
    gest.down(ev.action.id, Date.now());
    armGestures();
  };
  inst.onKeyUp = (ev) => {
    if (!keys.has(ev.action.id)) return;
    // Any tap ends a takeover hold (#54): the human is present and acting,
    // so give the page back before their gesture resolves.
    if (takeover) restoreTakeover();
    for (const g of gest.up(ev.action.id, Date.now())) dispatch(g);
    armGestures();
  };
  return inst;
}

streamDeck.actions.registerAction(defineAction('com.shaiss.habit-tracker.habit', 'habit'));
streamDeck.actions.registerAction(defineAction('com.shaiss.habit-tracker.slot', 'slot'));
streamDeck.actions.registerAction(defineAction('com.shaiss.habit-tracker.coach', 'coach'));

// System wake / device reconnect = faces are certainly stale. Guarded: these
// namespaces vary across SDK minors, and losing them only costs a faster
// refresh (the routine poll still converges).
try { streamDeck.system.onSystemDidWakeUp(() => { sched.forcePoll(); pump(); }); } catch { /* optional */ }
try { streamDeck.devices.onDeviceDidConnect(() => { sched.forcePoll(); pump(); }); } catch { /* optional */ }

await streamDeck.connect();
log.info(`habit-tracker ${VERSION} connected (poll=${POLL_MS}ms tick=${TICK_MS}ms)`);
