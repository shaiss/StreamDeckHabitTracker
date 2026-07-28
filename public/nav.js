// Shared nav bar for all pages. No framework, no build step: each page adds
// <script src="/nav.js" defer></script> and the bar injects itself at the top
// of <body>. Theme: theme.css declares the tokens on <body>, where
// body[data-nav="dark"] forces the dark look (deck, mind) and everything else
// follows prefers-color-scheme (dashboard). The bar owns no colors of its own.
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

  // Chrome has no palette of its own: every value below is a theme.css token
  // (design/WEB-UX.md §2). The tokens are declared on <body> and .hnav lives
  // inside <body>, so var() resolves — which is why there is no light-mode
  // block here any more: --chrome, --fg and --line flip themselves.
  const css = `
    .hnav { position: sticky; top: 0; z-index: 90; width: 100%; display: flex; align-items: center; gap: var(--s1);
      padding: var(--s2) var(--s4); border-bottom: 1px solid var(--line);
      background: var(--chrome); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
      color: var(--fg); font: 14px/1 var(--font); }
    .hnav .brand { display: flex; align-items: center; gap: var(--s2); font-weight: 700; letter-spacing: -.01em;
      color: inherit; text-decoration: none; margin-right: var(--s3); padding: var(--s1); }
    /* Sanctioned ornament, not a container (WEB-UX §4: the brand dot is one of
       the two circles in the system). Its 10px size and 8px glow radius are
       optical, so they stay literal; the violet is the coach's. */
    .hnav .brand .dot { width: 10px; height: 10px; border-radius: 50%;
      background: radial-gradient(circle at 32% 30%, var(--violet-ink), var(--violet) 60%, var(--violet-deep));
      box-shadow: 0 0 8px color-mix(in oklab, var(--violet), transparent 20%); }
    .hnav .links { display: flex; gap: var(--s1); margin-left: auto; }
    .hnav .links a { display: flex; align-items: center; gap: var(--s2); padding: var(--s2) var(--s3);
      border-radius: var(--r-md); color: inherit; text-decoration: none; opacity: .72;
      transition: opacity .12s, background .12s; }
    .hnav .links a:hover { opacity: 1; background: color-mix(in oklab, var(--violet), transparent 88%); }
    .hnav .links a.active { opacity: 1; background: color-mix(in oklab, var(--violet), transparent 82%);
      box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--violet), transparent 65%); }
    @media (max-width: 620px) {
      .hnav .links a { padding: var(--s2); }
      .hnav .links a .lbl { display: none; }         /* icons only on phones */
      .hnav .brand .txt { font-size: 13.5px; }
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
