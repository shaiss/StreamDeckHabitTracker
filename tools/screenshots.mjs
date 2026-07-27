// Regenerates the README screenshots in docs/screenshots/.
//
// The pages are the REAL ones from public/ — same HTML, same render code, same
// key-face pipeline — served by a mock backend that returns demo data, exactly
// like tests/e2e/*. Nothing here is hand-drawn or retouched: change the UI, run
// this, and the screenshots follow. Demo data (not anyone's real log) so the
// docs don't publish a personal history.
//
//   npm i playwright-core --no-save && node tools/screenshots.mjs
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('../public', import.meta.url));
const REPO = fileURLToPath(new URL('../', import.meta.url));
const OUT = join(REPO, 'docs', 'screenshots');
mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.gif': 'image/gif', '.png': 'image/png', '.svg': 'image/svg+xml'
};

// The demo habit list is defined HERE, not read from config/habits.json.
// config/habits.json is a real person's habit list; screenshots go in a public
// README, and those two facts should never be coupled. Editing your own habits
// must never quietly republish them as documentation. Keep this list generic.
const HABITS = [
  { emoji: '🚽', label: 'Pee', name: 'Pee' },
  { emoji: '💩', label: 'Poop', name: 'Poop' },
  { emoji: '🍽', label: 'Eat', name: 'Eat' },
  { emoji: '💧', label: 'Drink', name: 'Drink' },
  { emoji: '🏃', label: 'Exercise', name: 'Exercise' },
  { emoji: '💊', label: 'Meds', name: 'Meds' }
];

// A believable day: taps spread through today plus a few prior days so streaks
// and progress rings have something to show.
const now = Date.now();
const H = 3600_000, D = 86400_000;
const entries = [];
const add = (h, e, t) => entries.push({ h, e, t });
for (let d = 6; d >= 1; d--) {
  add('Drink', '💧', now - d * D - 9 * H);
  add('Drink', '💧', now - d * D - 5 * H);
  add('Eat', '🍽', now - d * D - 7 * H);
  add('Pee', '🚽', now - d * D - 6 * H);
  if (d % 2 === 0) add('Exercise', '🏃', now - d * D - 10 * H);
}
add('Drink', '💧', now - 7 * H);
add('Eat', '🍽', now - 6 * H);
add('Drink', '💧', now - 4 * H);
add('Pee', '🚽', now - 3 * H);
add('Exercise', '🏃', now - 2 * H);
add('Drink', '💧', now - 40 * 60_000);
entries.sort((a, b) => a.t - b.t);

const slots = [
  { habit: 'Stretch', emoji: '🧘', label: 'Stretch', reason: 'You log Exercise but never a cooldown — I want to see whether that changes how the evening goes.', assignedAt: now - 2 * H },
  { habit: 'Focus', emoji: '🎯', label: 'Focus', reason: 'Your taps cluster at 09:00 and 21:00 with a hole in between. Tell me when a deep block starts.', assignedAt: now - 2 * H },
  { habit: 'Sunlight', emoji: '☀️', label: 'Sunlight', reason: 'Testing a hypothesis: morning light lands before your best Exercise days.', assignedAt: now - 55 * 60_000 },
  { habit: 'GoodMeal', emoji: '👍', label: 'Good?', reason: 'You just tapped Eat — was it worth repeating? This key expires in two hours.', assignedAt: now - 6 * 60_000 }
];

// Mirrors lib/today.js so the deck renders real rings/streaks.
const tzOffsetMin = 0;
const dayOf = (t) => Math.floor((t - tzOffsetMin * 60_000) / D);
const todayIdx = dayOf(now);
const today = {};
for (const h of HABITS) {
  const ts = entries.filter((e) => e.h === h.name).map((e) => e.t);
  const days = new Set(ts.map(dayOf));
  const count = ts.filter((t) => dayOf(t) === todayIdx).length;
  const goal = 1;
  let streak = 0, cursor = days.has(todayIdx) ? todayIdx : todayIdx - 1;
  while (days.has(cursor)) { streak++; cursor--; }
  today[h.name] = { count, goal, doneToday: count >= goal, streak, ringFill: Math.min(1, count / goal) };
}

const slotsPayload = {
  configured: true, aiReady: true, model: 'glm-5.2', suggestedAt: now - 2 * H,
  habits: HABITS, slots, today,
  track: { overall: { offered: 18, landed: 11, hitRate: 11 / 18 } },
  deck: { at: now - 12_000, agoMs: 12_000, plugin: '2.1.0', keys: 11 }
};

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/slots') return json(slotsPayload);
  if (url === '/api/mind') return json({
    configured: true, aiReady: true, model: 'glm-5.2', humanName: '',
    memory: { notes: 'Drink is the anchor habit — it fires reliably and everything else clusters around it.\nExercise lands far more often on days that start before 09:00, and I want another week of evidence before acting on it.\nFood-feedback keys get tapped within minutes or not at all; a two-hour TTL is the right window.\nPee/Poop are dense and involuntary — useful as a timeline backbone, not as a target to nudge.', updatedAt: now - 2 * H },
    insight: { text: 'You drank six times today and moved once — the pattern holds on days you tap Sunlight early. I am keeping that key.', date: 'today', at: now - 3 * H },
    slots, suggestedAt: now - 2 * H,
    track: {
      overall: { offered: 18, landed: 11, hitRate: 11 / 18 },
      perHabit: [
        { habit: 'Stretch', offered: 4, landed: 3, hitRate: 0.75 },
        { habit: 'Focus', offered: 5, landed: 2, hitRate: 0.4 },
        { habit: 'Sunlight', offered: 3, landed: 3, hitRate: 1 },
        { habit: 'GoodMeal', offered: 6, landed: 3, hitRate: 0.5 }
      ]
    },
    stats: { tapsObserved: entries.length, daysTogether: 24, ideasTried: 9, assignments: 31 }
  });

  if (url === '/api/data') return json({
    configured: true, entries,
    insight: { text: 'You drank six times today and moved once — the pattern holds on days you tap Sunlight early. I am keeping that key.', at: now - 3 * H }
  });
  if (url === '/api/profile') return json({ tz: 'America/New_York', effectiveTz: 'America/New_York', name: '', about: '', updatedAt: 0 });
  if (url === '/api/habits') return json({ habits: HABITS });
  const p = join(ROOT, url === '/' ? 'index.html' : url);
  if (existsSync(p) && !p.includes('..')) {
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(readFileSync(p));
  } else { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--force-color-profile=srgb', '--font-render-hinting=none']
});

const shoot = async (path, file, { width, height, full = false, wait = 2500, scheme = 'light' }) => {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: scheme });
  await page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(wait);
  await page.screenshot({ path: join(OUT, file), fullPage: full });
  console.log('wrote', file);
  await page.close();
};

await shoot('/deck.html', 'virtual-deck.png', { width: 1000, height: 640, scheme: 'dark' });
await shoot('/', 'dashboard.png', { width: 1100, height: 1180, scheme: 'dark' });
await shoot('/mind.html', 'coach-mind.png', { width: 1000, height: 1080, scheme: 'dark' });

await browser.close();
server.close();
