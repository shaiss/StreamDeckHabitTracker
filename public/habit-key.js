// HabitDeck write-key helper for the web UIs (deck, habits, dashboard).
// Load with <script src="/habit-key.js"></script> BEFORE the page script;
// it exposes window.HabitKey. Classic script on purpose: habits.html and
// index.html use classic scripts, deck.html's module reads the global.
//
// Rules (Cipher, public repo):
//  - The key is NEVER baked into a page and NEVER written to localStorage.
//    It lives in sessionStorage (this tab only) or, if that is unavailable,
//    in memory for the life of the page.
//  - Safety net only — never hand out URL-key links. strip-key.js is the
//    first blocking script in <head> and does the ?key= → sessionStorage
//    move + history.replaceState before other page scripts run. If that
//    write fails, strip-key.js leaves a one-shot __habitdeckPendingKey;
//    this file copies it into the memory fallback and deletes it. This
//    file also repeats the URL move so a page that forgot the head script
//    still scrubs the URL before it writes. The document GET can still
//    show up in server logs; rejecting ?key= there is issue #115, not
//    this file.
//  - Writes send it as the x-habit-key header only — never in the URL. The
//    server still accepts ?key= during #112's transition for older callers.
//  - The human is asked once, in-page, and only when the server says 401 —
//    with HABIT_KEY unset nobody is ever prompted.
//
// Reuse: HabitKey.fetch(url, init) for any write, HabitKey.postJson(url, body)
// for JSON POSTs (roster decide(), and #93's /api/targets decide()).
(function (root) {
  'use strict';
  var STORE = 'habitdeck.key';
  var HEADER = 'x-habit-key';
  var mem = '';

  function ss() {
    try { return root.sessionStorage || null; } catch (e) { return null; }
  }
  function get() {
    var s = ss();
    if (s) { try { var v = s.getItem(STORE); if (v) return v; } catch (e) { /* blocked */ } }
    return mem;
  }
  function set(k) {
    k = (k == null ? '' : String(k)).trim();
    mem = k;
    var s = ss();
    if (s) { try { if (k) s.setItem(STORE, k); else s.removeItem(STORE); } catch (e) { /* memory only */ } }
    return k;
  }
  function clear() { set(''); }

  // strip-key.js sets this only when sessionStorage did not take the key.
  // Copy it into the page-lifetime memory fallback, then drop the handoff
  // so the key does not stay on the global.
  function consumeHandoff() {
    var raw = '';
    try { raw = root.__habitdeckPendingKey; } catch (e) { raw = ''; }
    try { delete root.__habitdeckPendingKey; } catch (e) { /* undeletable */ }
    var k = (raw == null ? '' : String(raw)).trim();
    if (k) set(k);
  }

  // Legacy ?key= → sessionStorage, then scrub the URL.
  function migrateFromUrl() {
    try {
      var loc = root.location;
      if (!loc || !loc.href) return;
      var u = new URL(loc.href);
      if (!u.searchParams.has('key')) return;
      var k = u.searchParams.get('key');
      if (k) set(k);
      u.searchParams.delete('key');
      if (root.history && root.history.replaceState) {
        root.history.replaceState(root.history.state, '', u.pathname + u.search + u.hash);
      }
    } catch (e) { /* non-browser or locked-down history: leave as is */ }
  }

  // In-page prompt (masked input, not window.prompt). Resolves the entered
  // key, or '' when dismissed.
  function ask(message) {
    var doc = root.document;
    if (!doc || !doc.createElement || !doc.body) return Promise.resolve('');
    return new Promise(function (resolve) {
      var wrap = doc.createElement('div');
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-modal', 'true');
      wrap.setAttribute('aria-label', 'HabitDeck key');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;' +
        'justify-content:center;background:rgba(0,0,0,.55)';
      var form = doc.createElement('form');
      form.style.cssText = 'background:#1b1e24;color:#eef;padding:18px 20px;border-radius:12px;' +
        'max-width:340px;width:90%;font:14px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5)';
      var p = doc.createElement('p');
      p.style.margin = '0 0 10px';
      p.textContent = message || 'This HabitDeck needs its key to save changes. It stays in this tab only.';
      var input = doc.createElement('input');
      input.type = 'password';
      input.autocomplete = 'off';
      input.setAttribute('aria-label', 'HabitDeck key');
      input.style.cssText = 'width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid #445;' +
        'background:#0f1115;color:#eef;margin-bottom:10px';
      var row = doc.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
      var cancel = doc.createElement('button');
      cancel.type = 'button'; cancel.textContent = 'Cancel';
      var ok = doc.createElement('button');
      ok.type = 'submit'; ok.textContent = 'Use key';
      row.appendChild(cancel); row.appendChild(ok);
      form.appendChild(p); form.appendChild(input); form.appendChild(row);
      wrap.appendChild(form);
      function done(v) { try { wrap.remove(); } catch (e) { /* gone */ } resolve(v); }
      cancel.addEventListener('click', function () { done(''); });
      form.addEventListener('submit', function (ev) { ev.preventDefault(); done(set(input.value)); });
      doc.body.appendChild(wrap);
      try { input.focus(); } catch (e) { /* no focus */ }
    });
  }

  function withHeader(init, k) {
    init = Object.assign({}, init || {});
    var h = {};
    var src = init.headers || {};
    if (typeof src.forEach === 'function' && !Array.isArray(src)) src.forEach(function (v, n) { h[n] = v; });
    else if (Array.isArray(src)) src.forEach(function (p) { h[p[0]] = p[1]; });
    else Object.keys(src).forEach(function (n) { h[n] = src[n]; });
    if (k) h[HEADER] = k;
    init.headers = h;
    return init;
  }

  // Underlying transport: prefer HabitAuth.authFetch so Clerk Bearer is
  // layered on top of x-habit-key (never instead of it).
  function transport() {
    return (root.HabitAuth && root.HabitAuth.authFetch) || root.fetch;
  }

  // fetch() for writes: header-only key; on 401 ask once in-page and retry
  // once (a 401 means nothing was written, so the retry is safe).
  function keyedFetch(url, init) {
    var f = transport();
    return f(url, withHeader(init, get())).then(function (r) {
      if (r.status !== 401) return r;
      clear();
      return ask().then(function (k) {
        return k ? f(url, withHeader(init, k)) : r;
      });
    });
  }

  function postJson(url, payload) {
    return keyedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  consumeHandoff();
  migrateFromUrl();
  root.HabitKey = { get: get, set: set, clear: clear, ask: ask, fetch: keyedFetch, postJson: postJson,
    withHeader: withHeader, HEADER: HEADER, _migrateFromUrl: migrateFromUrl };
})(typeof window !== 'undefined' ? window : globalThis);
