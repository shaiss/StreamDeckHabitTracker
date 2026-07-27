// Wall-clock deadline bookkeeping for the slot poll — the pure core of the old
// page pump(). Every guard is a deadline, never a boolean: a backend that
// accepts a connection and goes silent must not be able to wedge the sync.
// `seq` orphans a stuck poll so its late settle can't clear the guard that now
// belongs to the retry.
export function createScheduler({ pollMs, timeoutMs, recheckMs }) {
  let nextPollAt = 0;      // routine-poll deadline; 0 = due now
  let rechecks = [];       // wall-clock deadlines queued by taps
  let inflightAt = 0;      // when the in-flight poll started; 0 = idle
  let seq = 0;             // poll generation

  return {
    pump(now) {
      let expired = false;
      if (inflightAt && now - inflightAt > timeoutMs) {
        inflightAt = 0;
        seq++;             // orphan the stuck poll
        nextPollAt = 0;    // its data is overdue — retry now, not at the
                           // routine deadline the stuck poll had claimed
        expired = true;
      }
      let due = now >= nextPollAt;
      rechecks = rechecks.filter((t) => {
        if (now >= t) { due = true; return false; }
        return true;
      });
      return { expired, poll: due && !inflightAt };
    },
    pollStarted(now) {
      inflightAt = now;
      nextPollAt = now + pollMs;
      return ++seq;
    },
    pollSettled(s) {
      if (s !== seq) return false;   // pump() already gave up on this poll
      inflightAt = 0;
      return true;
    },
    tapped(now) {
      nextPollAt = 0;
      for (const d of recheckMs) rechecks.push(now + d);
    },
    forcePoll() { nextPollAt = 0; }
  };
}
