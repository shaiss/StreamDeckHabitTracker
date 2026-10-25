import { esc } from '/escape.js';

    // Hue is identity, derived and never chosen (design/WEB-UX.md §3). Same
    // FNV-1a as tools/lib-hue.mjs — a memory keeps its color for life instead
    // of borrowing the coach's reserved violet from a rotating palette.
    function hueFor(name) {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      let hue = h % 320; if (hue >= 245) hue += 40; return hue;
    }

    const apiFetch = (url, opts) =>
      (window.HabitAuth && window.HabitAuth.authFetch)
        ? window.HabitAuth.authFetch(url, opts)
        : fetch(url, opts);

    apiFetch('/api/mind').then(r=>r.json()).then(m => {
      if (!m.configured) { document.getElementById('tagline').textContent = 'Storage not connected yet.'; return; }
      if (m.authRequired) {
        document.getElementById('tagline').textContent = 'Sign in to see what the coach has learned.';
        return;
      }
      const s = m.stats || {};
      document.getElementById('tagline').textContent =
        (m.humanName ? `Learning ${m.humanName}` : 'Learning its human') +
        ` for ${s.daysTogether} day${s.daysTogether===1?'':'s'} · thinking with ${m.model || '—'}`;

      // growth tiles
      const tr = m.track?.overall || { offered: 0, landed: 0, hitRate: 0 };
      document.getElementById('tiles').innerHTML = [
        [s.tapsObserved ?? 0, 'taps observed'],
        [s.ideasTried ?? 0, 'ideas tried'],
        [tr.landed, 'intuitions that landed'],
        [tr.offered ? Math.round(tr.hitRate*100) + '%' : '—', 'intuition hit rate']
      ].map(([n,l]) => `<div class="card tile"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');

      // core memories: the coach's own notes, split into thoughts
      const notes = (m.memory?.notes || '').split(/\n+|(?<=[.!?])\s+(?=[A-Z"“])/).map(t=>t.trim()).filter(t=>t.length>8);
      if (notes.length) {
        document.getElementById('orbs').innerHTML = notes.slice(0, 10).map((t) =>
          `<div class="card orb"><span class="ball" style="--c:hsl(${hueFor(t)},62%,60%)"></span><span class="t">${esc(t)}</span></div>`
        ).join('');
      }

      // intuitions: current slots + behavioral confidence
      const per = Object.fromEntries((m.track?.perHabit||[]).map(r=>[r.habit,r]));
      const conf = (h) => {
        const r = per[h];
        if (!r || r.offered < 1) return 'NEW INTUITION';
        if (r.taps === 0) return 'TESTING · not yet felt';
        if (r.hitRate >= 0.6) return `TRUSTED · landed ${r.landed}/${r.offered}`;
        return `FORMING · landed ${r.landed}/${r.offered}`;
      };
      document.getElementById('ints').innerHTML = (m.slots||[]).map((d,i) => d
        ? `<div class="card int"><div class="head"><span class="em">${esc(d.emoji)}</span><span class="nm">${esc(d.label||d.habit)}</span></div>
             <div class="why">${esc(d.reason||'')}</div><div class="tag conf">${conf(d.habit)}</div></div>`
        : `<div class="card int empty">quiet corner ${i+1}</div>`
      ).join('');

      // reflection
      if (m.insight?.text) {
        document.getElementById('reflect').innerHTML =
          `<div class="note"><div class="d">${esc(m.insight.date||'')}</div>${esc(m.insight.text)}</div>`;
      }
    }).catch(() => {
      document.getElementById('tagline').textContent = 'Couldn’t reach the coach — refresh to retry.';
    });
  
