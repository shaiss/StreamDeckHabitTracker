// Custom fetch for z.ai / GLM via the OpenAI-compatible provider.
// GLM-5.x are hybrid reasoning models — without thinking:disabled they burn
// the whole token budget thinking and return empty content (PR #2). This is
// the only guardrail; never wire a coach model call without it.
//
// Kept dependency-free so the unit suite can pin the inject without pulling
// the AI SDK (CI's unit job runs no `npm install`).

export function withThinkingDisabled(url, init) {
  if (init?.body && String(url).includes('/chat/completions')) {
    try {
      const body = JSON.parse(init.body);
      if (!body.thinking) body.thinking = { type: 'disabled' };
      return { ...init, body: JSON.stringify(body) };
    } catch {
      /* pass through untouched */
    }
  }
  return init;
}

export function zaiFetch(url, init) {
  return fetch(url, withThinkingDisabled(url, init));
}
