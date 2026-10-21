"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.retry = retry;
const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
async function retry(work, { delay = 200, attempts = 3, signal } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await work(attempt);
    } catch (error) {
      last = error;
      if (attempt < attempts) await wait(delay * 2 ** (attempt - 1), signal);
    }
  }
  throw last;
}
exports.default = retry;
