// HTML responses in the e2e harness carry the same CSP and Referrer-Policy
// vercel.json will send, so a page that only works without the policy fails here.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const vercel = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../vercel.json', import.meta.url)), 'utf8')
);

export function documentHeaders() {
  const rule = (vercel.headers || []).find((h) => h.source === '/deck.html');
  if (!rule) throw new Error('vercel.json has no /deck.html headers');
  const headers = {};
  for (const h of rule.headers) headers[h.key] = h.value;
  return headers;
}
