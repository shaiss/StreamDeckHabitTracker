// Shared nav bar for all pages. No framework, no build step: each page adds
// <script src="/nav.js" defer></script> and the bar injects itself at the top
// of <body>. Theme: body[data-nav="dark"] forces the dark look (deck, mind);
// default follows prefers-color-scheme (dashboard).
//
// Settings: on the dashboard (where #settings exists) the Settings item
// toggles the panel in place via a "toggle-settings" event; on other pages it
// navigates to /?settings=1 and the dashboard opens the panel on arrival.
(function () {
  const ITEMS = [
    { href: '/', icon: '📊', label: 'Dashboard' },
    { href: '/deck.html', icon: '🎛', label: 'Deck' },
    { href: '/habits.html', icon: '✅', label: 'Habits' },
    { href: '/mind.html', icon: '✨', label: 'Mind' },
    { href: '/?settings=1', icon: '⚙️', label: 'Settings', settings: true }
  ];
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const isActive = (it) => !it.settings && ((it.href.split('?')[0].replace(/\/+$/, '') || '/') === path);

  const css = `
    .hnav { position: sticky; top: 0; z-index: 90; width: 100%; display: flex; align-items: center; gap: 4px;
      padding: 9px 14px; border-bottom: 1px solid rgba(255,255,255,.09);
      background: rgba(11,12,16,.72); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
      color: #e8eaed; font: 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .hnav .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; letter-spacing: -.01em;
      color: inherit; text-decoration: none; margin-right: 10px; padding: 6px 4px; }
    .hnav .brand .dot { width: 10px; height: 10px; border-radius: 50%;
      background: radial-gradient(circle at 32% 30%, #c4b5fd, #8b5cf6 60%, #5b21b6);
      box-shadow: 0 0 8px rgba(139,92,246,.8); }
    .hnav .links { display: flex; gap: 4px; margin-left: auto; }
    .hnav .links a { display: flex; align-items: center; gap: 7px; padding: 8px 13px; border-radius: 10px;
      color: inherit; text-decoration: none; opacity: .72; transition: opacity .12s, background .12s; }
    .hnav .links a:hover { opacity: 1; background: rgba(139,92,246,.12); }
    .hnav .links a.active { opacity: 1; background: rgba(139,92,246,.18); box-shadow: inset 0 0 0 1px rgba(139,92,246,.35); }
    @media (max-width: 620px) {
      .hnav .links a { padding: 8px 11px; }
      .hnav .links a .lbl { display: none; }         /* icons only on phones */
      .hnav .brand .txt { font-size: 13.5px; }
    }
    @media (prefers-color-scheme: light) {
      body:not([data-nav="dark"]) .hnav { background: rgba(246,247,249,.82); color: #1a1c1f;
        border-bottom-color: #e3e5e9; }
      body:not([data-nav="dark"]) .hnav .links a:hover { background: rgba(109,40,217,.08); }
      body:not([data-nav="dark"]) .hnav .links a.active { background: rgba(109,40,217,.10);
        box-shadow: inset 0 0 0 1px rgba(109,40,217,.30); }
    }`;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const nav = document.createElement('nav');
  nav.className = 'hnav';
  nav.innerHTML =
    '<a class="brand" href="/"><span class="dot"></span><span class="txt">Habit Tracker</span></a>' +
    '<div class="links">' +
    ITEMS.map(
      (it) =>
        `<a href="${it.href}" ${isActive(it) ? 'class="active"' : ''} ${it.settings ? 'data-settings="1"' : ''}>` +
        `<span>${it.icon}</span><span class="lbl">${it.label}</span></a>`
    ).join('') +
    '</div>';
  document.body.insertAdjacentElement('afterbegin', nav);

  nav.querySelector('[data-settings]')?.addEventListener('click', (e) => {
    if (document.getElementById('settings')) {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('toggle-settings'));
    }
  });
})();
