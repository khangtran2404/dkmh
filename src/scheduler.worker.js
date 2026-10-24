import { solve } from './scheduler.js';

self.onmessage = (e) => {
  try {
    self.postMessage({ ok: true, result: solve(e.data) });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.message || err) });
  }
};
