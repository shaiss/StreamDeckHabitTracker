import { esc } from '/escape.js';
    const apiFetch = (url, opts) =>
      (window.HabitAuth && window.HabitAuth.authFetch)
        ? window.HabitAuth.authFetch(url, opts)
        : fetch(url, opts);
    const EMOJI = { Pee:"🚽", Poop:"💩", Eat:"🍽", Drink:"💧", Exercise:"🏃" };
    const emojiFor = (h, e) => e || EMOJI[h] || "•";
    // Habit names, notes, and emoji come from the log — /api/log accepts
    // arbitrary ?habit=/?note= text — so anything of theirs rendered via
    // innerHTML goes through esc() from /escape.js.
    const app = document.getElementById('app');
    let slotState = null;   // latest /api/slots payload
    let lastEntries = [];   // latest /api/data entries
    let lastInsight = null; // latest coach daily digest

    const dayKey = (d) => { const x = new Date(d); return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0'); };
    const todayKey = dayKey(Date.now());
    const fmtTime = (t) => new Date(t).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });

    function render(entries) {
      if (!entries.length) {
        app.innerHTML = '<div class="empty">No taps yet. Tap a habit key on your Stream Deck &mdash; it&rsquo;ll show up here.</div><section id="ai"></section>';
        document.getElementById('total').textContent = '';
        renderAi();
        return;
      }
      // per-habit totals + today (+ last-seen emoji per habit, for AI habits)
      const totals = {}, today = {}, emap = {};
      for (const e of entries) {
        totals[e.h] = (totals[e.h]||0)+1;
        if (e.e) emap[e.h] = e.e;
        if (dayKey(e.t) === todayKey) today[e.h] = (today[e.h]||0)+1;
      }
      const habits = Object.keys(totals).sort((a,b)=>totals[b]-totals[a]);

      // last 7 days total volume
      const days = [];
      for (let i=6;i>=0;i--){ const d=new Date(); d.setDate(d.getDate()-i); days.push(dayKey(d)); }
      const perDay = Object.fromEntries(days.map(d=>[d,0]));
      for (const e of entries){ const k=dayKey(e.t); if(k in perDay) perDay[k]++; }
      const rawMax = Math.max(...Object.values(perDay));
      const maxDay = Math.max(2, rawMax);            // headroom so 0/1 days still draw sanely
      const midTick = Math.ceil(maxDay/2);

      const cards = habits.map(h => `
        <div class="card">
          <div class="emoji">${esc(emojiFor(h, emap[h]))}</div>
          <div class="big">${totals[h]}</div>
          <div class="name">${esc(h)}</div>
          ${today[h] ? `<div class="today">+${today[h]} today</div>` : `<div class="today muted">&mdash;</div>`}
        </div>`).join('');

      // marks: ≤24px bars, 4px rounded caps, hairline grid, selective labels
      // (peak day + today only — the tooltip and table carry the rest)
      const peak = days.reduce((a,d)=>perDay[d]>perDay[a]?d:a, days[0]);
      const cols = days.map(d => {
        const v = perDay[d];
        const h = Math.round((v/maxDay)*100);
        const showCap = v>0 && (d===peak || d===todayKey);
        return `<div class="bar-col" tabindex="0" data-day="${d}" data-v="${v}">
          ${showCap?`<span class="cap" style="bottom:${h}%">${v}</span>`:''}
          <div class="bar" style="height:${h}%"></div>
        </div>`;
      }).join('');
      const grid = [[0,'0'],[Math.round(100*midTick/maxDay),String(midTick)],[100,String(maxDay)]]
        .map(([pct,lab])=>`<div class="gline" style="bottom:${pct}%"><span class="tick">${lab}</span></div>`).join('');
      const dows = days.map(d=>`<span>${new Date(d+'T00:00').toLocaleDateString([], { weekday:'short' })}</span>`).join('');
      const tableRows = days.map(d=>`<tr><td>${new Date(d+'T00:00').toLocaleDateString([], { weekday:'long', month:'short', day:'numeric' })}</td><td>${perDay[d]}</td></tr>`).join('');

      const recent = entries.slice(-12).reverse().map(e => `
        <div class="row"><span>${esc(emojiFor(e.h, e.e))} ${esc(e.h)}${e.slot?` <span class="tag">AI</span>`:''}${e.note?` <span class="muted">(${esc(e.note)})</span>`:''}</span><span class="when">${fmtTime(e.t)}</span></div>`).join('');

      app.innerHTML = `
        <div class="grid">${cards}</div>
        <section>
          <div class="ai-head"><h2 class="section-h">Taps per day · last 7 days</h2><button class="linklike" id="tblBtn">table</button></div>
          <div class="card chart" id="chartCard">
            <div class="plot">${grid}<div class="cols">${cols}</div></div>
            <div class="dows">${dows}</div>
            <table class="data-table" id="tapTable" hidden><tr><th>Day</th><th>Taps</th></tr>${tableRows}</table>
          </div>
        </section>
        <section id="ai"></section>
        <section><h2 class="section-h">Recent</h2><div class="card flush">${recent}</div></section>`;
      document.getElementById('total').textContent = `${entries.length} total taps`;
      wireChart();
      renderAi();
    }

    let tip = null;
    function wireChart() {
      if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; document.body.appendChild(tip); }
      const plot = document.querySelector('.plot'), table = document.getElementById('tapTable');
      document.getElementById('tblBtn')?.addEventListener('click', (e) => {
        const show = table.hidden; table.hidden = !show; plot.parentElement.querySelector('.plot').style.display = show?'none':'';
        plot.parentElement.querySelector('.dows').style.display = show?'none':'';
        e.target.textContent = show ? 'chart' : 'table';
      });
      document.querySelectorAll('.bar-col').forEach(col => {
        const show = () => {
          const d = col.dataset.day, v = col.dataset.v;
          tip.innerHTML = '';
          const b = document.createElement('b'); b.textContent = v;
          tip.appendChild(b);
          tip.appendChild(document.createTextNode(` tap${v==='1'?'':'s'} · ` +
            new Date(d+'T00:00').toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' })));
          const r = col.getBoundingClientRect();
          tip.style.display = 'block';
          tip.style.left = Math.min(window.innerWidth-150, Math.max(6, r.left + r.width/2 - 60)) + 'px';
          tip.style.top = (r.top - 44) + 'px';
        };
        const hide = () => { tip.style.display = 'none'; };
        col.addEventListener('pointerenter', show);
        col.addEventListener('pointerleave', hide);
        col.addEventListener('focus', show);
        col.addEventListener('blur', hide);
      });
    }

    // Hardware heartbeat: the plugin tags its /api/slots poll, so this line
    // separates "the coach isn't swapping" from "the physical deck never asked".
    // The plugin polls every 15s; allow 3 misses before calling it stale.
    function deckLine(deck) {
      if (!deck?.at) {
        return `<div class="ai-note deckline" id="deckline" data-live="0">Physical deck: <b>never seen</b> — no Stream Deck plugin has polled this backend. Install the plugin + profile, then watch this line.</div>`;
      }
      const ago = Math.max(0, Date.now() - deck.at);
      const live = ago < 45000;
      const when = ago < 60000 ? `${Math.round(ago/1000)}s ago` : `${Math.round(ago/60000)}m ago`;
      // plugin/keys originate in a query string, so they're attacker-shaped
      // until proven otherwise: esc() the string, coerce the count to a number.
      const plugin = deck.plugin ? esc(deck.plugin) : '?';
      const nkeys = Number(deck.keys) || 0;
      return `<div class="ai-note deckline" id="deckline" data-live="${live ? 1 : 0}">Physical deck: <b>${live ? 'live' : 'stale'}</b> · last poll ${when} · plugin ${plugin} · ${nkeys} keys</div>`;
    }

    function renderAi() {
      const el = document.getElementById('ai');
      if (!el) return;
      const s = slotState;
      const btn = `<button class="btn" id="suggestBtn" ${s && !s.aiReady ? 'disabled' : ''}>✨ Suggest</button>`;
      const cards = (s?.slots || [null,null,null,null]).map((d, i) => d ? `
        <div class="card slot${d.nudge ? ' nudge' : ''}">
          <div class="top"><span class="em">${esc(d.emoji)}</span><span class="nm">${esc(d.label)}</span></div>
          <div class="why">${esc(d.reason||'')}</div>
          <div class="tag">${d.nudge ? '❗ NUDGE' : 'SLOT ' + (i+1)} · logs as ${esc(d.habit)}</div>
        </div>` : `
        <div class="card slot empty">Slot ${i+1} — empty</div>`).join('');
      const note = s && !s.aiReady
        ? `<div class="ai-note">To enable: Vercel → project → Settings → Environment Variables → add <code>ZAI_API_KEY</code> (get one at z.ai) → redeploy.</div>`
        : `<div class="ai-note">The AI picks up to 4 extra habits it wants tracked, based on your taps. Slot keys on the Stream Deck log whatever is assigned here — and swap automatically when suggestions change.</div>`;
      const insight = lastInsight?.text
        ? `<div class="card slot" style="margin-bottom:var(--s3)"><div class="top"><span class="em">📝</span><span class="nm">Coach's note · ${esc(lastInsight.date||'')}</span></div><div class="why">${esc(lastInsight.text)}</div></div>`
        : '';
      const tr = s?.track?.overall;
      const trackLine = tr && tr.offered > 0
        ? `<div class="ai-note" style="margin:0 0 var(--s3)">Track record: ${tr.landed}/${tr.offered} suggested keys tapped (${Math.round(tr.hitRate*100)}%) — the coach sees this and adapts.</div>`
        : '';
      el.innerHTML = `<div class="ai-head"><h2 class="section-h">AI Coach${s?.model ? ` <span class="muted" style="text-transform:none;letter-spacing:0">· ${esc(s.model)}</span>` : ''}</h2>${btn}</div>
        ${insight}${trackLine}<div class="slot-grid">${cards}</div>${deckLine(s?.deck)}${note}<div class="ai-err" id="aiErr"></div>`;
      document.getElementById('suggestBtn')?.addEventListener('click', suggest);
    }

    async function suggest() {
      if (window.HabitAuth && !(await window.HabitAuth.ensureSignedIn())) return;
      const btn = document.getElementById('suggestBtn'), err = document.getElementById('aiErr');
      btn.disabled = true; btn.textContent = '🤔 Thinking…'; err.textContent = '';
      try {
        const r = await window.HabitKey.fetch('/api/suggest', { method:'POST' });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || ('HTTP '+r.status));
        slotState = { ...slotState, slots: j.slots, model: j.model };
        renderAi();
      } catch (e2) {
        err.textContent = e2.message;
        btn.disabled = false; btn.textContent = '✨ Suggest';
      }
    }

    function renderSetup() {
      app.innerHTML = `<div class="card setup">
        <strong>Almost there &mdash; storage isn&rsquo;t connected yet.</strong>
        <ol>
          <li>In Vercel, open this project &rarr; <strong>Storage</strong> tab.</li>
          <li>Create a database: <strong>Upstash for Redis</strong> (or <strong>KV</strong>), free tier is fine.</li>
          <li>Connect it to <code>stream-deck-habit-tracker</code>. Vercel adds the credentials automatically and redeploys.</li>
        </ol>
        <p class="muted">Once connected, taps to <code>/api/log?habit=Name</code> will appear here.</p>
      </div>`;
    }

    // Settings panel (opened from the nav bar, or /?settings=1 from other pages)
    const panel = document.getElementById('settings');
    try {
      document.getElementById('tzList').innerHTML =
        Intl.supportedValuesOf('timeZone').map(z=>`<option value="${esc(z)}">`).join('');
    } catch {}
    function toggleSettings(forceOpen) {
      const open = forceOpen === true ? true : !panel.classList.contains('open');
      panel.classList.toggle('open', open);
      if (open) {
        apiFetch('/api/profile').then(r=>r.json()).then(p => {
          document.getElementById('setName').value = p.name || '';
          document.getElementById('setTz').value = p.tz || p.effectiveTz || '';
          document.getElementById('setAbout').value = p.about || '';
          document.getElementById('setCoachNav').value = p.coachNav || 'off';
          document.getElementById('profileStatus').textContent =
            p.effectiveTz ? `Coach currently reads your day as ${p.effectiveTz}` : '';
        }).catch(()=>{});
        refreshTokens();
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
    window.addEventListener('toggle-settings', () => toggleSettings());
    if (new URLSearchParams(location.search).get('settings') === '1') toggleSettings(true);
    document.getElementById('saveProfile').addEventListener('click', async () => {
      if (window.HabitAuth && !(await window.HabitAuth.ensureSignedIn())) return;
      const st = document.getElementById('profileStatus');
      st.textContent = 'Saving…';
      window.HabitKey.postJson('/api/profile', {
        name: document.getElementById('setName').value.trim(),
        tz: document.getElementById('setTz').value.trim(),
        about: document.getElementById('setAbout').value.trim(),
        coachNav: document.getElementById('setCoachNav').value
      }).then(r=>r.json()).then(j => {
        st.textContent = j.ok ? 'Saved — the coach will use this on its next pass.' : (j.error || 'Save failed');
      }).catch(e => { st.textContent = 'Save failed: ' + e.message; });
    });

    async function refreshTokens() {
      const list = document.getElementById('tokenList');
      if (!list) return;
      if (window.HabitAuth && typeof window.HabitAuth.init === 'function') {
        await window.HabitAuth.init();
      }
      if (!window.HabitAuth || !window.HabitAuth.isSignedIn()) {
        list.innerHTML = '<li>Sign in to manage tokens.</li>';
        return;
      }
      try {
        const r = await apiFetch('/api/token');
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        const tokens = j.tokens || [];
        list.innerHTML = tokens.length
          ? tokens.map((t) =>
              `<li><code>${esc(t.prefix)}…</code> ${esc(t.label || '')} · ` +
              `${t.createdAt ? new Date(t.createdAt).toLocaleDateString() : ''} ` +
              `<button type="button" class="linklike" data-revoke="${esc(t.hash)}">revoke</button></li>`
            ).join('')
          : '<li>No tokens yet.</li>';
        list.querySelectorAll('[data-revoke]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const st = document.getElementById('tokenStatus');
            try {
              const rr = await apiFetch('/api/token?hash=' + encodeURIComponent(btn.dataset.revoke), { method: 'DELETE' });
              const jj = await rr.json().catch(() => ({}));
              if (!rr.ok) throw new Error(jj.error || ('HTTP ' + rr.status));
              if (st) st.textContent = 'Token revoked.';
              refreshTokens();
            } catch (e) {
              if (st) st.textContent = e.message || 'Revoke failed';
            }
          });
        });
      } catch {
        list.innerHTML = '<li>Could not load tokens.</li>';
      }
    }
    // Settings may open before Clerk finishes loading — refresh once ready.
    if (window.HabitAuth && typeof window.HabitAuth.onReady === 'function') {
      window.HabitAuth.onReady(() => {
        const panelEl = document.getElementById('settings');
        if (panelEl && panelEl.classList.contains('open')) refreshTokens();
      });
    }
    document.getElementById('mintToken')?.addEventListener('click', async () => {
      if (window.HabitAuth && !(await window.HabitAuth.ensureSignedIn())) return;
      const st = document.getElementById('tokenStatus');
      const once = document.getElementById('tokenOnce');
      st.textContent = 'Creating…';
      try {
        const r = await apiFetch('/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Stream Deck' })
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        st.textContent = 'Copy now — shown once.';
        once.style.display = 'block';
        once.textContent = j.token;
        refreshTokens();
      } catch (e) {
        st.textContent = e.message || 'Failed';
      }
    });

    let firstLoad = true;
    function refresh() {
      Promise.all([
        apiFetch('/api/data').then(r=>r.json()),
        apiFetch('/api/slots?track=1').then(r=>r.json()).catch(()=>null)
      ]).then(([d, s]) => {
        slotState = s;
        lastInsight = d.insight || null;
        document.getElementById('updated').textContent = 'Updated ' + new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
        if (d.configured === false) return renderSetup();
        lastEntries = d.entries || [];
        render(lastEntries);
        firstLoad = false;
      }).catch(() => {
        if (firstLoad) app.innerHTML = '<div class="empty">Couldn&rsquo;t load data. Refresh to retry.</div>';
      });
    }
    refresh();
    // The coach repaints its keys in near real time — keep the page live too.
    setInterval(refresh, 20000);
  
