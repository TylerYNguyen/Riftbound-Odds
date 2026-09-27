// Background worker: runs its share of the simulations and reports tallies every ~250 ms,
// so the page stays responsive and can show results as they come in.
import { exactAll, simulateBatch, newAcc, accCombos } from "./live.js";

self.onmessage = (e) => {
  const { job, quota } = e.data;
  if (job.mode === "exact") {
    const acc = exactAll(job);
    self.postMessage({ acc, done: true });
    return;
  }
  let done = 0, scratch;
  const step = () => {
    const acc = newAcc(job.n, accCombos(job));
    const t0 = performance.now();
    while (done < quota && performance.now() - t0 < 250) {
      const batch = Math.min(10, quota - done);
      scratch = simulateBatch(job, batch, acc, scratch);
      done += batch;
    }
    self.postMessage({ acc, done: done >= quota }, [acc.top.buffer, acc.rankSum.buffer, acc.cond.buffer, acc.d2.buffer, acc.tk.buffer]);
    if (done < quota) setTimeout(step, 0);
  };
  step();
};
