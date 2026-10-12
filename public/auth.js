// Shared Clerk auth for static pages (no build step).
//
// Loads Clerk JS from the CDN after fetching CLERK_PUBLISHABLE_KEY from
// /api/auth/config. Exposes window.HabitAuth for deck/dashboard/habits/mind.
//
// E2E: set window.__HABIT_AUTH_MOCK__ before this module runs:
//   { signedIn: true|false, getToken: async () => '…' }
(function (global) {
  const MOCK = global.__HABIT_AUTH_MOCK__ || null;
  let clerk = null;
  let ready = false;
  let readyPromise = null;
  let signInHost = null;

  function ensureHost() {
    if (signInHost) return signInHost;
    signInHost = document.createElement('div');
    signInHost.id = 'habit-auth-modal';
    signInHost.setAttribute('hidden', '');
    signInHost.innerHTML =
      '<div class="habit-auth-backdrop" data-close="1"></div>' +
      '<div class="habit-auth-panel" role="dialog" aria-modal="true" aria-label="Sign in">' +
      '<button type="button" class="habit-auth-x" data-close="1" aria-label="Close">×</button>' +
      '<p class="habit-auth-msg">Sign in to log habits and sync your Stream Deck.</p>' +
      '<div id="habit-auth-sign-in"></div>' +
      '</div>';
    const style = document.createElement('style');
    style.textContent =
      '#habit-auth-modal{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;}' +
      '#habit-auth-modal[hidden]{display:none!important;}' +
      '.habit-auth-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.55);}' +
      '.habit-auth-panel{position:relative;z-index:1;max-width:420px;width:min(92vw,420px);' +
      'background:var(--card,#1a1b1f);color:var(--fg,#eee);border:1px solid var(--line,#333);' +
      'border-radius:16px;padding:20px 20px 24px;box-shadow:0 20px 50px rgba(0,0,0,.45);}' +
      '.habit-auth-x{position:absolute;top:8px;right:10px;border:0;background:transparent;color:inherit;' +
      'font-size:22px;cursor:pointer;opacity:.7;}' +
      '.habit-auth-msg{margin:0 0 14px;font:14px/1.4 system-ui,sans-serif;opacity:.85;}';
    document.head.appendChild(style);
    document.body.appendChild(signInHost);
    signInHost.addEventListener('click', (e) => {
      if (e.target && e.target.dataset && e.target.dataset.close) hideSignIn();
    });
    return signInHost;
  }

  function hideSignIn() {
    if (!signInHost) return;
    signInHost.setAttribute('hidden', '');
  }

  function showSignIn() {
    if (MOCK) {
      const hint = document.getElementById('hint');
      if (hint) hint.innerHTML = '<b>Sign in to log habits.</b>';
      return;
    }
    const host = ensureHost();
    host.removeAttribute('hidden');
    const mount = document.getElementById('habit-auth-sign-in');
    if (clerk && mount && !mount.dataset.mounted) {
      mount.dataset.mounted = '1';
      clerk.mountSignIn(mount);
    }
  }

  async function loadClerk(publishableKey) {
    if (global.Clerk && global.Clerk.loaded) {
      clerk = global.Clerk;
      return clerk;
    }
    // Derive Frontend API host from the publishable key (Clerk JS quickstart).
    let fapi;
    try {
      fapi = atob(publishableKey.split('_')[2]).slice(0, -1);
    } catch {
      throw new Error('Invalid CLERK_PUBLISHABLE_KEY');
    }
    await new Promise((resolve, reject) => {
      const ui = document.createElement('script');
      ui.defer = true;
      ui.crossOrigin = 'anonymous';
      ui.src = `https://${fapi}/npm/@clerk/ui@1/dist/ui.browser.js`;
      ui.onload = resolve;
      ui.onerror = () => reject(new Error('Failed to load Clerk UI'));
      document.head.appendChild(ui);
    });
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.defer = true;
      s.crossOrigin = 'anonymous';
      s.dataset.clerkPublishableKey = publishableKey;
      s.src = `https://${fapi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load Clerk'));
      document.head.appendChild(s);
    });
    // clerk.browser.js exposes window.Clerk
    const deadline = Date.now() + 8000;
    while (!global.Clerk && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!global.Clerk) throw new Error('Clerk global missing');
    clerk = global.Clerk;
    await clerk.load({
      ui: { ClerkUI: global.__internal_ClerkUICtor }
    });
    return clerk;
  }

  async function init() {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      if (MOCK) {
        ready = true;
        return;
      }
      try {
        const cfg = await fetch('/api/auth/config').then((r) => r.json());
        if (!cfg.publishableKey) {
          ready = true; // fail closed on writes; pages still render
          return;
        }
        await loadClerk(cfg.publishableKey);
        ready = true;
        mountNavChip();
      } catch (err) {
        console.warn('HabitAuth init failed', err);
        ready = true;
      }
    })();
    return readyPromise;
  }

  function isSignedIn() {
    if (MOCK) return !!MOCK.signedIn;
    return !!(clerk && clerk.user);
  }

  async function getToken() {
    if (MOCK) return MOCK.getToken ? await MOCK.getToken() : 'mock-session';
    if (!clerk || !clerk.session) return null;
    try {
      return await clerk.session.getToken();
    } catch {
      return null;
    }
  }

  /** Prompt sign-in if needed. Returns true when the caller may proceed. */
  async function ensureSignedIn() {
    await init();
    if (isSignedIn()) return true;
    showSignIn();
    return false;
  }

  /**
   * fetch() with Authorization: Bearer <session> when signed in.
   * Also keeps legacy ?key= for plugin-token testing from the browser.
   */
  async function authFetch(url, opts = {}) {
    await init();
    const headers = new Headers(opts.headers || {});
    if (isSignedIn()) {
      const tok = await getToken();
      if (tok) headers.set('Authorization', 'Bearer ' + tok);
    }
    return fetch(url, { ...opts, headers });
  }

  function mountNavChip() {
    const nav = document.querySelector('.hnav .links');
    if (!nav || nav.querySelector('[data-habit-auth]')) return;
    const a = document.createElement('a');
    a.href = '#';
    a.dataset.habitAuth = '1';
    a.innerHTML = '<span>👤</span><span class="lbl">' + (isSignedIn() ? 'Account' : 'Sign in') + '</span>';
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      if (isSignedIn()) {
        // Mount user button in a tiny popover host
        let host = document.getElementById('habit-user-btn');
        if (!host) {
          host = document.createElement('div');
          host.id = 'habit-user-btn';
          host.style.cssText = 'position:fixed;top:52px;right:12px;z-index:210;';
          document.body.appendChild(host);
          clerk.mountUserButton(host);
        }
        return;
      }
      showSignIn();
    });
    nav.appendChild(a);
    if (clerk) {
      clerk.addListener(({ user }) => {
        a.querySelector('.lbl').textContent = user ? 'Account' : 'Sign in';
        if (user) hideSignIn();
      });
    }
  }

  const api = {
    init,
    isSignedIn,
    getToken,
    ensureSignedIn,
    authFetch,
    showSignIn,
    hideSignIn
  };
  global.HabitAuth = api;

  // Kick off as soon as the DOM can hold the nav chip.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); });
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
