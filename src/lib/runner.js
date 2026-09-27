// Splits the odds calculation across background workers (one per spare CPU core),
// merges their tallies, reports progress, and stops at the run target or the time limit.
// After the main odds finish, a second pass sharpens the "If draw" column (see planDrawPass).
import { prepareJob, newAcc, mergeAcc, finalize, finalizeTrack, accCombos, accBuckets, marginFor, exactAll, simulateBatch, planDrawPass } from "./live.js";
import OddsWorker from "./oddsWorker.js?worker&inline";

const DRAW_PASS_MS = 20000; // time limit for the "If draw" pass

// track: { i, left } runs "What you need" for one player instead of the whole table:
// every way their next `left` matches can go gets an equal share of runs.
export function runOddsLive(state, { K, drawRate, plan, onUpdate, track = null }) {
  const job = prepareJob(state, { K, drawRate, track });
  const merged = newAcc(state.n, accCombos(job), accBuckets(job));
  const started = performance.now();
  const target = job.mode === "exact" ? job.combos : plan.runs;
  let cancelled = false, lastEmit = 0, phase = null;
  const main = { done: false, stoppedByTime: false, elapsedMs: 0 };
  let dmerged = null, draw = null; // "If draw" pass tallies and progress

  const emit = (force) => {
    if (cancelled) return;
    const now = performance.now();
    if (!force && now - lastEmit < 400) return;
    lastEmit = now;
    const out = job.track ? finalizeTrack(job, merged) : finalize(state, job, merged, dmerged);
    onUpdate({
      ...out,
      target,
      margin: job.mode === "exact" ? 0 : marginFor(job.track ? merged.total / job.track.combos.length : merged.total),
      targetMargin: plan.targetMargin,
      stage: plan.stage,
      elapsedMs: main.done ? main.elapsedMs : now - started,
      done: main.done, stoppedByTime: main.stoppedByTime,
      draw: draw ? { ...draw, runs: dmerged.total } : null,
    });
  };

  phase = runPhase(job, target, merged, plan.timeLimitMs, (byTime) => {
    main.done = true; main.stoppedByTime = byTime; main.elapsedMs = performance.now() - started;
    const dp = planDrawPass(state, job, merged);
    if (dp && !cancelled) {
      dmerged = newAcc(state.n);
      draw = { target: dp.total, units: dp.quota.length, done: false, stoppedByTime: false };
      emit(true);
      const djob = { ...job, mode: "draw", drawUnits: dp.units, drawQuota: dp.quota };
      phase = runPhase(djob, dp.total, dmerged, DRAW_PASS_MS, (t) => { draw.done = true; draw.stoppedByTime = t; emit(true); });
    } else emit(true);
  });

  // One pass: split `total` runs of `pjob` across workers, merging into `acc`.
  function runPhase(pjob, total, acc, limitMs, onDone) {
    let finished = false, timer = null;
    const ws = [];
    const end = (byTime) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ws.forEach((w) => w.terminate());
      if (!cancelled) onDone(byTime);
    };
    let started = false;
    if (typeof Worker !== "undefined") {
      try {
        const cores = navigator.hardwareConcurrency || 4;
        const count = pjob.mode === "exact" ? 1 : Math.max(1, Math.min(8, cores - 1, total));
        let open = count;
        for (let k = 0; k < count; k++) {
          const w = new OddsWorker();
          w.onmessage = (e) => {
            if (finished || cancelled) return;
            mergeAcc(acc, e.data.acc);
            if (e.data.done) open--;
            if (open === 0) end(false); else emit(false);
          };
          w.onerror = () => { if (!finished && !cancelled) { ws.forEach((x) => x.terminate()); ws.length = 0; inPage(); } };
          w.postMessage(workerShare(pjob, total, count, k));
          ws.push(w);
        }
        started = true;
      } catch {
        ws.forEach((x) => x.terminate()); ws.length = 0;
      }
    }
    if (!started) inPage();

    // Fallback: same work in small slices on the page itself.
    function inPage() {
      if (pjob.mode === "exact") { mergeAcc(acc, exactAll(pjob)); end(false); return; }
      let scratch, attempts = 0;
      const step = () => {
        if (finished || cancelled) return;
        const t0 = performance.now();
        while (attempts < total && performance.now() - t0 < 50) {
          const b = Math.min(5, total - attempts);
          scratch = simulateBatch(pjob, b, acc, scratch);
          attempts += b;
        }
        if (attempts >= total) end(false);
        else { emit(false); setTimeout(step, 0); }
      };
      step();
    }

    timer = setTimeout(() => end(true), limitMs);
    return { stop: () => { finished = true; clearTimeout(timer); ws.forEach((w) => w.terminate()); } };
  }

  return () => { cancelled = true; phase?.stop(); };
}

// Worker k's share of a pass: an even split of the runs; in the "If draw" pass, of each unit's runs.
function workerShare(pjob, total, count, k) {
  if (pjob.mode !== "draw") return { job: pjob, quota: Math.ceil(total / count) };
  const q = new Int32Array(pjob.drawQuota.length);
  let sum = 0;
  for (let u = 0; u < q.length; u++) {
    const all = pjob.drawQuota[u];
    q[u] = Math.floor(all / count) + (k < all % count ? 1 : 0);
    sum += q[u];
  }
  return { job: { ...pjob, drawQuota: q }, quota: sum };
}
