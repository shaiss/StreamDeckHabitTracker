import { io } from './io-log.mjs';

export async function nudgePass() {
  io.nudges.push('nudgePass');
  io.writes.push('nudgePass');
  return { nudged: false, skipped: 'stub' };
}
