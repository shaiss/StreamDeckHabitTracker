import { esc } from '/escape.js';
    const rowsEl = document.getElementById('rows');
    const statusEl = document.getElementById('status');

    function goalBits(h) {
      const g = h && h.goal;
      if (g != null && typeof g === 'object') {
        return {
          target: g.target != null ? String(g.target) : '',
          setBy: g.setBy === 'coach' ? 'coach' : 'human',
          reason: g.reason || '',
          updatedAt: g.updatedAt || 0,
          floor: g.floor != null ? String(g.floor) : '',
          ceil: g.ceil != null ? String(g.ceil) : ''
        };
      }
      return {
        target: g ? String(g) : '',
        setBy: 'human',
        reason: '',
        updatedAt: 0,
        floor: '',
        ceil: ''
      };
    }

    function rowHtml(h, isNew) {
      const origin = h.origin === 'coach' ? 'coach' : 'human';
      const g = goalBits(h);
      const chip = origin === 'coach'
        ? '<span class="chip coach" title="Invented by the AI coach, promoted by you">COACH</span>'
        : '<span class="chip quiet human" title="Created by you">HUMAN</span>';
      const meta = g.setBy === 'coach' && g.reason
        ? `<div class="goal-meta">coach · ${esc(g.reason)}</div>`
        : (g.setBy === 'coach' ? '<div class="goal-meta">coach-set target</div>' : '');
      return `<div class="card hrow" data-new="${isNew ? 1 : 0}" data-origin="${origin}" data-goal-setby="${esc(g.setBy)}" data-goal-target="${esc(g.target)}" data-goal-updated="${esc(String(g.updatedAt||0))}" data-goal-reason="${esc(g.reason)}">
        <input class="field emoji" value="${esc(h.emoji||'')}" maxlength="8" placeholder="🙂">
        <input class="field label" value="${esc(h.label||'')}" maxlength="12" placeholder="Label">
        <input class="field name" value="${esc(h.name||'')}" maxlength="20" placeholder="OneWordId" ${isNew ? '' : 'readonly title="Ids are locked to keep history consistent — delete and re-add to rename."'}>
        <div class="goal-cell">
          <input class="field goal" type="number" min="1" max="99" value="${esc(g.target)}" placeholder="1" title="Daily goal (default 1). 2+ makes the key show count dots and a progress ring.">
          <div class="pins">
            <input class="field floor" type="number" min="1" max="99" value="${esc(g.floor)}" placeholder="⌊" title="Floor — the coach may never set the target below this.">
            <input class="field ceil" type="number" min="1" max="99" value="${esc(g.ceil)}" placeholder="⌈" title="Ceil — the coach may never set the target above this.">
          </div>
        </div>
        ${chip}
        <button class="del" title="Remove">✕</button>
        ${meta}
      </div>`;
    }

    function renderCoach(list) {
      const sect = document.getElementById('coachSect');
      if (!list || !list.length) { sect.hidden = true; return; }
      sect.hidden = false;
      document.getElementById('coachRows').innerHTML = list.map(c => `
        <div class="card crow">
          <span class="em">${esc(c.emoji)}</span>
          <span><span class="nm">${esc(c.label)}</span> <span class="meta">· ${esc(c.habit)}</span>
            ${c.active ? '<div class="tag active">ON A SLOT KEY NOW</div>' : ''}</span>
          <span class="stats">offered ${c.offered}× · tapped ${c.taps}×</span>
          <button class="btn ghost promote" data-habit="${esc(c.habit)}" data-emoji="${esc(c.emoji)}" data-label="${esc(c.label)}">⬆ Promote</button>
        </div>`).join('');
      document.querySelectorAll('.promote').forEach(b => b.addEventListener('click', () => {
        const name = b.dataset.habit.toLowerCase();
        const exists = [...rowsEl.querySelectorAll('.hrow .name')].some(i => i.value.trim().toLowerCase() === name);
        if (exists) {
          b.disabled = true; b.textContent = '✓ Added';
          statusEl.textContent = `${b.dataset.label} is already in the list above.`;
          return;
        }
        rowsEl.insertAdjacentHTML('beforeend', rowHtml({ name: b.dataset.habit, emoji: b.dataset.emoji, label: b.dataset.label, origin: 'coach' }, true));
        wireRow(rowsEl.lastElementChild);
        rowsEl.lastElementChild.dataset.origin = 'coach';
        b.disabled = true; b.textContent = '✓ Added';
        statusEl.textContent = `${b.dataset.label} added as a coach-origin key — hit Save to make it permanent.`;
        rowsEl.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }));
    }

    // The coach's roster proposals: add/retire asks awaiting a yes or no.
    // Unlike Promote (which stages a row for you to edit), a decision here is
    // final on click — the server applies it and we re-read both lists.
    function renderRoster(r) {
      const props = r.proposals || [], arch = r.archive || [];
      document.getElementById('propSect').hidden = !props.length;
      document.getElementById('propRows').innerHTML = props.map(p => `
        <div class="card prow">
          <span class="em">${esc(p.emoji)}</span>
          <span>
            <span class="chip ${p.kind === 'retire' ? 'quiet' : 'coach'} kind">${p.kind === 'retire' ? 'RETIRE' : 'ADD'}</span>
            <span class="nm">${esc(p.label)}</span> <span class="meta">· ${esc(p.name)}</span>
            ${p.reason ? `<div class="why">${esc(p.reason)}</div>` : ''}
          </span>
          <span class="pbtns">
            <button class="btn decide" data-id="${esc(p.id)}" data-name="${esc(p.name)}" data-kind="${esc(p.kind)}" data-decision="approve">${p.kind === 'retire' ? '✓ Retire it' : '✓ Add it'}</button>
            <button class="btn ghost decide" data-id="${esc(p.id)}" data-name="${esc(p.name)}" data-decision="dismiss">Dismiss</button>
          </span>
        </div>`).join('');

      document.getElementById('archSect').hidden = !arch.length;
      document.getElementById('archRows').innerHTML = arch.map(a => `
        <div class="card arow">
          <span class="em">${esc(a.emoji)}</span>
          <span><span class="nm">${esc(a.label)}</span> <span class="meta">· ${esc(a.name)}</span></span>
          <button class="btn ghost restore" data-name="${esc(a.name)}">↩ Restore</button>
        </div>`).join('');

      document.querySelectorAll('.decide').forEach(b => b.addEventListener('click', () => {
        if (b.dataset.decision === 'approve' && b.dataset.kind === 'retire') {
          armThenFire(b, { idleText: '✓ Retire it', onCommit: () => decide('/api/roster', { id: b.dataset.id, decision: b.dataset.decision }) });
          return;
        }
        decide('/api/roster', { id: b.dataset.id, decision: b.dataset.decision });
      }));
      document.querySelectorAll('.restore').forEach(b => b.addEventListener('click', () =>
        decide('/api/roster', { restore: b.dataset.name })));
    }

    // Ramp-up proposals (#70): higher targets wait for approve/dismiss.
    function renderTargets(t) {
      const props = (t && t.proposals) || [];
      document.getElementById('targetPropSect').hidden = !props.length;
      document.getElementById('targetPropRows').innerHTML = props.map(p => `
        <div class="card prow tprow">
          <span class="em">${esc(p.emoji || '✨')}</span>
          <span>
            <span class="chip coach kind">RAISE</span>
            <span class="nm">${esc(p.label || p.name)}</span>
            <span class="meta">· ${esc(p.from)}→${esc(p.to)}/day</span>
            ${p.reason ? `<div class="why">${esc(p.reason)}</div>` : ''}
          </span>
          <span class="pbtns">
            <button class="btn tdecide" data-id="${esc(p.id)}" data-name="${esc(p.name)}" data-decision="approve">✓ Raise it</button>
            <button class="btn ghost tdecide" data-id="${esc(p.id)}" data-name="${esc(p.name)}" data-decision="dismiss">Dismiss</button>
          </span>
        </div>`).join('');
      document.querySelectorAll('.tdecide').forEach(b => b.addEventListener('click', () =>
        decide('/api/targets', { id: b.dataset.id, decision: b.dataset.decision }, 'target')));
    }

    function decided(a, kind) {
      if (!a) return 'Done.';
      if (kind === 'target') {
        if (a.status === 'dismissed') return `Dismissed — the coach won’t ask to raise ${a.name} to ${a.to} again.`;
        if (a.status === 'stale') return `${a.name}'s target is already at ${a.from} — that raise no longer applies.`;
        return `Raised ${a.label || a.name} ${a.from}→${a.to}/day.`;
      }
      if (a.status === 'restored') return `${a.label} is back on your roster.`;
      if (a.status === 'dismissed') return `Dismissed — the coach won’t ask about ${a.name} again.`;
      if (a.kind === 'retire') return `${a.label} retired — it’s under Retired below, and its history is untouched.`;
      return `${a.label} is a fixed key now — re-import your deck profile to give it a physical key.`;
    }

    function decide(url, payload, kind) {
      document.querySelectorAll('.decide, .restore, .tdecide').forEach(b => { b.disabled = true; });
      statusEl.className = 'status'; statusEl.textContent = 'Working…';
      // window.HabitKey.postJson sends x-habit-key (asks once on 401).
      return window.HabitKey.postJson(url, payload).then(r=>r.json()).then(j =>
        // Re-read first, then report: the status line must never announce a
        // change the lists above it haven't caught up to yet.
        load(true).then(() => {
          if (!j.ok) { statusEl.className = 'status err'; statusEl.textContent = j.error || 'Failed.'; }
          else { statusEl.textContent = decided(j.applied, kind); }
        })
      ).catch(e => load(true).then(() => {
        statusEl.className = 'status err'; statusEl.textContent = 'Failed: ' + e.message;
      }));
    }

    const ARM_MS = 3000; // pinned to streamdeck-plugin/src/gestures.mjs (#78)
    const armTimers = new WeakMap();
    function armThenFire(btn, { idleText, onCommit }) {
      if (btn.dataset.armed === '1') {
        const t = armTimers.get(btn);
        if (t) clearTimeout(t);
        armTimers.delete(btn);
        delete btn.dataset.armed;
        btn.classList.remove('armed');
        onCommit();
        return true;
      }
      btn.dataset.armed = '1';
      btn.classList.add('armed');
      const prev = idleText != null ? idleText : btn.textContent;
      btn.textContent = 'CONFIRM?';
      const t = setTimeout(() => {
        if (btn.dataset.armed !== '1') return;
        delete btn.dataset.armed;
        btn.classList.remove('armed');
        btn.textContent = prev;
        armTimers.delete(btn);
      }, ARM_MS);
      armTimers.set(btn, t);
      return false;
    }

    function wireRow(el) {
      const btn = el.querySelector('.del');
      btn.addEventListener('click', () => {
        armThenFire(btn, { idleText: '✕', onCommit: () => el.remove() });
      });
    }

    function load(keepStatus) {
      return Promise.all([
        fetch('/api/habits').then(r=>r.json()),
        fetch('/api/roster').then(r=>r.json()).catch(() => ({})),
        fetch('/api/targets').then(r=>r.json()).catch(() => ({}))
      ]).then(([j, r, t]) => {
        rowsEl.innerHTML = (j.habits||[]).map(h => rowHtml(h, false)).join('');
        rowsEl.querySelectorAll('.hrow').forEach(wireRow);
        renderCoach(j.coachHabits);
        renderRoster(r);
        renderTargets(t);
      }).catch(() => {
        if (!keepStatus) statusEl.textContent = 'Couldn’t load habits.';
      });
    }
    load();

    document.getElementById('addBtn').addEventListener('click', () => {
      rowsEl.insertAdjacentHTML('beforeend', rowHtml({}, true));
      wireRow(rowsEl.lastElementChild);
      rowsEl.lastElementChild.querySelector('.emoji').focus();
    });

    document.getElementById('saveBtn').addEventListener('click', () => {
      const habits = [...rowsEl.querySelectorAll('.hrow')].map(el => {
        const g = parseInt(el.querySelector('.goal').value, 10);
        const floor = parseInt(el.querySelector('.floor').value, 10);
        const ceil = parseInt(el.querySelector('.ceil').value, 10);
        const hasPins = (Number.isInteger(floor) && floor >= 1 && floor <= 99)
          || (Number.isInteger(ceil) && ceil >= 1 && ceil <= 99);
        const prevSetBy = el.dataset.goalSetby === 'coach' ? 'coach' : 'human';
        const prevTarget = parseInt(el.dataset.goalTarget || '', 10);
        // Editing the number (or first setting pins) is a human write; leaving
        // a coach-set target untouched keeps the coach reason/metadata.
        const targetChanged = Number.isInteger(g) && Number.isInteger(prevTarget) && g !== prevTarget;
        const keepCoach = prevSetBy === 'coach' && !targetChanged && Number.isInteger(g);
        let goal;
        if (Number.isInteger(g) && g >= 1 && g <= 99) {
          if (keepCoach || hasPins) {
            goal = {
              target: g,
              setBy: keepCoach ? 'coach' : 'human',
              ...(keepCoach && el.dataset.goalReason ? { reason: el.dataset.goalReason } : {}),
              ...(keepCoach && el.dataset.goalUpdated ? { updatedAt: Number(el.dataset.goalUpdated) || undefined } : {}),
              ...(Number.isInteger(floor) && floor >= 1 && floor <= 99 ? { floor } : {}),
              ...(Number.isInteger(ceil) && ceil >= 1 && ceil <= 99 ? { ceil } : {})
            };
          } else {
            goal = g;
          }
        }
        return {
          emoji: el.querySelector('.emoji').value.trim(),
          label: el.querySelector('.label').value.trim(),
          name: el.querySelector('.name').value.trim(),
          origin: el.dataset.origin === 'coach' ? 'coach' : 'human',
          ...(goal !== undefined ? { goal } : {})
        };
      });
      const seen = new Set();
      for (const h of habits) {
        const k = h.name.toLowerCase();
        if (seen.has(k)) {
          statusEl.className = 'status err';
          statusEl.textContent = `"${h.name}" appears twice — remove one row before saving.`;
          return;
        }
        seen.add(k);
      }
      statusEl.className = 'status'; statusEl.textContent = 'Saving…';
      window.HabitKey.postJson('/api/habits', { habits }).then(r=>r.json()).then(j => {
        if (j.ok) {
          statusEl.textContent = 'Saved — dashboard, coach, and virtual deck are updated.';
          load(); // re-render both sections so promoted habits leave the coach list
        }
        else { statusEl.className = 'status err'; statusEl.textContent = j.error || 'Save failed.'; }
      }).catch(e => { statusEl.className = 'status err'; statusEl.textContent = 'Save failed: ' + e.message; });
    });
