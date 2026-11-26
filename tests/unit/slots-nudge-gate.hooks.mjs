// Test-only resolver: api/slots.js must load without Redis, the model, or
// @vercel/functions installed (the unit job does not npm install).
const STUBS = {
  '/lib/store.js': new URL('./slots-nudge-stubs/store.mjs', import.meta.url).href,
  '/lib/coach.js': new URL('./slots-nudge-stubs/coach.mjs', import.meta.url).href,
  '/lib/habits.js': new URL('./slots-nudge-stubs/habits.mjs', import.meta.url).href
};

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@vercel/functions') {
    return {
      shortCircuit: true,
      url: new URL('./slots-nudge-stubs/vercel-functions.mjs', import.meta.url).href
    };
  }
  const resolved = await nextResolve(specifier, context);
  for (const [suffix, url] of Object.entries(STUBS)) {
    if (resolved.url.endsWith(suffix)) return { shortCircuit: true, url };
  }
  return resolved;
}
