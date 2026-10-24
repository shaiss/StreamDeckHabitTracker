    import { questionPaint, isDetailsKey } from '/glyphs.js';
    import { esc } from '/escape.js';
    // Writes carry x-habit-key (HabitKey) and Clerk Bearer (HabitAuth via
    // HabitKey's transport). strip-key.js moves a stray ?key= into
    // sessionStorage; habit-key.js repeats that scrub.
    const keyed = (url, init) => window.HabitKey.fetch(url, init);
    async function gateAuth() {
      if (!window.HabitAuth) return true; // tests without auth.js
      const ok = await window.HabitAuth.ensureSignedIn();
      if (!ok) {
        const hintEl = document.getElementById('hint');
        if (hintEl) hintEl.innerHTML = '<b>Sign in</b> to log habits on the virtual deck.';
      }
      return ok;
    }
    const face = document.getElementById('face');
    const hint = document.getElementById('hint');
    let slots = [null, null, null, null];
    let coachPage = [];
    let rosterPending = 0;
    let beaconBlocked = false;
    let habits = [];
    let today = {};   // habitName -> {count, goal, doneToday, streak, ringFill} (#32)
    let built = false;

    // 5x3 grid mirroring the generated MK.2 profile:
    // row 0: habits; row 1: Stats + AI slots 1-4; row 2: unlit.
    function build() {
      face.innerHTML = '';
      habits.forEach((h, i) => {
        const el = keyEl({
          img: '/icons/animated/' + h.name + '.gif',
          title: h.emoji + ' ' + h.label + ' — tap to log, hold to undo, double-tap for a big one',
          onTap: (e2) => tap(e2, '/api/log?hkey=' + (i + 1)),
          onDouble: (e2) => tap(e2, '/api/log?hkey=' + (i + 1) + '&intensity=high'),
          onLong: (e2) => undo(e2, '/api/log?hkey=' + (i + 1))
        });
        el.dataset.habit = i;          // position index, for paintHabits()
        el.dataset.hname = h.name;     // identity for today-state lookup
        // New habits (added via the manager) have no baked icon yet — draw a
        // CSS face with the emoji + label instead of a broken image. (Living
        // key faces repaint these with state too — see paintHabits().)
        el.querySelector('img')?.addEventListener('error', () => {
          el.innerHTML = habitStateHtml(h, today[h.name] || null);
        });
        face.appendChild(el);
      });
      face.appendChild(keyEl({
        img: '/icons/animated/_dashboard.gif',
        title: '📊 Stats — open dashboard',
        onTap: () => { window.open('/', '_blank'); }
      }));
      for (let n = 1; n <= 4; n++) {
        const el = keyEl({
          title: 'AI slot ' + n,
          onTap: (e2) => commitSlot(e2, n),
          onDouble: (e2) => commitSlot(e2, n, '&intensity=high'),
          // Nudge-ness is decided by the server and can flip between polls, so
          // resolve it at press time, not when the key was built: a hold on a
          // nudge means "not today", on a suggestion it means undo (#35).
          onLong: (e2) => {
            const d = slots[n - 1];
            if (d && d.qid) return dismiss(e2, '/api/question?dismiss=1&slot=' + n, 'Not answering that.');
            if (d && d.nudge) return dismiss(e2, '/api/nudge?dismiss=1&slot=' + n, 'Dismissed — not today.');
            return undo(e2, '/api/log?slot=' + n);
          }
        });
        el.dataset.slot = n;
        face.appendChild(el);
      }
      // Attention Beacon (#75): the page-0 coach key. Faces only — a press
      // never logs, dismisses, or answers. Hardware drills to the Coach page;
      // here the signpost is a hint (this preview is a single page).
      const beacon = keyEl({
        title: 'Coach beacon — tap for context (never logs)',
        onTap: (e2) => {
          const b = beaconOf({ slots, coachPage, rosterPending, blocked: beaconBlocked });
          hint.innerHTML = b.blocked
            ? '<b>Coach blocked</b> — something hard-stopped. Check the AI keys or habit manager. Nothing was logged.'
            : (b.pending
              ? '<b>Coach needs you</b> — ' + b.pending + ' pending. The AI keys and habit manager hold the decisions; this key is a signpost.'
              : '<b>Coach is quiet</b> — nothing pending.');
        }
      });
      beacon.dataset.beacon = '1';
      face.appendChild(beacon);
      const used = habits.length + 1 + 4 + 1; // habits + stats + AI slots + beacon
      for (let i = 0; i < Math.max(0, 15 - used); i++) {
        const off = document.createElement('button');
        off.className = 'k off'; off.disabled = true; off.tabIndex = -1;
        off.innerHTML = '<span class="glass"></span>';
        face.appendChild(off);
      }
      built = true;
      paintSlots();
    }

    // Gesture parity with the physical deck (#33): tap logs, hold undoes,
    // double-tap says "big one". Mirrors streamdeck-plugin/src/gestures.mjs —
    // tests/unit/gestures.test.mjs guards these two copies against drifting.
    const LONG_PRESS_MS = 500, DOUBLE_TAP_MS = 300, ARM_MS = 3000;

    function bindGestures(b, { onTap, onLong, onDouble }) {
      let longTimer = null, pendingTimer = null, longFired = false, ptr = null;
      const stop = (t) => { if (t) clearTimeout(t); return null; };
      // Immediate press feedback — without this, double-tap keys sit dead for
      // DOUBLE_TAP_MS after lift before tap() paints .pressed, so a phone tap
      // feels like a miss and the second attempt becomes a double-tap.
      const endDown = () => {
        longTimer = stop(longTimer);
        b.classList.remove('pressed');
        if (ptr != null) {
          try { b.releasePointerCapture(ptr); } catch (_) {}
          ptr = null;
        }
      };
      b.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (ptr != null) return;
        ptr = e.pointerId;
        // Keep pointerup on this key even if the finger drifts a few px —
        // otherwise mobile Safari cancels the press and the tap never fires.
        try { b.setPointerCapture(e.pointerId); } catch (_) {}
        longFired = false;
        b.classList.add('pressed');
        longTimer = stop(longTimer);
        if (!onLong) return;
        longTimer = setTimeout(() => {
          longTimer = null; longFired = true;
          pendingTimer = stop(pendingTimer);   // a hold outranks a waiting tap
          onLong(b);
        }, LONG_PRESS_MS);
      });
      b.addEventListener('pointerup', (e) => {
        if (ptr !== e.pointerId) return;
        const held = longFired;
        endDown();
        if (held) { longFired = false; return; }   // the hold already acted
        // Danger keys (#78) resolve on release: two taps ARE the confirm, so
        // there is no double-tap window to wait out (and press 1 must arm now).
        if (b.dataset.danger === '1' || !onDouble) { onTap && onTap(b); return; }
        if (pendingTimer) { pendingTimer = stop(pendingTimer); onDouble(b); return; }
        pendingTimer = setTimeout(() => { pendingTimer = null; onTap && onTap(b); }, DOUBLE_TAP_MS);
      });
      b.addEventListener('pointercancel', (e) => {
        if (ptr !== e.pointerId) return;
        longFired = false;
        endDown();
      });
      // If capture is yanked without up/cancel (OS interruption), do not leave
      // ptr wedged — later presses would no-op forever on that key.
      b.addEventListener('lostpointercapture', (e) => {
        if (ptr !== e.pointerId) return;
        longFired = false;
        longTimer = stop(longTimer);
        b.classList.remove('pressed');
        ptr = null;
      });
      // A touch long-press would otherwise raise the OS context menu on top of
      // the undo we just performed.
      b.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    function keyEl({ img, title, onTap, onLong, onDouble }) {
      const b = document.createElement('button');
      b.className = 'k'; b.title = title || '';
      if (img) b.innerHTML = '<img src="' + esc(img) + '" alt="">';
      b.innerHTML += '<span class="glass"></span><span class="flash"></span>';
      bindGestures(b, { onTap, onLong, onDouble });
      return b;
    }

    // Same 0..1 curve as lib/nudge.js nudgeUrgency() — see the drift guard in
    // tests/unit/nudge.test.mjs.
    function urgencyOf(def) {
      if (!def || !def.nudge || !def.expiresAt || !def.assignedAt) return 0;
      const span = def.expiresAt - def.assignedAt;
      if (span <= 0) return 0;
      return Math.max(0, Math.min(1, (Date.now() - def.assignedAt) / span));
    }

    function waitPeriodMs(urg) {
      urg = Math.max(0, Math.min(1, +urg || 0));
      if (urg >= 2 / 3) return 600;
      if (urg >= 1 / 3) return 1000;
      return 3000;
    }

    function owedFrame(def, now) {
      now = now || Date.now();
      if (!def) return null;
      if (def.expiresAt && def.expiresAt <= now) return null;
      if (def.qid || def.nudge) return 'wait';
      return null;
    }

    function slotFaceHtml(def, n, pressFrame, armed) {
      if (armed) {
        const frame = resolveFrame({ frame: pressFrame }) || owedFrame(def);
        return '<span class="facecss ' + (def && def.qid ? 'qface' : def && def.nudge ? 'nudgeface' : 'slotface') + '">' +
          stateFrameHtml(frame) +
          '<span class="em em-tint-danger">⚠</span>' +
          '<span class="lb mono lb-tint-danger">CONFIRM?</span></span>' +
          '<span class="glass"></span><span class="flash"></span>';
      }
      if (def) {
        const paint = def.qid ? questionPaint(def) : null;
        const cls = def.qid ? 'qface' : def.nudge ? 'nudgeface' : 'slotface';
        const badge = paint ? paint.badge : (def.nudge ? '❗ ' + n : 'AI ' + n);
        const frame = resolveFrame({ frame: pressFrame }) || owedFrame(def);
        const parts = [];
        if (def.nudge) {
          const urg = urgencyOf(def);
          parts.push('--urg:' + urg.toFixed(3));
          parts.push('--hue:' + hueFor(def.habit || def.label || ''));
          parts.push('--wait-ms:' + waitPeriodMs(urg));
        }
        const style = parts.length ? ' style="' + parts.join(';') + '"' : '';
        const danger = !!def.danger && !paint;
        const tint = paint && paint.glyphTint ? paint.glyphTint : (danger ? 'danger' : '');
        const emCls = tint ? ' em-tint-' + tint : '';
        const lbCls = (paint || danger) ? ' mono' : '';
        const lbTint = danger ? ' lb-tint-danger' : '';
        const glyph = paint ? paint.glyph : def.emoji;
        const label = paint ? paint.label : (def.label || def.habit);
        return '<span class="facecss ' + cls + '"' + style + '>' + stateFrameHtml(frame) +
          (badge ? '<span class="badge">' + esc(badge) + '</span>' : '') +
          '<span class="em' + emCls + '">' + esc(glyph) + '</span>' +
          '<span class="lb' + lbCls + lbTint + '">' + esc(label) + '</span></span>' +
          '<span class="glass"></span><span class="flash"></span>';
      }
      return '<span class="facecss emptyface"><span class="badge">AI</span>' +
        '<span class="em">✨</span><span class="lb">Slot ' + n + '</span></span>' +
        '<span class="glass"></span><span class="flash"></span>';
    }

    // Attention Beacon (#75). Same rules as lib/beacon.js — drift-guarded in
    // tests/unit/beacon.test.mjs. No import: this page has no build step.
    function liveSlot(s, now) {
      return !!(s && (!s.expiresAt || s.expiresAt > now));
    }
    function beaconOf(poll, now) {
      now = now || Date.now();
      const list = [].concat(poll.slots || [], poll.coachPage || []);
      let pending = 0;
      const qids = new Set();
      let blocked = !!poll.blocked;
      for (const s of list) {
        if (!liveSlot(s, now)) continue;
        if (s.nudge) pending += 1;
        if (s.qid) qids.add(s.qid);
        if (s.blocked) blocked = true;
      }
      pending += qids.size;
      const roster = poll.rosterPending != null
        ? (+poll.rosterPending || 0)
        : ((poll.roster && poll.roster.proposals && poll.roster.proposals.length) || 0);
      pending += Math.max(0, roster);
      const frame = blocked ? 'blocked' : pending > 0 ? 'wait' : 'idle';
      return { pending, blocked, frame, badge: pending > 0 ? String(pending) : '' };
    }

    // Opt-in turn-state frame (#74). Same alias as faces.mjs resolveFrame
    // (`frame` or `frameState`). Absent / unknown → no element, same as today.
    function resolveFrame(src) {
      if (!src) return null;
      const f = src.frame ?? src.frameState ?? null;
      if (!f || !/^(idle|working|wait|success|blocked)$/.test(f)) return null;
      return f;
    }
    function stateFrameHtml(frame) {
      if (!frame) return '';
      return '<span class="stateframe frame-' + frame + '"></span>';
    }

    // Same FNV-1a → hue as the plugin (hueFor in app.js) and tools/make-icons:
    // a habit keeps its color for life, across icons and live-rendered faces.
    function hueFor(name) {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      let hue = h % 320; if (hue >= 245) hue += 40; return hue;
    }

    // Living key faces (#32): habit key as a CSS face carrying today's state.
    // Parity with the plugin's canvas face() — streak ring, dim-when-done + ✓,
    // count dots (or a number when goal > 8). The virtual deck swaps a habit's
    // GIF for this face on first repaint so it stays an honest preview of the
    // physical deck (whose canvas faces are static).
    function habitStateHtml(def, st) {
      const hue = hueFor(def.name);
      const done = st && st.doneToday;
      const goal = (st && st.goal) || 1;
      const pct = st ? Math.min(100, Math.round((st.ringFill || 0) * 100)) : 0;
      // Same rounded-rect path as the plugin's faces.mjs, authored from
      // top-center clockwise so the fill grows from the top. pathLength="100"
      // normalizes the perimeter to the percent above.
      const framePath = 'M72 6 H121 A17 17 0 0 1 138 23 V121 A17 17 0 0 1 121 138 '
        + 'H23 A17 17 0 0 1 6 121 V23 A17 17 0 0 1 23 6 Z';
      let extras = '<svg class="ring" viewBox="0 0 144 144" preserveAspectRatio="none">'
        + '<path class="track" d="' + framePath + '"/>'
        + (pct > 0 ? '<path class="fill" pathLength="100" style="--ring-pct:' + pct + '" d="' + framePath + '"/>' : '')
        + '</svg>';
      if (done) extras += '<span class="check">✓</span>';
      if (goal > 1 && st && typeof st.count === 'number') {
        if (goal > 8) {
          extras += '<span class="count">' + st.count + '</span>';
        } else {
          let dots = '';
          for (let i = 0; i < goal; i++) dots += '<span class="' + (i < st.count ? 'on' : '') + '"></span>';
          extras += '<span class="dots">' + dots + '</span>';
        }
      }
      return '<span class="facecss habitface ' + (done ? 'dim' : '') + '" style="--hue:' + hue + '">' +
        stateFrameHtml(resolveFrame(st)) + extras + '<span class="em">' + esc(def.emoji || '•') + '</span>' +
        '<span class="lb">' + esc(def.label || def.name) + '</span></span>' +
        '<span class="glass"></span><span class="flash"></span>';
    }

    function paintHabits() {
      if (!built) return;
      document.querySelectorAll('.k[data-habit]').forEach((el) => {
        const i = +el.dataset.habit;
        const def = habits[i];
        if (!def) return;
        el.innerHTML = habitStateHtml(def, today[def.name] || null);
      });
    }

    function paintSlots() {
      if (!built) return;
      document.querySelectorAll('.k[data-slot]').forEach((el) => {
        const n = +el.dataset.slot;
        const def = slots[n - 1];
        const qid = (def && def.qid) || '';
        if (el.dataset.settledQid && el.dataset.settledQid !== qid) {
          delete el.dataset.pressFrame;
          delete el.dataset.settledQid;
        }
        if (def && def.danger) el.dataset.danger = '1';
        else delete el.dataset.danger;
        el.innerHTML = slotFaceHtml(def, n, el.dataset.pressFrame || null, el.dataset.armed === '1');
        el.title = def
          ? (def.qid ? (def.question || '') + '  → ' + (questionPaint(def).label) : def.emoji + ' ' + def.label + ' — ' + (def.reason || ''))
          : ('AI slot ' + n + ' — empty');
      });
      paintBeacon();
    }

    function paintBeacon() {
      const el = document.querySelector('.k[data-beacon]');
      if (!el) return;
      const b = beaconOf({ slots, coachPage, rosterPending, blocked: beaconBlocked });
      const badge = b.badge ? '<span class="badge">' + esc(b.badge) + '</span>' : '';
      // Interior is always coachface (violet 🧭). Frame class does idle/wait/blocked.
      el.innerHTML = '<span class="facecss coachface">' + stateFrameHtml(b.frame) + badge +
        '<span class="em">🧭</span><span class="lb">Coach</span></span>' +
        '<span class="glass"></span><span class="flash"></span>';
      el.title = b.blocked
        ? 'Coach blocked — tap for context (does not decide)'
        : (b.pending ? b.pending + ' pending — tap for context (does not decide)' : 'Coach quiet');
    }

    function settleQuestionSiblings(pressedN, qid) {
      document.querySelectorAll('.k[data-slot]').forEach((el) => {
        const i = +el.dataset.slot;
        if (i === pressedN) return;
        const d = slots[i - 1];
        if (d && d.qid === qid) {
          el.dataset.pressFrame = 'idle';
          el.dataset.settledQid = qid;
        }
      });
      paintSlots();
    }

    const armTimers = new WeakMap();
    function armThenCommit(el, go) {
      if (el.dataset.armed === '1') {
        const t = armTimers.get(el);
        if (t) clearTimeout(t);
        armTimers.delete(el);
        delete el.dataset.armed;
        go();
        return;
      }
      el.dataset.armed = '1';
      paintSlots();
      const t = setTimeout(() => {
        if (el.dataset.armed !== '1') return;
        delete el.dataset.armed;
        armTimers.delete(el);
        paintSlots();
      }, ARM_MS);
      armTimers.set(el, t);
    }

    // Every slot gesture that would log goes through here so DETAILS cannot
    // spend a question via tap, double-tap, or any future handler (#77).
    function commitSlot(e2, n, extra = '') {
      const d = slots[n - 1];
      if (d && d.danger) {
        armThenCommit(e2, () => emitSlot(e2, n, extra));
        return;
      }
      emitSlot(e2, n, extra);
    }

    function emitSlot(e2, n, extra = '') {
      const d = slots[n - 1];
      if (d && d.qid && isDetailsKey(d)) {
        hint.innerHTML = '<b>' + esc(d.question || 'Details') + '</b>';
        return;
      }
      if (d && d.qid) playAskAck(e2);
      if (d && d.qid) settleQuestionSiblings(n, d.qid);
      tap(e2, '/api/log?slot=' + n + extra);
    }

    function playAskAck(el) {
      const go = (frame, ms, done) => {
        el.dataset.pressFrame = frame;
        paintSlots();
        setTimeout(() => {
          if (done) { delete el.dataset.pressFrame; paintSlots(); }
          else go('success', 1600, true);
        }, ms);
      };
      go('working', 280, false);
    }

    function flash(el, ok) {
      const f = el.querySelector('.flash');
      if (!f) return;
      f.textContent = ok ? '✅' : '⚠️';
      f.classList.add('show');
      setTimeout(() => f.classList.remove('show'), 900);
    }

    async function tap(el, url) {
      if (!(await gateAuth())) return;
      el.classList.add('pressed');
      setTimeout(() => el.classList.remove('pressed'), 120);
      keyed(url)
        .then((r) => {
          flash(el, r.ok);
          if (r.ok) {
            refresh();               // immediate
            setTimeout(refresh, 9000); // catch the coach's reactive repaint
          }
          return r.text();
        })
        .then((t) => { hint.innerHTML = '<b>' + esc(t) + '</b>'; })
        .catch(() => flash(el, false));
    }

    // Long-press "oops": take back today's last log for this key. The 404 the
    // server sends when there is nothing to remove flashes ⚠️ like any other
    // failure — which is the honest answer.
    async function undo(el, url) {
      if (!(await gateAuth())) return;
      el.classList.add('pressed');
      setTimeout(() => el.classList.remove('pressed'), 120);
      keyed(url, { method: 'DELETE' })
        .then((r) => {
          flash(el, r.ok);
          if (r.ok) refresh();
          return r.text();
        })
        .then((t) => { hint.innerHTML = '<b>' + esc(t) + '</b>'; })
        .catch(() => flash(el, false));
    }

    // Long-press on a nudge: "not today". Distinct from ignoring it — the
    // scorer records the two differently (#35).
    async function dismiss(el, url, msg) {
      if (!(await gateAuth())) return;
      el.classList.add('pressed');
      setTimeout(() => el.classList.remove('pressed'), 120);
      keyed(url, { method: 'POST' })
        .then((r) => {
          flash(el, r.ok);
          if (r.ok) refresh();
          hint.innerHTML = r.ok ? '<b>' + esc(msg) + '</b>' : '<b>Nothing to dismiss.</b>';
        })
        .catch(() => flash(el, false));
    }

    function refresh() {
      // ?tz= lets the server bucket "today" in the viewer's timezone (matches
      // the dashboard), so living key faces read the right day (#32).
      const tz = new Date().getTimezoneOffset(); // minutes; UTC-5 → 300
      const url = '/api/slots?tz=' + tz;
      const go = (window.HabitAuth && window.HabitAuth.authFetch)
        ? window.HabitAuth.authFetch(url)
        : fetch(url);
      go.then((r) => r.json()).then((j) => {
        habits = j.habits || habits;
        slots = j.slots || slots;
        coachPage = j.coachPage || [];
        rosterPending = Number(j.rosterPending) || 0;
        beaconBlocked = !!j.blocked;
        today = j.today || {};
        if (!built && habits.length) build();
        paintSlots();
        paintHabits();
        if (hint.textContent === 'Loading keys…') {
          hint.innerHTML = 'Tap a key — it logs exactly like the hardware. The <b>✨ AI keys</b> repaint themselves when the coach changes its mind.';
        }
      }).catch(() => { if (!built) hint.textContent = 'Couldn’t reach the API — refresh to retry.'; });
    }

    refresh();
    setInterval(refresh, 15000); // same poll cadence as the hardware plugin
    // A nudge's urgency changes with the clock, not with the payload, so the
    // poll alone would never escalate it. Repaint on its own beat while one is
    // live (the plugin does the same via its tick — see escalate()).
    setInterval(() => { if (slots.some((s) => s && s.nudge) || document.querySelector('.k[data-beacon] .frame-wait, .k[data-beacon] .frame-blocked')) paintSlots(); }, 20000);
  
