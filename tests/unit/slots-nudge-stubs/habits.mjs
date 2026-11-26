import { io } from './io-log.mjs';

export async function getHabits() {
  io.reads.push('getHabits');
  return [{ name: 'Water', emoji: '💧', label: 'Water' }];
}
