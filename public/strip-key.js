// First blocking script on every HabitDeck page. Classic (not type=module,
// not defer, not async) so it runs as soon as it loads, before later scripts.
//
// A legacy ?key= is moved into sessionStorage and stripped with
// replaceState. The URL is scrubbed even when that write fails. The
// document GET itself can still appear in server logs; rejecting ?key=
// there is issue #115, not this file. Referrer-Policy: no-referrer on the
// response is what keeps the key out of Referer on subresources the
// preload scanner fetches in parallel with this script.
//
// Same store key and same URL rewrite as public/habit-key.js, which repeats
// the move as a backup if a page forgot this script. When sessionStorage
// is missing or refuses the write, the key is left on a one-shot property
// (__habitdeckPendingKey) that habit-key.js copies into its page-lifetime
// memory and deletes. Nothing else is persisted.
(function (root) {
  'use strict';
  var STORE = 'habitdeck.key';

  function set(k) {
    k = (k == null ? '' : String(k)).trim();
    var stored = false;
    try {
      var s = root.sessionStorage;
      if (s) {
        if (k) s.setItem(STORE, k);
        else s.removeItem(STORE);
        stored = true;
      }
    } catch (e) { /* blocked, full, or private mode — storage did not take the key */ }
    // Handoff only when the key is not in sessionStorage. habit-key.js
    // consumes and deletes it at init. A successful write clears any leftover.
    if (stored || !k) {
      try { delete root.__habitdeckPendingKey; } catch (e2) { /* already gone */ }
    } else {
      root.__habitdeckPendingKey = k;
    }
  }

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
  } catch (e) { /* non-browser or locked-down history */ }
})(typeof window !== 'undefined' ? window : globalThis);
