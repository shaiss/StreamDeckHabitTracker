const pending = [];

export function waitUntil(p) {
  pending.push(Promise.resolve(p).then(() => {}, () => {}));
}

export function flushWaits() {
  return Promise.all(pending.splice(0));
}
