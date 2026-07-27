// Page-visibility inference (issue #53). Pure and dependency-free, like
// scheduler.mjs and gestures.mjs, so the unit suite can pin it without an SDK.
//
// The plugin already had the signal and didn't use it: onWillAppear /
// onWillDisappear fire as pages change, and plugin.mjs maintains the `keys`
// map from exactly those events. Generated keys now carry { page: N } in
// their settings, so the set of currently-appeared keys tells us
//
//   - whether ANY of our keys are on screen (if none have appeared, our
//     profile isn't visible at all), and
//   - WHICH page of our profile is showing.
//
// That anyVisible bit is the enforcement point for the coach-navigation
// guardrail (#54): the coach may raise its voice in the room it is already
// in, but may not walk into another room. No new API needed.

// settingsList: the settings objects of every currently-appeared key.
// Returns { anyVisible, visiblePage }.
//
// visiblePage is the page tag most common among appeared keys — keys from
// two pages can briefly coexist mid-flip (disappear events trail the new
// page's appears), and the majority wins that race; ties break toward the
// LOWER page so a dead heat reads as "still where you were". Keys with no
// usable page tag (hand-placed, pre-#53 profiles) count toward anyVisible
// but abstain from the page vote; if nobody votes, visiblePage is null —
// visible, location unknown.
export function deriveVisibility(settingsList) {
  let any = false;
  const votes = new Map();
  for (const s of settingsList || []) {
    any = true;
    const page = s == null ? NaN : parseInt(s.page, 10);
    if (!Number.isInteger(page) || page < 0) continue;
    votes.set(page, (votes.get(page) || 0) + 1);
  }
  let visiblePage = null;
  let best = 0;
  for (const [page, n] of votes) {
    if (n > best || (n === best && visiblePage !== null && page < visiblePage)) {
      best = n;
      visiblePage = page;
    }
  }
  return { anyVisible: any, visiblePage };
}
