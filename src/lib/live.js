// Live-event odds engine.
// 1) buildState(): turns the fetched event into current records + tiebreaker inputs.
// 2) prepareJob(): packs everything still unknown into a plain object a background
//    worker can run.
// 3) exactAll() / simulateBatch(): play out what's left — every combination when only
//    this round's unfinished matches remain, otherwise by simulation — adding up how
//    often each player finishes inside the top K.
// 4) finalize(): turns those tallies into percentages.
//
// Stats live in flat typed arrays so a run can be copied quickly even with thousands of players.

const RES = { W: 0, D: 1, L: 2 };
export const RES_LABEL = ["W", "D", "L"];
export const EXACT_LIMIT = 8; // up to 3^8 = 6,561 combinations
export const RANK_EXACT_MAX = 128; // events up to this many (ranked) players track every finishing place

function isComplete(m) {
  return m.status === "COMPLETE" || m.winner != null || m.isDraw || m.isDoubleLoss;
}

/* ---------- per-player stat arrays ---------- */
function newStats(n, maxR) {
  return {
    n, maxR,
    pts: new Int16Array(n), w: new Int16Array(n), l: new Int16Array(n), d: new Int16Array(n),
    played: new Int16Array(n), byes: new Int16Array(n),
    // games won, games drawn, games played (for game win %)
    gw: new Float64Array(n), gd: new Float64Array(n), gp: new Float64Array(n),
    opp: new Int32Array(n * maxR), oppN: new Int16Array(n),
  };
}
function cloneStats(s) {
  return {
    n: s.n, maxR: s.maxR,
    pts: s.pts.slice(), w: s.w.slice(), l: s.l.slice(), d: s.d.slice(),
    played: s.played.slice(), byes: s.byes.slice(), gw: s.gw.slice(), gd: s.gd.slice(), gp: s.gp.slice(),
    opp: s.opp.slice(), oppN: s.oppN.slice(),
  };
}
function copyInto(dst, src) {
  dst.pts.set(src.pts); dst.w.set(src.w); dst.l.set(src.l); dst.d.set(src.d);
  dst.played.set(src.played); dst.byes.set(src.byes); dst.gw.set(src.gw); dst.gd.set(src.gd); dst.gp.set(src.gp);
  dst.opp.set(src.opp); dst.oppN.set(src.oppN);
}
function addOpp(s, a, b) {
  if (s.oppN[a] < s.maxR) s.opp[a * s.maxR + s.oppN[a]++] = b;
  if (s.oppN[b] < s.maxR) s.opp[b * s.maxR + s.oppN[b]++] = a;
}
function hasPlayed(s, a, b) {
  const base = a * s.maxR, end = base + s.oppN[a];
  for (let k = base; k < end; k++) if (s.opp[k] === b) return true;
  return false;
}
// A bye counts as a 2-0 match win (for game win % too), with no opponent.
function applyBye(s, i) { s.pts[i] += 3; s.w[i]++; s.played[i]++; s.byes[i]++; s.gw[i] += 2; s.gp[i] += 2; }
function applyWin(s, a, b, gW, gL, gD) {
  s.pts[a] += 3; s.w[a]++; s.l[b]++; s.played[a]++; s.played[b]++;
  const g = gW + gL + gD;
  s.gw[a] += gW; s.gw[b] += gL; s.gd[a] += gD; s.gd[b] += gD; s.gp[a] += g; s.gp[b] += g;
  addOpp(s, a, b);
}
// A drawn match: each player won `each` games, and `drawn` games were drawn.
function applyDraw(s, a, b, each, drawn) {
  s.pts[a]++; s.pts[b]++; s.d[a]++; s.d[b]++; s.played[a]++; s.played[b]++;
  const g = 2 * each + drawn;
  s.gw[a] += each; s.gw[b] += each; s.gd[a] += drawn; s.gd[b] += drawn; s.gp[a] += g; s.gp[b] += g;
  addOpp(s, a, b);
}
function applyDoubleLoss(s, a, b) {
  s.l[a]++; s.l[b]++; s.played[a]++; s.played[b]++;
  addOpp(s, a, b);
}
// A match loss with no opponent (e.g. a no-show in round 1): 0 points, no opponent for tiebreakers.
function applySoloLoss(s, i) { s.l[i]++; s.played[i]++; }
// A simulated result, from a's point of view. Wins are 2-0 or 2-1; a draw is 1-1 with one
// drawn game (by far the most common drawn score at real events).
function applyResult(s, a, b, res, games = 3) {
  if (res === RES.D) applyDraw(s, a, b, 1, 1);
  else {
    const [win, lose] = res === RES.W ? [a, b] : [b, a];
    applyWin(s, win, lose, 2, games === 3 ? 1 : 0, 0);
  }
}
function randomResult(s, a, b, d) {
  const x = Math.random();
  const res = x < d ? RES.D : x < d + (1 - d) / 2 ? RES.W : RES.L;
  applyResult(s, a, b, res, Math.random() < 0.5 ? 2 : 3);
  return res;
}
const flip = (r) => (r === RES.W ? RES.L : r === RES.L ? RES.W : RES.D);

/* ---------- build the current state from fetched data ---------- */
// rewindTo: a round number. Rebuilds the event as it stood when that round's pairings
// went up — earlier rounds count, that round's matches are all treated as unplayed,
// later rounds are ignored (they get re-simulated).
// eligibleIds: only these players are ranked (e.g. the players who made Day 2). Everyone
// else still counts as an opponent for tiebreakers.
// day2: { threshold, rounds } — in a Day 1 view, also play Day 2: after Day 1 only players on
// `threshold`+ points keep going for `rounds` more rounds, and only they can make the top cut.
export function buildState(data, { roundsTotal, rewindTo = null, eligibleIds = null, day2 = null } = {}) {
  const players = []; // {id, name, handle}
  const index = new Map();
  const add = (p) => {
    if (!index.has(p.id)) {
      index.set(p.id, players.length);
      players.push({ id: p.id, name: p.name, handle: p.handle || p.name, legend: null, status: null });
    }
    const pl = players[index.get(p.id)];
    // Rounds are read in order, so the last one seen is the most recent.
    if (p.legend) pl.legend = p.legend;
    if (p.status) pl.status = p.status;
    return index.get(p.id);
  };
  const allPaired = (data.rounds || []).filter((r) => r.hasPairings && r.matches.length);
  const paired = rewindTo ? allPaired.filter((r) => r.number <= rewindTo) : allPaired;
  // Register everyone who ever played, so rewound views list the same players.
  for (const r of allPaired) for (const m of r.matches) for (const p of m.players) add(p);

  const planned = data.swiss?.plannedRounds || allPaired.length;
  const total = Math.max(allPaired.length, roundsTotal || planned || allPaired.length);

  const n = players.length;
  const day2Rounds = day2 && day2.rounds > 0 ? day2.rounds : 0;
  const base = newStats(n, total + day2Rounds + 1);
  const pending = []; // {a, b, table, round}
  for (const r of paired) {
    for (const m of r.matches) {
      const ids = m.players.map((p) => index.get(p.id));
      if (ids.length === 1 && !m.isBye && m.isDoubleLoss) {
        // One player with a match loss and no winner (a no-show). Big events have dozens in round 1.
        applySoloLoss(base, ids[0]);
      } else if (m.isBye || ids.length === 1) {
        applyBye(base, ids[0]);
      } else if (isComplete(m) && r.number !== rewindTo) {
        const [a, b] = ids;
        if (m.isDoubleLoss) applyDoubleLoss(base, a, b);
        else if (m.isDraw || m.winner == null) {
          // e.g. 1-1-1 played out, or 0-0-1 for an intentional draw (missing scores count as 0)
          applyDraw(base, a, b, ((m.gamesWinner ?? 0) + (m.gamesLoser ?? 0)) / 2, m.gamesDrawn ?? 0);
        } else {
          const winnerIdx = index.get(m.winner);
          const loserIdx = winnerIdx === a ? b : a;
          applyWin(base, winnerIdx, loserIdx, m.gamesWinner ?? 2, m.gamesLoser ?? 0, m.gamesDrawn ?? 0);
        }
      } else {
        pending.push({ a: ids[0], b: ids[1], table: m.table, round: r.number });
      }
    }
  }

  const lastPaired = paired[paired.length - 1];
  const active = new Uint8Array(n);
  if (lastPaired) for (const m of lastPaired.matches) for (const p of m.players) active[index.get(p.id)] = 1;
  if (!rewindTo) {
    // Players the locator lists as dropped don't get paired in future rounds
    // (their match this round, if any, still counts).
    for (let i = 0; i < n; i++) if (/DROP/i.test(players[i].status || "")) active[i] = 0;
  } else {
    // Rewound: the locator only knows today's status, so rebuild it from the pairings.
    // Paired in the rewound round = still in; otherwise they had dropped by then.
    const inRound = new Set();
    const rr = allPaired.find((r) => r.number === rewindTo);
    if (rr) for (const m of rr.matches) for (const p of m.players) inRound.add(index.get(p.id));
    for (let i = 0; i < n; i++) players[i].status = inRound.has(i) ? "COMPLETE" : "DROPPED";
  }

  const futureRounds = Math.max(0, total - paired.length);
  const currentRound = pending.length ? pending[0].round : lastPaired?.number || 0;
  const roundsLeft = futureRounds + (pending.length ? 1 : 0);

  const eligible = new Uint8Array(n);
  let eligibleCount = 0;
  for (let i = 0; i < n; i++) if (!eligibleIds || eligibleIds.has(players[i].id)) { eligible[i] = 1; eligibleCount++; }

  return {
    players, n, base, pending, active, futureRounds, eligible, eligibleCount,
    roundsPaired: paired.length, roundsTotal: total, plannedRounds: planned,
    currentRound, roundsLeft,
    day2Rounds, day2T: day2Rounds ? day2.threshold : null,
    roundInProgress: pending.length > 0,
    // Nothing reported yet in round 1: every player is treated as starting equal. Not when
    // the event hands out round 1 byes (big events give them to half the field) or losses:
    // then records already differ, so the odds are simulated. One bye from an odd count is fine.
    freshStart: currentRound === 1 && !Array.from(base.played).some((p, i) => p > base.byes[i])
      && base.byes.reduce((t, b) => t + b, 0) <= 1,
    rewindTo,
    roundsAvailable: allPaired.map((r) => r.number),
  };
}

/* ---------- tiebreakers, exactly as the event locator computes them ----------
   Checked against the locator's official standings for three 1,800+ player events (every
   player's points and game win %, and the full order): points, then opponents' match win %,
   then game win %, then opponents' game win %.
   - Match win % = match points / (3 x rounds played, byes and no-show losses included), at least 0.33.
   - Game win % = (3 x games won + games drawn) / (3 x games played), at least 0.33.
     A bye counts as winning 2-0.
   - Opponents' % = the average over real opponents (byes don't count as an opponent). */
export const TB_FLOOR = 0.33;
export function tiebreakers(s) {
  const n = s.n, R = s.maxR;
  const mwp = new Float64Array(n), gwp = new Float64Array(n), omw = new Float64Array(n), ogw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    mwp[i] = Math.max(TB_FLOOR, s.played[i] ? s.pts[i] / (3 * s.played[i]) : 0);
    gwp[i] = Math.max(TB_FLOOR, s.gp[i] ? (3 * s.gw[i] + s.gd[i]) / (3 * s.gp[i]) : 0);
  }
  for (let i = 0; i < n; i++) {
    const c = s.oppN[i];
    if (!c) continue;
    let a = 0, b = 0;
    for (let k = i * R, e = k + c; k < e; k++) { const j = s.opp[k]; a += mwp[j]; b += gwp[j]; }
    omw[i] = a / c; ogw[i] = b / c;
  }
  return { mwp, gwp, omw, ogw };
}

/** Order players best-first: points, then opponents' match win %, game win %, opponents' game
 *  win % (compared to 8 decimals, like the locator). Players equal on all four are an exact tie
 *  (`same`) and share any cut spot between them. */
function rankGroups(s, scratch) {
  const n = s.n;
  const t = tiebreakers(s);
  const keys = scratch?.keys || new Float64Array(n);
  for (let i = 0; i < n; i++) keys[i] = s.pts[i] * 1e9 + Math.round(t.omw[i] * 1e8);
  const { gwp, ogw } = t;
  const order = scratch?.order || new Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((i, j) => keys[j] - keys[i] || gwp[j] - gwp[i] || ogw[j] - ogw[i]);
  const same = (i, j) => keys[i] === keys[j] && Math.abs(gwp[i] - gwp[j]) < 1e-9 && Math.abs(ogw[i] - ogw[j]) < 1e-9;
  return { order, t, same };
}

/** Current standings as they are right now. */
export function currentStandings(state) {
  const { base, players } = state;
  const { order: all, t, same } = rankGroups(base);
  const order = all.filter((i) => state.eligible[i]);
  const rows = [];
  let start = 0;
  for (let k = 0; k < order.length; k++) {
    if (k > 0 && !same(order[k], order[k - 1])) start = k;
    const i = order[k];
    const tied = (k > 0 && same(order[k - 1], i)) || (k + 1 < order.length && same(order[k + 1], i));
    rows.push({
      i, rank: start + 1, tied, ...players[i],
      w: base.w[i], l: base.l[i], d: base.d[i], pts: base.pts[i],
      gwp: t.gwp[i], omw: t.omw[i], ogw: t.ogw[i],
    });
  }
  return rows;
}

/* ---------- future Swiss pairing: by points, random within points, avoid rematches ---------- */
function pairRound(s, activeList, sc, m = activeList.length, noBye = -1) {
  const maxPts = 3 * s.maxR;
  const order = sc.pairOrder, tmp = sc.pairTmp, bucket = sc.bucket, used = sc.used;
  // shuffle, then counting-sort by points (highest first) — O(n)
  for (let i = 0; i < m; i++) tmp[i] = activeList[i];
  for (let i = m - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const x = tmp[i]; tmp[i] = tmp[j]; tmp[j] = x; }
  bucket.fill(0);
  for (let i = 0; i < m; i++) bucket[maxPts - s.pts[tmp[i]] + 1]++;
  for (let k = 1; k < bucket.length; k++) bucket[k] += bucket[k - 1];
  for (let i = 0; i < m; i++) { const x = tmp[i]; order[bucket[maxPts - s.pts[x]]++] = x; }

  used.fill(0, 0, m);
  let bye = -1;
  if (m % 2) {
    let k = m - 1;
    while (k > 0 && (s.byes[order[k]] || order[k] === noBye)) k--;
    if (order[k] === noBye) k = order[m - 1] === noBye ? m - 2 : m - 1; // (the followed player's results are fixed)
    bye = order[k]; used[k] = 1;
  }
  const pairs = sc.pairs; let p = 0;
  let first = 0;
  for (let k = 0; k < m; k++) {
    if (used[k]) continue;
    used[k] = 1;
    const a = order[k];
    while (first < m && used[first]) first++;
    if (first >= m) break;
    // look a little way down for someone they haven't played; otherwise take the next one
    let pick = -1;
    for (let j = first, looked = 0; j < m && looked < 40; j++) {
      if (used[j]) continue;
      looked++;
      if (!hasPlayed(s, a, order[j])) { pick = j; break; }
    }
    if (pick < 0) pick = first;
    used[pick] = 1;
    pairs[p++] = a; pairs[p++] = order[pick];
  }
  return { count: p / 2, bye };
}

/* ---------- jobs, tallies, and running them ---------- */

/** Everything a worker needs, as plain data. */
// track: { i, left } — "What you need" run: every way player i's next `left` matches can go
// gets the same share of simulations; only player i's results are tallied.
export function prepareJob(state, { K, drawRate, track = null }) {
  const activeList = [];
  for (let i = 0; i < state.n; i++) if (state.active[i]) activeList.push(i);
  const exact = !track && state.futureRounds === 0 && !state.day2Rounds && state.pending.length <= EXACT_LIMIT;
  let tr = null;
  if (track) {
    const combos = [];
    for (let w = track.left; w >= 0; w--) for (let l = track.left - w; l >= 0; l--) combos.push([w, l, track.left - w - l]);
    tr = { i: track.i, left: track.left, combos };
  }
  // Finishing places: events up to 128 players track every place; bigger ones track tiers that
  // double from the cut (top 8, 16, 32, 64, …). rankEdges = each bucket's last place (inclusive).
  const m = state.eligibleCount, Kc = Math.max(1, Math.min(K, m));
  const edges = [];
  if (m <= RANK_EXACT_MAX) for (let r = 1; r <= m; r++) edges.push(r);
  else { for (let t = Kc; t < m; t *= 2) edges.push(t); edges.push(m); }
  const rankBucket = new Int32Array(m + 1);
  for (let b = 0, r = 1; r <= m; r++) { while (edges[b] < r) b++; rankBucket[r] = b; }
  return {
    rankEdges: Int32Array.from(edges), rankBucket, rankExact: m <= RANK_EXACT_MAX,
    day2Rounds: state.day2Rounds || 0, day2T: state.day2T, track: tr,
    n: state.n, K: Math.min(K, state.eligibleCount), d: Math.min(0.9, Math.max(0, drawRate)),
    eligible: state.eligible, eligibleCount: state.eligibleCount,
    base: state.base, pending: state.pending.map((m) => [m.a, m.b]),
    futureRounds: state.futureRounds, activeList,
    mode: tr ? "track" : exact ? "exact" : "simulation",
    combos: exact ? 3 ** state.pending.length : null,
  };
}

/** Running totals. cond[(i*3 + res)*2] = weight, [+1] = weight that made the cut. */
// d2[i] = weight where player i made Day 2. tk[(combo*3)] = runs, [+1] = top-cut weight, [+2] = made Day 2.
// hist[i*B + b] = weight where player i finished in place bucket b (see rankEdges in prepareJob).
export function newAcc(n, combos = 0, buckets = 0) {
  return { total: 0, top: new Float64Array(n), rankSum: new Float64Array(n), cond: new Float64Array(n * 6),
    d2: new Float64Array(n), tk: new Float64Array(combos * 3), hist: new Float64Array(n * buckets) };
}
export const accCombos = (job) => (job.track ? job.track.combos.length : 0);
export const accBuckets = (job) => (job.track || job.mode === "draw" || !job.rankEdges ? 0 : job.rankEdges.length);
export function mergeAcc(into, from) {
  into.total += from.total;
  if (into.hist.length && into.hist.length === from.hist?.length) for (let i = 0; i < into.hist.length; i++) into.hist[i] += from.hist[i];
  for (let i = 0; i < into.d2.length; i++) into.d2[i] += from.d2[i];
  for (let i = 0; i < into.tk.length; i++) into.tk[i] += from.tk[i];
  for (let i = 0; i < into.top.length; i++) { into.top[i] += from.top[i]; into.rankSum[i] += from.rankSum[i]; }
  for (let i = 0; i < into.cond.length; i++) into.cond[i] += from.cond[i];
  return into;
}

function makeScratch(job) {
  const n = job.n, m = job.activeList.length;
  return {
    s: cloneStats(job.base), keys: new Float64Array(n), order: new Array(n), eorder: new Int32Array(n),
    nextRes: new Int8Array(n), inD2: new Uint8Array(n), d2list: new Int32Array(m), seq: new Int8Array(64), trackN: 0,
    pairOrder: new Int32Array(m), pairTmp: new Int32Array(m), used: new Uint8Array(m),
    bucket: new Int32Array(3 * job.base.maxR + 2), pairs: new Int32Array(m + 1),
    gb: new Int32Array(job.rankEdges ? job.rankEdges.length : 0), gw: new Float64Array(job.rankEdges ? job.rankEdges.length : 0),
    // "If draw" pass: runs left for each unit, and where the round-robin is up to
    dq: job.drawQuota ? Int32Array.from(job.drawQuota) : null, du: 0,
  };
}

// only: [a, b] — "If draw" pass: record just these players' draw odds (b may be -1).
function tally(job, sc, acc, weight, combo = -1, only = null) {
  const { order: all, same } = rankGroups(sc.s, sc);
  // rank only eligible players (everyone, unless this is e.g. a Day 2 view).
  // With a Day 2, the players who made it rank first and only they can make the cut.
  const order = sc.eorder, day2 = job.day2Rounds > 0;
  let n = 0;
  if (day2) {
    for (let k = 0; k < all.length; k++) if (job.eligible[all[k]] && sc.inD2[all[k]]) order[n++] = all[k];
  }
  const inCutPool = day2 ? n : -1;
  for (let k = 0; k < all.length; k++) if (job.eligible[all[k]] && !(day2 && sc.inD2[all[k]])) order[n++] = all[k];
  const poolEnd = inCutPool < 0 ? n : inCutPool;
  const K = job.K;
  const tr = job.track;
  const B = accBuckets(job), hist = !only && !tr && B && acc.hist.length ? acc.hist : null;
  let start = 0;
  while (start < n) {
    let end = start + 1;
    // groups never straddle the Day 2 line
    while (end < n && same(order[end], order[start]) && (end < poolEnd) === (start < poolEnd)) end++;
    const share = start >= poolEnd ? 0 : Math.max(0, Math.min(K, end) - start) / (end - start);
    const avgRank = (start + end + 1) / 2;
    // places start+1 … end are shared equally by the group: which place buckets, and how much of each
    let nb = 0;
    if (hist) {
      for (let r = start + 1; r <= end;) {
        const b = job.rankBucket[r], hi = Math.min(end, job.rankEdges[b]);
        sc.gb[nb] = b; sc.gw[nb++] = (hi - r + 1) / (end - start);
        r = hi + 1;
      }
    }
    for (let k = start; k < end; k++) {
      const i = order[k];
      if (only) {
        if (i === only[0] || i === only[1]) { const c = (i * 3 + RES.D) * 2; acc.cond[c] += weight; acc.cond[c + 1] += share * weight; }
        continue;
      }
      if (tr) {
        if (i === tr.i) { const c = combo * 3; acc.tk[c] += weight; acc.tk[c + 1] += share * weight; if (day2 && sc.inD2[i]) acc.tk[c + 2] += weight; }
        continue;
      }
      acc.top[i] += share * weight;
      acc.rankSum[i] += avgRank * weight;
      for (let q = 0; q < nb; q++) hist[i * B + sc.gb[q]] += sc.gw[q] * weight;
      if (day2 && sc.inD2[i]) acc.d2[i] += weight;
      const r = sc.nextRes[i];
      if (r >= 0) { const c = (i * 3 + r) * 2; acc.cond[c] += weight; acc.cond[c + 1] += share * weight; }
    }
    start = end;
  }
  acc.total += weight;
}

/** Only this round's unfinished matches are left: try every combination (weighted). */
export function exactAll(job) {
  const acc = newAcc(job.n, 0, accBuckets(job)), sc = makeScratch(job);
  const d = job.d, pW = (1 - d) / 2;
  for (let c = 0; c < job.combos; c++) {
    copyInto(sc.s, job.base);
    sc.nextRes.fill(-1);
    let x = c, weight = 1;
    for (const [a, b] of job.pending) {
      const res = x % 3; x = (x - res) / 3;
      weight *= res === RES.D ? d : pW;
      if (weight === 0) break;
      // every combination is weighted, so a win counts as its expected score: 2-0 or 2-1 about equally often
      if (res === RES.D) applyDraw(sc.s, a, b, 1, 1);
      else if (res === RES.W) applyWin(sc.s, a, b, 2, 0.5, 0);
      else applyWin(sc.s, b, a, 2, 0.5, 0);
      sc.nextRes[a] = res; sc.nextRes[b] = flip(res);
    }
    if (weight > 0) tally(job, sc, acc, weight);
  }
  return acc;
}

/** Play the rest of the event `count` times, adding into acc. Reuses scratch between calls. */
export function simulateBatch(job, count, acc, sc = makeScratch(job)) {
  const d = job.d, tr = job.track, T = job.day2T;
  let seq = null, step = 0, combo = -1;
  // "If draw" pass: this run's target player (fA) has their next match set to a draw;
  // fB is their opponent when that match is already paired (then it's their draw too).
  const du = job.drawUnits;
  let fA = -1, fB = -1;
  // One match between a and b; the followed player's results come from `seq` in a "What you need" run.
  // Returns the result from a's point of view.
  const play = (s, a, b) => {
    if (tr && (a === tr.i || b === tr.i) && step < tr.left) {
      const res = seq[step++]; // from the followed player's view
      const games = res === RES.D ? 2 : Math.random() < 0.5 ? 2 : 3;
      if (a === tr.i) { applyResult(s, a, b, res, games); return res; }
      applyResult(s, b, a, res, games); return flip(res);
    }
    if (fA >= 0 && (a === fA || b === fA) && sc.nextRes[fA] < 0) { applyDraw(s, a, b, 1, 1); return RES.D; }
    return randomResult(s, a, b, d);
  };
  const playRound = (s, list, len) => {
    if (len < 2) return;
    const { count: pc, bye } = pairRound(s, list, sc, len, tr ? tr.i : -1);
    // A player's "next match" is their unfinished match this round, or else their first future one.
    if (bye >= 0) { applyBye(s, bye); if (sc.nextRes[bye] < 0) sc.nextRes[bye] = RES.W; }
    for (let k = 0; k < pc; k++) {
      const a = sc.pairs[2 * k], b = sc.pairs[2 * k + 1];
      const res = play(s, a, b);
      if (sc.nextRes[a] < 0) sc.nextRes[a] = res;
      if (sc.nextRes[b] < 0) sc.nextRes[b] = flip(res);
    }
  };
  for (let sim = 0; sim < count; sim++) {
    if (du) {
      // next unit (round-robin) that still has runs left
      const U = sc.dq.length;
      let k = sc.du % U, tries = 0;
      while (sc.dq[k] <= 0 && tries < U) { k = (k + 1) % U; tries++; }
      if (sc.dq[k] <= 0) break;
      sc.dq[k]--; sc.du = k + 1;
      fA = du[2 * k]; fB = du[2 * k + 1];
    }
    const s = sc.s;
    copyInto(s, job.base);
    sc.nextRes.fill(-1);
    if (tr) {
      // next combination in turn, played in a random order
      combo = sc.trackN++ % tr.combos.length;
      const [w, l, dd] = tr.combos[combo];
      let k = 0;
      for (let x = 0; x < w; x++) sc.seq[k++] = RES.W;
      for (let x = 0; x < l; x++) sc.seq[k++] = RES.L;
      for (let x = 0; x < dd; x++) sc.seq[k++] = RES.D;
      for (let x = k - 1; x > 0; x--) { const j = (Math.random() * (x + 1)) | 0; const t = sc.seq[x]; sc.seq[x] = sc.seq[j]; sc.seq[j] = t; }
      seq = sc.seq; step = 0;
    }
    for (const [a, b] of job.pending) {
      const res = play(s, a, b);
      sc.nextRes[a] = res; sc.nextRes[b] = flip(res);
    }
    for (let r = 0; r < job.futureRounds; r++) playRound(s, job.activeList, job.activeList.length);
    if (job.day2Rounds) {
      // Day 2 cut: only players on T+ points keep playing
      sc.inD2.fill(0);
      let m = 0;
      for (const x of job.activeList) if (s.pts[x] >= T) { sc.d2list[m++] = x; sc.inD2[x] = 1; }
      for (let r = 0; r < job.day2Rounds; r++) playRound(s, sc.d2list, m);
    }
    if (du) {
      // A bye in that round means there was no match to draw: nothing to record.
      if (sc.nextRes[fA] === RES.D) tally(job, sc, acc, 1, -1, [fA, fB]);
    } else tally(job, sc, acc, 1, combo);
  }
  return sc;
}

/* ---------- "If draw" pass ---------- */
// Draws are rare (about 3% of matches at big events), so the main runs give each player far
// fewer draw samples than win or loss samples, and the If draw column is noisier. This pass
// replays the event with one player's next match set to a draw and everything else random as
// usual — exactly "the event, given that match is drawn" — and those samples are added to the
// main runs' draw samples. Players a draw can't affect (in or out whatever happens) are skipped.
// Returns units ([a, b] pairs: b = -1 when the match isn't paired yet) with runs wanted for each.
export function planDrawPass(state, job, acc, { maxRuns = 400000 } = {}) {
  if (job.mode !== "simulation" || job.track || !(job.d > 0) || state.freshStart) return null;
  const need = (i) => {
    if (!job.eligible[i]) return 0;
    const n = (r) => acc.cond[(i * 3 + r) * 2], t = (r) => acc.cond[(i * 3 + r) * 2 + 1];
    const nW = n(RES.W), nD = n(RES.D), nL = n(RES.L);
    if (nW <= 0 || nL <= 0) return 0; // no real match ahead (or only ever a bye)
    const pW = t(RES.W) / nW, pL = t(RES.L) / nL;
    if (Math.min(pW, pL) >= 0.995 || Math.max(pW, pL) <= 0.005) return 0;
    if (nD > 0) {
      // the draw samples already pin it near 0% or 100% (95% bound, at least 3/n for a clean 0 or 100)
      const pD = t(RES.D) / nD, sd = 2 * Math.sqrt((pD * (1 - pD)) / nD);
      if (Math.max(pD + sd, 3 / nD) <= 0.01 || Math.min(pD - sd, 1 - 3 / nD) >= 0.99) return 0;
    }
    return Math.max(0, Math.round((nW + nL) / 2 - nD)); // as many draw samples as win/lose ones
  };
  const units = [], quota = [];
  const paired = new Uint8Array(state.n);
  for (const [a, b] of job.pending) {
    paired[a] = paired[b] = 1;
    const q = Math.max(need(a), need(b));
    if (q > 0) { units.push(a, b); quota.push(q); }
  }
  if (state.futureRounds > 0) {
    for (let i = 0; i < state.n; i++) {
      if (paired[i] || !state.active[i]) continue;
      const q = need(i);
      if (q > 0) { units.push(i, -1); quota.push(q); }
    }
  }
  if (!quota.length) return null;
  let total = quota.reduce((x, y) => x + y, 0);
  if (total > maxRuns) {
    const f = maxRuns / total;
    for (let k = 0; k < quota.length; k++) quota[k] = Math.max(1, Math.round(quota[k] * f));
    total = quota.reduce((x, y) => x + y, 0);
  }
  return { units: Int32Array.from(units), quota: Int32Array.from(quota), total };
}

/** "What you need" tallies → one row per way the followed player's next matches can go. */
export function finalizeTrack(job, acc) {
  const rows = job.track.combos.map(([w, l, d], c) => {
    const n = acc.tk[c * 3];
    return { w, l, d, runs: n, top: n ? acc.tk[c * 3 + 1] / n : null, d2: n && job.day2Rounds ? acc.tk[c * 3 + 2] / n : null };
  });
  return { rows, runs: acc.total, left: job.track.left };
}

/** Tallies → percentages. dacc: the "If draw" pass, pooled into the draw odds. */
export function finalize(state, job, acc, dacc = null) {
  const n = job.n, total = acc.total || 1;
  const results = [];
  if (state.freshStart) {
    // Start of round 1: everyone is equal, so each player's chance is exactly K / players.
    // Win/draw/lose odds are pooled across all players so they come out identical too.
    const m = job.eligibleCount;
    const pooled = [0, 1, 2].map((r) => {
      let wt = 0, tp = 0;
      for (let i = 0; i < n; i++) if (job.eligible[i]) { wt += acc.cond[(i * 3 + r) * 2]; tp += acc.cond[(i * 3 + r) * 2 + 1]; }
      return wt > 0 ? { p: wt / (total * m), top: tp / wt } : null;
    });
    let d2 = 0;
    for (let i = 0; i < n; i++) if (job.eligible[i]) d2 += acc.d2[i];
    const pDay2 = job.day2Rounds ? d2 / (total * m) : null;
    const finish = Array.from(job.rankEdges || [], (t) => Math.min(1, t / m));
    for (let i = 0; i < n; i++) results.push({ pTop: Math.min(1, job.K / m), expRank: (m + 1) / 2, cond: pooled, pDay2, finish: job.eligible[i] ? finish : null });
  } else {
    for (let i = 0; i < n; i++) {
      const cond = [0, 1, 2].map((r) => {
        const c = (i * 3 + r) * 2;
        const wt = acc.cond[c];
        let nS = wt, tp = acc.cond[c + 1];
        if (dacc && r === RES.D) { nS += dacc.cond[c]; tp += dacc.cond[c + 1]; }
        return nS > 0 ? { p: wt / total, top: tp / nS, n: nS } : null;
      });
      // finish[b] = chance of finishing in place rankEdges[b] or better
      let finish = null;
      const B = acc.hist.length / n;
      if (B && job.eligible[i] && acc.total > 0) {
        finish = new Array(B);
        for (let b = 0, c = 0; b < B; b++) { c += acc.hist[i * B + b]; finish[b] = Math.min(1, c / total); }
      }
      results.push({ pTop: acc.top[i] / total, expRank: acc.rankSum[i] / total, cond, pDay2: job.day2Rounds ? acc.d2[i] / total : null, finish });
    }
  }
  return { results, method: state.freshStart ? "equal-start" : job.mode, runs: acc.total, combos: job.combos,
    rankEdges: job.rankEdges ? Array.from(job.rankEdges) : null, rankExact: !!job.rankExact };
}

/* ---------- how many runs to aim for ---------- */
// Worst-case margin (a player sitting near 50%) for a number of runs: ±2·√(0.25 / runs).
export const marginFor = (runs) => 2 * Math.sqrt(0.25 / Math.max(1, runs));
export const runsFor = (margin) => Math.ceil(1 / (margin * margin));

/**
 * Early in the event (more than half the Swiss rounds still to play) aim for ±3%;
 * later, ±1%. Small events are cheap, so they always get 40,000 runs.
 */
export function planRuns(state) {
  const late = state.roundsLeft <= state.roundsTotal / 2;
  const targetMargin = late ? 0.01 : 0.03;
  const runs = state.n <= 128 ? 40000 : runsFor(targetMargin);
  return { runs, targetMargin, stage: late ? "late" : "early", timeLimitMs: 30000 };
}
