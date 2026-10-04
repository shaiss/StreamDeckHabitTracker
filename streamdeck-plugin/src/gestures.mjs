// Press-gesture recognition: one physical key carries three gestures, so the
// coach gets nuance without ever asking its human to type. Tap logs, holding
// undoes, double-tapping says "that one was big" (issue #33).
//
// Two-stage Confirm (#78 / study §3.8, §4.3): a `danger` key does not emit on
// the first press. That press is an *arm* — a deck-local substate with a short
// expiry — and only a second press inside the window is the `commit`. The
// window lapsing is a silent `disarm`. None of arm/disarm is an AI-emitted
// `state` value; the coach enum stays idle|working|wait|confirming|done|blocked.
//
// Pure and deadline-driven, exactly like scheduler.mjs: the plugin feeds it
// down()/up() edges plus a tick(), and it hands back classifications. Keeping
// the timing OUT of setTimeout callbacks is what makes it unit-testable with
// plain numbers instead of fake timers — and what lets the plugin arm exactly
// one timer, at nextDeadline(), instead of running a fast poll loop.
//
// ⚠️ These three constants are pinned across issues #33, #35, and #78.
// Both features resolve presses through this one module so they cannot drift.
export const LONG_PRESS_MS = 500;
export const DOUBLE_TAP_MS = 300;
export const ARM_MS = 3000;

export function createGestures({
  longPressMs = LONG_PRESS_MS,
  doubleTapMs = DOUBLE_TAP_MS,
  armMs = ARM_MS
} = {}) {
  const state = new Map();   // key id -> { doubleTap, danger, downAt, longFired, pendingAt, armedAt }

  const st = (id) => {
    let s = state.get(id);
    if (!s) {
      s = { doubleTap: false, danger: false, downAt: 0, longFired: false, pendingAt: 0, armedAt: 0 };
      state.set(id, s);
    }
    return s;
  };

  return {
    // Keys declare which gestures they answer to. A key with NO double-tap
    // handler gets its tap on release with no deferral — that snappiness is
    // the whole reason this registration exists (nudge keys rely on it).
    // `danger` keys never defer for a double-tap: two taps ARE the confirm.
    register(id, { doubleTap = false, danger = false } = {}) {
      const s = st(id);
      s.doubleTap = danger ? false : doubleTap;
      s.danger = !!danger;
      if (!s.danger) s.armedAt = 0;
    },
    forget(id) { state.delete(id); },

    down(id, now) {
      const s = st(id);
      s.downAt = now;
      s.longFired = false;
    },

    // Release. Returns whatever this edge resolved — possibly nothing, when a
    // hold already consumed the press or a double-tap window just opened.
    up(id, now) {
      const s = st(id);
      s.downAt = 0;
      if (s.longFired) { s.longFired = false; return []; }   // the hold already fired
      if (s.danger) {
        if (s.armedAt) { s.armedAt = 0; return [{ id, gesture: 'commit' }]; }
        s.armedAt = now;
        return [{ id, gesture: 'arm' }];
      }
      if (!s.doubleTap) return [{ id, gesture: 'tap' }];
      if (s.pendingAt) { s.pendingAt = 0; return [{ id, gesture: 'doubletap' }]; }
      s.pendingAt = now;                                     // wait out the window
      return [];
    },

    // Resolve every gesture deadline that has come due. A long-press fires
    // WHILE the key is still held — the confirmation is the undo happening,
    // not the finger lifting. An armed window expiring is a silent disarm;
    // it does not fire while the finger is down, so a second press that
    // straddles the deadline still commits.
    tick(now) {
      const out = [];
      for (const [id, s] of state) {
        if (s.downAt && !s.longFired && now - s.downAt >= longPressMs) {
          s.longFired = true;
          if (s.armedAt) {
            s.armedAt = 0;
            out.push({ id, gesture: 'disarm' });
          } else {
            out.push({ id, gesture: 'longpress' });
          }
        }
        if (s.pendingAt && now - s.pendingAt >= doubleTapMs) {
          s.pendingAt = 0;
          out.push({ id, gesture: 'tap' });
        }
        if (s.armedAt && !s.downAt && now - s.armedAt >= armMs) {
          s.armedAt = 0;
          out.push({ id, gesture: 'disarm' });
        }
      }
      return out;
    },

    // Earliest instant any key is waiting on, or 0 when nothing is pending.
    nextDeadline() {
      let at = 0;
      const soonest = (t) => { at = at ? Math.min(at, t) : t; };
      for (const s of state.values()) {
        if (s.downAt && !s.longFired) soonest(s.downAt + longPressMs);
        if (s.pendingAt) soonest(s.pendingAt + doubleTapMs);
        if (s.armedAt && !s.downAt) soonest(s.armedAt + armMs);
      }
      return at;
    }
  };
}
