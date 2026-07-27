// Press-gesture recognition: one physical key carries three gestures, so the
// coach gets nuance without ever asking its human to type. Tap logs, holding
// undoes, double-tapping says "that one was big" (issue #33).
//
// Pure and deadline-driven, exactly like scheduler.mjs: the plugin feeds it
// down()/up() edges plus a tick(), and it hands back classifications. Keeping
// the timing OUT of setTimeout callbacks is what makes it unit-testable with
// plain numbers instead of fake timers — and what lets the plugin arm exactly
// one timer, at nextDeadline(), instead of running a fast poll loop.
//
// ⚠️ These two constants are pinned across issues #33 and #35 by agreement.
// Both features resolve presses through this one module so they cannot drift.
export const LONG_PRESS_MS = 500;
export const DOUBLE_TAP_MS = 300;

export function createGestures({ longPressMs = LONG_PRESS_MS, doubleTapMs = DOUBLE_TAP_MS } = {}) {
  const state = new Map();   // key id -> { doubleTap, downAt, longFired, pendingAt }

  const st = (id) => {
    let s = state.get(id);
    if (!s) {
      s = { doubleTap: false, downAt: 0, longFired: false, pendingAt: 0 };
      state.set(id, s);
    }
    return s;
  };

  return {
    // Keys declare which gestures they answer to. A key with NO double-tap
    // handler gets its tap on release with no deferral — that snappiness is
    // the whole reason this registration exists (nudge keys rely on it).
    register(id, { doubleTap = false } = {}) { st(id).doubleTap = doubleTap; },
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
      if (!s.doubleTap) return [{ id, gesture: 'tap' }];
      if (s.pendingAt) { s.pendingAt = 0; return [{ id, gesture: 'doubletap' }]; }
      s.pendingAt = now;                                     // wait out the window
      return [];
    },

    // Resolve every gesture deadline that has come due. A long-press fires
    // WHILE the key is still held — the confirmation is the undo happening,
    // not the finger lifting.
    tick(now) {
      const out = [];
      for (const [id, s] of state) {
        if (s.downAt && !s.longFired && now - s.downAt >= longPressMs) {
          s.longFired = true;
          out.push({ id, gesture: 'longpress' });
        }
        if (s.pendingAt && now - s.pendingAt >= doubleTapMs) {
          s.pendingAt = 0;
          out.push({ id, gesture: 'tap' });
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
      }
      return at;
    }
  };
}
