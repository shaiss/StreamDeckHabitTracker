// Shared call log for the /api/slots nudge-gate unit test. No I/O.
export const io = {
  reads: [],
  writes: [],
  nudges: [],
  fetches: []
};

export function resetIo() {
  io.reads.length = 0;
  io.writes.length = 0;
  io.nudges.length = 0;
  io.fetches.length = 0;
}
