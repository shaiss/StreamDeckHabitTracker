// First blocking script on every HabitDeck page. Classic (not type=module,
// not defer, not async) so it runs as soon as it loads, before later scripts.
//
// A legacy ?key= is moved into sessionStorage and stripped with
// replaceState. The document GET itself can still appear in server logs;
// rejecting ?key= there is issue #115, not this file. Referrer-Policy:
// no-referrer on the response is what keeps the key out of Referer on
// subresources the preload scanner fetches in parallel with this script.
//
// Same store key and same URL rewrite as public/habit-key.js, which repeats
// the move as a backup if a page forgot this script.
(function (root) {
  'use strict';
  var STORE = 'habitdeck.key';

  function set(k) {
    k = (k == null ? '' : String(k)).trim();
    try {
      var s = root.sessionStorage;
      if (s) {
        if (k) s.setItem(STORE, k);
        else s.removeItem(STORE);
      }
    } catch (e) { /* locked-down storage: the backup in habit-key.js keeps it in memory */ }
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
