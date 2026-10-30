import { io } from './io-log.mjs';

function read(name, value) {
  return async () => {
    io.reads.push(name);
    return typeof value === 'function' ? value() : value;
  };
}

function write(name) {
  return async () => {
    io.writes.push(name);
    return null;
  };
}

export const isConfigured = () => {
  io.reads.push('isConfigured');
  return true;
};
export const getSlots = read('getSlots', () => ({ suggestedAt: 1, slots: [null, null, null, null] }));
export const getCoachPage = read('getCoachPage', () => ({ slots: Array(12).fill(null) }));
export const getProfile = read('getProfile', null);
export const getRoster = read('getRoster', null);
export const all = read('all', () => []);
export const getSlotHistory = read('getSlotHistory', () => []);
export const getDeckState = read('getDeckState', null);
export const setDeckState = write('setDeckState');

export const append = write('append');
export const setSlots = write('setSlots');
export const setCoachPage = write('setCoachPage');
export const setRoster = write('setRoster');
export const setNudgeState = write('setNudgeState');
export const setProfile = write('setProfile');
export const redisCmd = write('redisCmd');
