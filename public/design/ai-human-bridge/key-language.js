import { esc } from '/escape.js';
    // ---- global toggles ------------------------------------------------
    const desaturate = document.getElementById('desaturate');
    const reduced = document.getElementById('reduced');
    const toggle = (btn, cls) => {
      const on = document.body.classList.toggle(cls);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    };
    desaturate.addEventListener('click', () => toggle(desaturate, 'desaturate'));
    reduced.addEventListener('click', () => toggle(reduced, 'reduced'));

    // ---- glyph grammar row (doc 2.5) — generated from the verb table ----
    const VERBS = [
      ['✓', 'Approve',  '#22C55E'],
      ['✕', 'Deny',     '#cfd6e2'],
      ['→', 'Defer',    '#7fa9ff'],
      ['…', 'Details',  '#7fa9ff'],
      ['⊕', 'Drill in', '#7fa9ff'],
      ['‹', 'Back',     '#cfd6e2'],
      ['▶', 'Run',      '#2EA3FF'],
      ['■', 'Stop',     '#FF4D4D'],
      ['▤', 'Options',  '#7fa9ff'],
      ['⚙', 'Toggle',   '#8b5cf6'],
    ];
    const glyphRow = document.getElementById('glyph-row');
    glyphRow.innerHTML = VERBS.map(([g, l, hue]) => `
      <div class="spec">
        <div class="key s-idle"><div class="k-glyph" style="--glyph-hue:${esc(hue)};">${esc(g)}</div><div class="k-label">${esc(l)}</div></div>
        <div class="cap">${esc(l)}</div>
      </div>`).join('');

    // ---- the press-acknowledgment flash (doc 2.3 / 4.2) ----------------
    // The committing press flashes the key white, then runs its effect.
    function flash(keyEl, after) {
      keyEl.classList.add('m-flash');
      setTimeout(() => {
        keyEl.classList.remove('m-flash');
        if (after) after();
      }, 350);
    }
    // settle a key to a target state, then auto-fade success → idle (doc 4.2)
    function settle(keyEl, stateClass) {
      keyEl.className = keyEl.className.replace(/s-\w+/g, '').replace(/m-breathe|m-blink|m-shimmer|m-sweep/g, '').replace(/\s+/g, ' ').trim();
      keyEl.classList.add(stateClass);
      if (stateClass === 's-success') {
        setTimeout(() => keyEl.classList.replace('s-success', 's-idle'), 1600);
      }
    }

    // ---- 4.1 Approval Gate ---------------------------------------------
    const gate = document.getElementById('approval-gate');
    const gateStatus = document.getElementById('approval-status');
    gate.addEventListener('click', (e) => {
      const key = e.target.closest('.key'); if (!key) return;
      const action = key.dataset.action;
      flash(key, () => {
        if (action === 'approve') { settle(key, 's-success'); gateStatus.textContent = '✓ Approved — action emitted to the agent. The tile flashes, settles green, fades to idle.'; }
        else if (action === 'deny')   { settle(key, 's-idle');    gateStatus.textContent = '✕ Denied — nothing emitted. The gate dismisses.'; }
        else if (action === 'details'){ settle(key, 's-working'); gateStatus.textContent = '… Details routed to your screen — the key labels the decision, the screen holds the evidence.'; setTimeout(()=>settle(key,'s-idle'),2200); }
      });
    });

    // ---- 4.2 Choice Picker ---------------------------------------------
    const picker = document.getElementById('choice-picker');
    const choiceStatus = document.getElementById('choice-status');
    picker.addEventListener('click', (e) => {
      const key = e.target.closest('.key'); if (!key) return;
      flash(key, () => {
        [...picker.querySelectorAll('.key')].forEach(k => settle(k, 's-idle'));
        settle(key, 's-success');
        choiceStatus.textContent = `Picked ${key.dataset.pick} (badge ${key.querySelector('.k-badge')?.textContent}). The others settle to idle; the choice returns to the AI.`;
      });
    });

    // ---- 4.3 Two-Stage Confirm (arm → fire, with ~3s expiry) -----------
    const delKey = document.getElementById('delete-key');
    const delLabel = document.getElementById('delete-label');
    const delCap = document.getElementById('delete-cap');
    const delStatus = document.getElementById('delete-status');
    let armed = false, armTimer = null;
    function disarm() {
      armed = false;
      delKey.classList.remove('is-armed');
      delKey.classList.add('s-wait', 'm-breathe');
      delLabel.textContent = 'Delete';
      delCap.textContent = 'press to arm';
      clearTimeout(armTimer);
    }
    delKey.addEventListener('click', () => {
      if (!armed) {
        // first press = ARMING. It must NOT emit and does NOT flash-acknowledge (doc 4.3).
        armed = true;
        delKey.classList.remove('s-wait', 'm-breathe');
        delKey.classList.add('is-armed');
        delLabel.textContent = 'Confirm?';
        delCap.textContent = 'press again to fire — or wait';
        delStatus.textContent = 'Armed. The first press only arms; no token has crossed to the AI yet.';
        armTimer = setTimeout(() => {
          if (armed) { disarm(); delStatus.textContent = 'Window lapsed — silently disarmed. Nothing reached the AI.'; }
        }, 3000);
      } else {
        // second press within the window = the committing press.
        clearTimeout(armTimer);
        armed = false;
        flash(delKey, () => { settle(delKey, 's-success'); delLabel.textContent = 'Delete'; delCap.textContent = 'press to arm'; });
        delStatus.textContent = '⚠ Deleted — the irreversible token crossed the bridge only after two deliberate presses.';
      }
    });

    // ---- 4.4 Beacon + Mode ---------------------------------------------
    const beacon = document.getElementById('beacon');
    const beaconCap = document.getElementById('beacon-cap');
    beacon.addEventListener('click', () => {
      flash(beacon, () => {
        beacon.classList.remove('breathe');
        beacon.style.setProperty('--frame', 'var(--state-success)');
        beacon.style.color = 'var(--state-success)';
        beaconCap.innerHTML = '<b>beacon</b><br>cleared · idle';
        setTimeout(() => {
          beacon.classList.add('breathe');
          beacon.style.setProperty('--frame', 'var(--state-wait)');
          beacon.style.color = 'var(--state-wait)';
          beaconCap.innerHTML = '<b>beacon</b><br>amber · 2 pending';
        }, 2200);
      });
    });

    const modeKey = document.getElementById('mode-key');
    const modeLabel = document.getElementById('mode-label');
    const modeCap = document.getElementById('mode-cap');
    const MODES = [
      ['Manual',   'every action gated',        'var(--state-wait)'],
      ['Assisted', 'gates only risky actions',  'var(--agent-builder)'],
      ['Auto',     'runs free, reports after',  'var(--state-success)'],
    ];
    let modeIdx = 1;
    modeKey.addEventListener('click', () => {
      flash(modeKey, () => {
        modeIdx = (modeIdx + 1) % MODES.length;
        const [label, desc, frame] = MODES[modeIdx];
        modeLabel.textContent = label;
        modeCap.innerHTML = `<b>autonomy · ${label.toLowerCase()}</b><br>${desc}`;
        modeKey.style.setProperty('--frame', frame);
      });
    });

    // ---- 4.6 Nudge -----------------------------------------------------
    document.querySelectorAll('[data-nudge]').forEach(k => {
      k.addEventListener('click', () => flash(k, () => {
        settle(k, 's-success');
        document.getElementById('misc-status').textContent =
          `${k.dataset.nudge === 'stop' ? '■ Stop' : '⏸ Pause'} — human-initiated halt. Supervision is bidirectional.`;
      }));
    });

    // ---- rail scroll-spy (issue #79) ----------------------------------
    // Pure-vanilla, additive: highlights the rail link for whichever study
    // section is currently in view. No framework; no effect on the specimens.
    (function activeLink() {
      const links = document.querySelectorAll('.rail a');
      const map = new Map();
      links.forEach(a => { const id = a.getAttribute('href').slice(1); const sec = document.getElementById(id); if (sec) map.set(sec, a); });
      if (!('IntersectionObserver' in window) || map.size === 0) return;
      const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          const a = map.get(entry.target);
          if (!a) return;
          if (entry.isIntersecting) {
            links.forEach(l => l.classList.remove('active'));
            a.classList.add('active');
          }
        });
      }, { rootMargin: '-80px 0px -70% 0px', threshold: 0 });
      map.forEach((_, sec) => io.observe(sec));
    })();

    // honor the OS preference as a starting point for reduced motion
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      toggle(reduced, 'reduced');
    }
  
