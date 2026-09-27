import { useEffect, useMemo, useRef, useState } from "react";
import { buildState, currentStandings, planRuns } from "./lib/live.js";
import { runOddsLive } from "./lib/runner.js";
import { fetchEvent } from "./lib/fetchEvent.js";
import demoData from "./demo.json";

const PREVIEW = import.meta.env.VITE_PREVIEW === "1"; // static preview build: demo only
// Donation page (e.g. "https://ko-fi.com/yourname"). Empty = no donation link anywhere on the site.
const DONATE_URL = "https://ko-fi.com/riftboundodds";

function parseEventId(input) {
  const s = String(input || "").trim();
  if (s.toLowerCase() === "demo") return "demo";
  const m = s.match(/events\/(\d+)/) || s.match(/^(\d+)$/);
  return m ? m[1] : null;
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

const pct = (x) => (x == null ? "—" : x >= 0.995 ? ">99%" : x > 0 && x < 0.005 ? "<1%" : `${Math.round(x * 100)}%`);
const pillClass = (x) =>
  x == null ? "pill p-none" : x >= 0.99 ? "pill p-lock" : x >= 0.6 ? "pill p-likely" : x >= 0.02 ? "pill p-bubble" : x > 0 ? "pill p-out" : "pill p-none";
const rec = (w, l, d) => `${w}-${l}-${d}`;
const fmtMargin = (m) => `±${(m * 100).toFixed(m < 0.1 ? 1 : 0)}%`;
const BIG_EVENT = 512; // above this many players, pick a player by searching instead of a dropdown
const PAGE = 100; // standings rows per page (desktop table)
// Share of matches that end in a draw, measured over 16,500 played Swiss matches at three
// 1,800+ player Regional Qualifiers (Atlanta 2.3%, Vancouver 2.8%, Hartford 3.3%).
const DRAW_DEFAULT = 3;
const PAGE_NARROW = 24; // standings cards per page on phones and tablets (fills 1 or 2 columns evenly)

// Phones, tablets and narrow windows get cards instead of wide tables. Keep in sync with the
// @media (max-width:899px) block at the end of styles.css.
const NARROW_Q = "(max-width: 899px)";
function useNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(NARROW_Q).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(NARROW_Q);
    if (!mq) return;
    const f = () => setNarrow(mq.matches);
    f();
    if (mq.addEventListener) { mq.addEventListener("change", f); return () => mq.removeEventListener("change", f); }
    mq.addListener(f); return () => mq.removeListener(f); // older Safari
  }, []);
  return narrow;
}
const smooth = () => (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

// Events with more than one Swiss phase (Day 1 / Day 2). Returns the data for one phase:
// Day 1 = its own rounds; Day 2 = all rounds so far (records carry over), but only the
// players who made Day 2 are ranked.
function swissPhases(data) {
  return data?.swiss?.phases?.length > 1 ? data.swiss.phases : [];
}
// Number of Swiss stages (1 for a plain Swiss event). The top cut, if any, comes after them.
const swissCount = (data) => (data?.swiss?.phases?.length > 1 ? data.swiss.phases.length : 1);
const cutStarted = (data) => !!data?.cut?.rounds?.some((r) => r.hasPairings && r.matches.length);
function latestPhase(data) {
  if (cutStarted(data)) return swissCount(data);
  let idx = 0;
  for (const r of data?.rounds || []) if (r.hasPairings && r.matches.length && (r.phase ?? 0) > idx) idx = r.phase;
  return idx;
}
// Everything the "Phase" dropdown offers: each Swiss day, then the top cut.
function stageOptions(data) {
  if (!data) return [];
  const multi = swissPhases(data);
  const opts = multi.length
    ? multi.map((p, i) => ({
        label: phaseLabel(multi, i),
        started: (data.rounds || []).some((r) => (r.phase ?? 0) === i && r.hasPairings && r.matches.length),
      }))
    : [{ label: `Swiss (R1–${data.swiss?.plannedRounds || (data.rounds || []).length || "?"})`, started: true }];
  if (data.cut) {
    const nums = data.cut.rounds.map((r) => r.number);
    const first = nums.length ? Math.min(...nums) : null;
    const range = first ? ` (R${first}–${first + (data.cut.plannedRounds || nums.length) - 1})` : "";
    opts.push({ label: `Top ${data.cut.size || "cut"}${range}`, started: cutStarted(data), cut: true });
  }
  return opts;
}
function phaseView(data, idx) {
  const phases = swissPhases(data);
  if (!phases.length) return { data, eligibleIds: null, planned: data.swiss?.plannedRounds || null, firstRound: 1 };
  const rounds = (data.rounds || []).filter((r) => (r.phase ?? 0) <= idx);
  let eligibleIds = null;
  if (idx > 0) {
    eligibleIds = new Set();
    for (const r of rounds) if ((r.phase ?? 0) === idx) for (const m of r.matches) for (const p of m.players) eligibleIds.add(p.id);
  }
  const planned = phases.slice(0, idx + 1).reduce((n, p) => n + (p.rounds || 0), 0);
  const phaseDone = phases[idx].status === "COMPLETE";
  const played = rounds.filter((r) => r.hasPairings && r.matches.length).length;
  return {
    data: { ...data, rounds, swiss: { ...data.swiss, plannedRounds: planned, status: phaseDone ? "COMPLETE" : "IN_PROGRESS" } },
    eligibleIds, planned: phaseDone && played ? played : planned,
    firstRound: phases[idx].first ?? 1,
  };
}
// Day 2 cut for a Day 1 view: the next Swiss phase's round count, and the points needed.
// Official rule: a points threshold — 18+ after 8 rounds at RQs, 12+ after 6 at Regional
// Championships, i.e. two losses or better. If Day 2 has already started, use the real cutoff:
// the lowest Day 1 points among players who played Day 2.
function day2Info(data) {
  const phases = swissPhases(data);
  if (phases.length < 2) return null;
  const day1Rounds = phases[0].rounds || 0;
  const rule = Math.max(3, 3 * (day1Rounds - 2));
  const d2ids = new Set();
  for (const r of data.rounds || []) if ((r.phase ?? 0) === 1) for (const m of r.matches) for (const p of m.players) d2ids.add(p.id);
  let used = null;
  if (d2ids.size) {
    const d1 = buildState(phaseView(data, 0).data, {});
    for (const row of currentStandings(d1)) if (d2ids.has(row.id) && (used === null || row.pts < used)) used = row.pts;
  }
  return { rounds: phases[1].rounds || 0, rule, used, def: used ?? rule, day1Rounds };
}
const phaseLabel = (phases, i) => {
  const p = phases[i];
  const last = (p.first ?? 1) + (p.rounds || 1) - 1;
  return `Day ${i + 1} (R${p.first ?? "?"}–${last})`;
};

// "Master Yi, Wuju Bladesman" → "Master Yi"
const legendShort = (l) => (l ? l.split(",")[0].trim() : null);
// The locator's registration status → what we show
function statusOf(p) {
  const s = (p.status || "").toUpperCase();
  if (!s) return null;
  if (s.includes("DROP")) return { label: "Dropped", cls: "st-drop" };
  if (s.includes("ELIM")) return { label: "Eliminated", cls: "st-out" };
  if (s === "COMPLETE" || s.includes("ACTIVE") || s.includes("REGISTER")) return { label: "Active", cls: "st-in" };
  return { label: s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " "), cls: "st-other" };
}

/* ----- the last event opened on this device -----
   Opened again straight away only while it's still going (and started in the last 3 days);
   otherwise the start page offers it as a button, so an old 2,000-player event isn't downloaded
   again on every visit. */
const LAST_KEY = "rb-last-event", LAST_INFO_KEY = "rb-last-event-info";
const DAY_MS = 86400000;
function eventFinished(d) {
  if (d.isDemo || d.lifecycle === "EVENT_FINISHED") return true;
  return d.cut ? d.cut.status === "COMPLETE" : d.swiss?.status === "COMPLETE";
}
function rememberEvent(id, d) {
  store.set(LAST_KEY, id);
  store.set(LAST_INFO_KEY, JSON.stringify({ id, name: d.name || null, start: d.start || null, finished: eventFinished(d), at: Date.now() }));
}
function readLastEvent(now = Date.now()) {
  const raw = store.get(LAST_KEY);
  const id = raw === "demo" ? "demo" : parseEventId(raw);
  if (!id) return null;
  let info = null;
  try { info = JSON.parse(store.get(LAST_INFO_KEY) || "null"); } catch { /* unreadable: treat as unknown */ }
  if (!info || String(info.id) !== id) return { id, name: null, auto: false };
  const start = Date.parse(info.start);
  const recent = Number.isFinite(start) ? now - start < 3 * DAY_MS : now - (Number(info.at) || 0) < DAY_MS;
  return { id, name: typeof info.name === "string" ? info.name : null, auto: !info.finished && recent };
}

/* ----- following a group of players -----
   A group is a list of player ids (in the order they were added) plus an optional name,
   saved per event on this device. A shared link carries it as ?follow=id1,id2&name=… */
const MAX_GROUP = 20;
const MAX_NAME = 30;
const validId = (s) => /^[A-Za-z0-9_-]{1,40}$/.test(s);
const cleanIds = (list) => [...new Set(list.map((x) => String(x).trim()).filter(validId))].slice(0, MAX_GROUP);
const cleanName = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
function groupFromUrl() {
  const q = new URLSearchParams(location.search);
  const ids = cleanIds((q.get("follow") || "").split(","));
  return ids.length ? { ids, name: cleanName(q.get("name")) } : null;
}
function readGroup(key) {
  try {
    const g = JSON.parse(store.get(key) || "null");
    return g && Array.isArray(g.ids) ? { ids: cleanIds(g.ids), name: cleanName(g.name) } : null;
  } catch { return null; }
}
const groupKey = (ev) => `rb-group:${ev}`;
const sameIds = (a, b) => a.length === b.length && a.every((x, k) => x === b[k]);
const shareUrl = (eventId, ids = [], name = "") => {
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set("event", eventId);
  if (ids.length) u.searchParams.set("follow", ids.join(","));
  if (ids.length > 1 && name) u.searchParams.set("name", name);
  return prettyUrl(u);
};
// Commas are fine in links; keeping them readable makes shared links look less like gibberish.
const prettyUrl = (u) => u.toString().replace(/%2C/gi, ",");
// Phones: the system share sheet. Otherwise (or if that fails): copy to the clipboard.
async function shareLink(url, title) {
  const touch = window.matchMedia?.("(pointer: coarse)").matches;
  if (touch && navigator.share) {
    try { await navigator.share({ title, url }); return "shared"; }
    catch (e) { if (e?.name === "AbortError") return "cancelled"; }
  }
  try { await navigator.clipboard.writeText(url); return "copied"; } catch { return "manual"; }
}

function timeAgo(iso, now) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function App() {
  const [lastEvent] = useState(() => (PREVIEW ? null : readLastEvent()));
  // A link with ?event= opens that event; otherwise the last event, if it's still going.
  const urlEvent = new URLSearchParams(location.search).get("event");
  const initial = urlEvent || (PREVIEW ? "demo" : lastEvent?.auto ? lastEvent.id : "");
  const [input, setInput] = useState(initial);
  const [eventId, setEventId] = useState(null); // the event on screen (set once it has loaded)
  const [data, setData] = useState(null);
  const [error, setError] = useState(""); // couldn't load an event
  const [staleError, setStaleError] = useState(""); // couldn't refresh the event on screen (old results stay)
  const dataRef = useRef(null); // latest data, for load() called from the auto-refresh timer
  const loadSeq = useRef(0); // only the newest request may update the page (an older, slower one is ignored)
  const busy = useRef(false); // a load is in flight (auto-refresh waits its turn instead of cutting in)
  const loadAbort = useRef(null); // stops the previous load's downloads when a new load starts
  const lastTry = useRef(0); // when the last load started; auto-refresh counts from here
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total } rounds downloaded during a load
  const [K, setK] = useState(null);
  const [roundsTotal, setRoundsTotal] = useState(null);
  const [phaseIdx, setPhaseIdx] = useState(0); // which Swiss phase (Day 1 / Day 2) is shown
  const [view, setView] = useState(() => store.get("rb-view") || "compact"); // table: compact or full
  const [drawPct, setDrawPct] = useState(DRAW_DEFAULT);
  // Who's followed in this event (see "following a group" above). ev = the event it belongs to.
  const [group, setGroup] = useState({ ev: null, ids: [], name: "" });
  const [focusId, setFocusId] = useState(null); // the one member whose full card is shown
  const linkGroup = useRef(groupFromUrl()); // a shared link's group, applied once to the event in the link
  const linkEvent = useRef(parseEventId(new URLSearchParams(location.search).get("event")));
  const [linkNote, setLinkNote] = useState(null); // what happened when a shared group was opened
  const [toast, setToast] = useState(null); // { msg, undo? } short confirmation at the bottom
  const [odds, setOdds] = useState(null);
  const [autoMin, setAutoMin] = useState(0); // auto-refresh interval in minutes, 0 = off
  const [draft, setDraft] = useState(null); // settings being edited, applied with the Apply button
  const [tableQuery, setTableQuery] = useState("");
  const [page, setPage] = useState(1);
  const [legendFilter, setLegendFilter] = useState("");
  const [now, setNow] = useState(Date.now());
  const [rewindTo, setRewindTo] = useState(null); // null = latest data
  const [d2T, setD2T] = useState(null); // Day 2 points threshold; null = the event's default
  const [need, setNeed] = useState(null); // "What you need" results for the followed player
  const [tab, setTab] = useState(() => store.get("rb-tab") || "standings"); // standings or legends
  const pickTab = (t) => { setTab(t); store.set("rb-tab", t); };
  const narrow = useNarrow(); // phone layout: cards instead of tables, fewer rows per page
  const [moreOpen, setMoreOpen] = useState(false); // phone: the less-used settings are folded away
  const standingsRef = useRef(null);
  const [scrollMine, setScrollMine] = useState(false);
  const focusRef = useRef(null); // the follow card
  const zoneRef = useRef(null); // group card + follow card, so the phone bar knows when they're scrolled away
  const [focusAbove, setFocusAbove] = useState(false);

  /* ----- fetching ----- */
  // Loads an event. The same event as on screen = a refresh (settings kept); a different one
  // replaces it only once it has loaded, so a typo or a failed load leaves the current event as it was.
  async function load(id) {
    if (!id) return;
    const seq = ++loadSeq.current;
    loadAbort.current?.abort();
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    loadAbort.current = ctrl;
    busy.current = true;
    lastTry.current = Date.now();
    setLoading(true); setError(""); setProgress(null);
    const cur = dataRef.current;
    const refreshing = !!cur && String(cur.isDemo ? "demo" : cur.id) === String(id);
    try {
      const onProgress = (p) => { if (seq === loadSeq.current) setProgress(p); };
      const json = id === "demo" ? { ...demoData, fetchedAt: new Date().toISOString() } : await fetchEvent(id, { onProgress, signal: ctrl?.signal });
      if (seq !== loadSeq.current) return; // a newer load started meanwhile
      setData(json);
      setStaleError("");
      setEventId(String(id));
      if (!refreshing) {
        setOdds(null); // the old event's odds don't belong to these players
        const count = json.playerCount || 0;
        setK(json.topCut || (count && count <= 16 ? 4 : 8));
        const ph = latestPhase(json);
        setPhaseIdx(ph);
        if (swissPhases(json).length) setRoundsTotal(phaseView(json, Math.min(ph, swissCount(json) - 1)).planned);
        else {
          // A finished event may end before its planned round count (512931 listed 4, played 3).
          const played = (json.rounds || []).filter((r) => r.hasPairings && r.matches.length).length;
          const finished = json.swiss?.status === "COMPLETE" || json.lifecycle === "EVENT_FINISHED";
          setRoundsTotal(finished && played ? played : json.swiss?.plannedRounds || null);
        }
        setRewindTo(null);
        setD2T(null);
        setDraft(null);
        setTableQuery("");
        setLegendFilter("");
        setPage(1);
      }
      rememberEvent(String(id), json);
      const url = new URL(location.href);
      url.searchParams.set("event", id);
      history.replaceState(null, "", url);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      const msg = e?.message || "Couldn't load that event.";
      // A failed refresh keeps the last good results on screen, with a note saying how old they are.
      if (refreshing) setStaleError(msg); else setError(msg);
    } finally {
      if (seq === loadSeq.current) { busy.current = false; setLoading(false); setProgress(null); }
    }
  }

  useEffect(() => { load(parseEventId(initial)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh: once the data is older than the chosen interval. Not while the page is hidden
  // (another tab, phone locked): then it refreshes as soon as the page is shown again.
  useEffect(() => {
    if (!autoMin || !eventId || eventId === "demo") return;
    const tick = () => {
      if (document.hidden || busy.current || Date.now() - lastTry.current < autoMin * 60000) return;
      load(eventId);
    };
    const t = setInterval(tick, 15000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", tick); };
  }, [autoMin, eventId]);

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(t); }, []);

  dataRef.current = data;

  /* ----- state + odds ----- */
  const phases = swissPhases(data);
  // Final Swiss standings, used to seed the top cut
  const seeds = useMemo(() => {
    if (!data?.cut) return null;
    const v = phaseView(data, swissCount(data) - 1);
    const m = new Map();
    currentStandings(buildState(v.data, { eligibleIds: v.eligibleIds })).forEach((r) => m.set(r.id, r));
    return m;
  }, [data]);
  const stages = useMemo(() => stageOptions(data), [data]);
  const isCut = !!data?.cut && phaseIdx >= swissCount(data);
  const swissIdx = data ? Math.min(phaseIdx, swissCount(data) - 1) : 0;
  const pv = useMemo(() => (data ? phaseView(data, swissIdx) : null), [data, swissIdx]);
  const d2info = useMemo(() => (data ? day2Info(data) : null), [data]);
  // In a Day 1 view of a two-day event, the odds play Day 2 as well
  const day2 = !isCut && swissIdx === 0 && d2info?.rounds ? { threshold: d2T ?? d2info.def, rounds: d2info.rounds } : null;
  const day2Key = day2 ? `${day2.threshold}/${day2.rounds}` : "";
  const state = useMemo(
    () => (pv ? buildState(pv.data, { roundsTotal, rewindTo, eligibleIds: pv.eligibleIds, day2 }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pv, roundsTotal, rewindTo, day2Key]
  );
  const standings = useMemo(() => (state ? currentStandings(state) : []), [state]);
  // When rewound, compare against what really happened (latest data for this phase).
  // With Day 2 in play, compare against the final Swiss standings (Day 2 players only).
  const actual = useMemo(() => {
    if (!pv || !rewindTo) return null;
    // Compare against the final Swiss day only once it has started; before that, against Day 1 as it stands
    // (otherwise everyone would show as "Out after Day 1").
    const last = day2 ? phaseView(data, swissCount(data) - 1) : null;
    const useLast = !!last?.eligibleIds?.size;
    const v = useLast ? last : pv;
    const latest = buildState(v.data, { roundsTotal: useLast ? v.planned : roundsTotal, eligibleIds: v.eligibleIds });
    const m = new Map();
    currentStandings(latest).forEach((r) => m.set(r.id, r));
    const outIds = useLast ? new Set(pv.data.rounds.flatMap((r) => r.matches.flatMap((x) => x.players.map((p) => p.id))).filter((id) => !v.eligibleIds.has(id))) : null;
    return { byId: m, outIds, complete: !latest.roundInProgress && latest.futureRounds === 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pv, roundsTotal, rewindTo, day2Key]);

  // Runs in background workers; results stream in and sharpen until the run target
  // (early rounds ±3%, later rounds ±1%, 40,000 runs for small events) or 30 seconds.
  useEffect(() => {
    if (!state || !state.n || !K || isCut) return;
    setOdds((prev) => (prev ? { ...prev, stale: true } : prev));
    const cancel = runOddsLive(state, {
      K: Math.min(K, state.eligibleCount),
      drawRate: drawPct / 100,
      plan: planRuns(state),
      onUpdate: setOdds,
    });
    return cancel;
  }, [state, K, drawPct, isCut]);

  /* ----- following a group ----- */
  const evKey = data ? String(data.isDemo ? "demo" : data.id ?? eventId) : null;
  // Every player id anywhere in this event (Swiss and top cut), to drop ids that don't belong.
  const eventIds = useMemo(() => {
    const ids = new Set();
    for (const r of [...(data?.rounds || []), ...(data?.cut?.rounds || [])]) for (const m of r.matches) for (const p of m.players) ids.add(String(p.id));
    return ids;
  }, [data]);
  // Opening an event: its saved group; else whoever from the last group is playing here
  // (friends tend to go to the same events); else the single player followed before groups existed.
  // A shared link's group is applied once, to the event in the link.
  useEffect(() => {
    if (!evKey || group.ev === evKey) return;
    const inEvent = (g) => (g ? { ids: g.ids.filter((id) => eventIds.has(id)), name: g.name } : null);
    const saved = readGroup(groupKey(evKey));
    let mine = saved;
    if (!mine) {
      mine = inEvent(readGroup("rb-group-last"));
      if (!mine?.ids.length) { const old = store.get("rb-me"); mine = { ids: old && eventIds.has(old) ? [old] : [], name: "" }; }
      if (!mine.ids.length) mine.name = "";
    }
    let next = mine, note = null;
    const link = linkGroup.current;
    if (link && linkEvent.current === evKey) {
      linkGroup.current = null;
      const shared = inEvent(link);
      const missing = link.ids.length - shared.ids.length;
      if (!shared.ids.length) note = { kind: "none", count: link.ids.length };
      else {
        next = shared;
        if (mine.ids.length && !sameIds(mine.ids, shared.ids)) note = { kind: "replaced", prev: mine, shared, missing };
        else if (missing) note = { kind: "partial", missing };
      }
    }
    setGroup({ ev: evKey, ids: next.ids, name: next.name || "" });
    setFocusId(next.ids[0] ?? null);
    setLinkNote(note);
  }, [evKey, eventIds, group.ev]);
  // Saved per event on this device (the last edited group also seeds the next event).
  useEffect(() => {
    if (group.ev) store.set(groupKey(group.ev), JSON.stringify({ ids: group.ids, name: group.name }));
  }, [group]);
  const commitGroup = (ids, name = group.name, focus) => {
    setGroup({ ev: group.ev, ids, name: ids.length ? name : "" });
    store.set("rb-group-last", JSON.stringify({ ids, name: ids.length ? name : "" }));
    if (focus !== undefined) setFocusId(focus);
    else if (!ids.includes(focusId)) setFocusId(ids[0] ?? null);
  };
  const idxById = useMemo(() => {
    const m = new Map();
    state?.players.forEach((p, i) => m.set(String(p.id), i));
    return m;
  }, [state]);
  const handleOf = (id) => {
    const i = idxById.get(String(id));
    if (i != null) return state.players[i].handle;
    for (const r of [...(data?.cut?.rounds || []), ...(data?.rounds || [])]) for (const m of r.matches) for (const p of m.players) if (String(p.id) === String(id)) return p.handle;
    return "Player";
  };
  const undoTo = (g, focus) => () => { commitGroup(g.ids, g.name, focus); setToast(null); };
  // Tap a player: add them if needed and show their card.
  const focusPlayer = (rawId) => {
    const id = String(rawId);
    if (group.ids.includes(id)) { setFocusId(id); return; }
    if (group.ids.length >= MAX_GROUP) { setToast({ msg: `Groups hold up to ${MAX_GROUP} players. Remove someone first.` }); return; }
    const before = { ids: group.ids, name: group.name }, beforeFocus = focusId;
    commitGroup([...group.ids, id], group.name, id);
    if (group.ids.length) setToast({ msg: `Following ${handleOf(id)} · ${group.ids.length + 1} in your group`, undo: undoTo(before, beforeFocus) });
  };
  // ☆: add or remove without switching the card that's shown.
  const toggleMember = (rawId) => {
    const id = String(rawId);
    const before = { ids: group.ids, name: group.name }, beforeFocus = focusId;
    if (group.ids.includes(id)) {
      commitGroup(group.ids.filter((x) => x !== id));
      setToast({ msg: `Stopped following ${handleOf(id)}`, undo: undoTo(before, beforeFocus) });
    } else if (group.ids.length >= MAX_GROUP) {
      setToast({ msg: `Groups hold up to ${MAX_GROUP} players. Remove someone first.` });
    } else {
      commitGroup([...group.ids, id], group.name, focusId && group.ids.includes(focusId) ? focusId : id);
      setToast({ msg: `Following ${handleOf(id)}${group.ids.length ? ` · ${group.ids.length + 1} in your group` : ""}`, undo: undoTo(before, beforeFocus) });
    }
  };
  const removeMember = (id) => toggleMember(id);
  const clearGroup = () => {
    const before = { ids: group.ids, name: group.name }, beforeFocus = focusId;
    commitGroup([]);
    setToast({ msg: `Stopped following ${before.ids.length} player${before.ids.length === 1 ? "" : "s"}`, undo: undoTo(before, beforeFocus) });
  };
  const renameGroup = (name) => commitGroup(group.ids, cleanName(name), focusId);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.undo ? 6000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // Members in this view, and the one whose card is shown: the chosen one, or else the first
  // member who's ranked in this view (e.g. in the Day 2 view, the first who made Day 2).
  const members = group.ev === evKey ? group.ids.filter((id) => eventIds.has(id)) : [];
  const memberIdx = members.map((id) => idxById.get(id) ?? -1);
  const inGroup = useMemo(() => new Set(memberIdx.filter((i) => i >= 0)), [memberIdx.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const eligibleMember = (id) => { const i = idxById.get(id); return i != null && state?.eligible[i] ? i : -1; };
  const focusChoice = focusId && members.includes(focusId) && eligibleMember(focusId) >= 0 ? focusId : members.find((id) => eligibleMember(id) >= 0) ?? null;
  const meIdx = focusChoice ? eligibleMember(focusChoice) : -1;
  // The address bar always matches what's on screen, so copying it shares this view.
  useEffect(() => {
    if (!data || group.ev !== evKey) return;
    const url = new URL(location.href);
    if (members.length) url.searchParams.set("follow", members.join(",")); else url.searchParams.delete("follow");
    if (members.length > 1 && group.name) url.searchParams.set("name", group.name); else url.searchParams.delete("name");
    const next = prettyUrl(url);
    if (next !== location.href) history.replaceState(null, "", next);
  }, [data, evKey, group, members.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // "What you need": once the main odds are done, play out every way the followed player's
  // remaining matches (the rest of Day 1, when Day 2 is in play) can go.
  const mainDone = !!odds?.done && !odds.stale;
  const meLeft = state && meIdx >= 0 && state.eligible[meIdx]
    ? (state.pending.some((m) => m.a === meIdx || m.b === meIdx) ? 1 : 0) + (state.active[meIdx] ? state.futureRounds : 0)
    : 0;
  useEffect(() => {
    setNeed(null);
    if (!state || isCut || !K || meIdx < 0 || meLeft < 2 || !mainDone) return;
    const combos = ((meLeft + 1) * (meLeft + 2)) / 2;
    return runOddsLive(state, {
      K: Math.min(K, state.eligibleCount), drawRate: drawPct / 100,
      plan: { runs: Math.min(combos * 300, 30000), targetMargin: 0.03, stage: "track", timeLimitMs: 20000 },
      track: { i: meIdx, left: meLeft },
      onUpdate: setNeed,
    });
  }, [state, K, drawPct, isCut, meIdx, meLeft, mainDone]);

  /* ----- settings: edit freely, then Apply ----- */
  const current = state ? { phase: String(phaseIdx), asof: rewindTo ?? "", cut: String(K ?? ""), rounds: String(state.roundsTotal), draws: String(drawPct), d2t: String(day2?.threshold ?? d2info?.def ?? "") } : null;
  const form = draft ?? current;
  const dirty = !!(draft && current && Object.keys(current).some((k) => String(draft[k]) !== String(current[k])));
  const edit = (field) => (e) => {
    const next = { ...form, [field]: e.target.value };
    // switching Day 1 / Day 2 resets the round-related settings to that phase's defaults
    if (field === "phase" && data) {
      next.asof = "";
      next.rounds = String(phaseView(data, Math.min(Number(e.target.value), swissCount(data) - 1)).planned || "");
    }
    setDraft(next);
  };
  function applySettings(e) {
    e.preventDefault();
    if (!dirty) return;
    const newPhase = Number(form.phase);
    const phaseChanged = newPhase !== phaseIdx;
    const minRounds = phaseChanged ? 1 : state.roundsPaired;
    const toCut = !!data.cut && newPhase >= swissCount(data);
    setPhaseIdx(newPhase);
    setRewindTo(form.asof === "" ? null : Number(form.asof));
    setK(Math.max(1, Math.round(Number(form.cut)) || 1));
    if (!toCut) setRoundsTotal(Math.max(minRounds, Math.min(30, Math.round(Number(form.rounds)) || minRounds)));
    if (phaseChanged) setPage(1);
    setDrawPct(Math.min(60, Math.max(0, Number(form.draws) || 0)));
    if (d2info && form.d2t !== "" && Number(form.d2t) !== d2info.def) setD2T(Math.max(1, Math.round(Number(form.d2t)) || d2info.def));
    else if (d2info) setD2T(null);
    setDraft(null);
  }

  /* ----- standings table: search, legend filter, numbered pages ----- */
  const legends = useMemo(() => {
    if (!state) return [];
    const counts = new Map();
    for (const p of standings) if (p.legend) counts.set(p.legend, (counts.get(p.legend) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [state, standings]);
  const hasStatus = !!state?.players.some((p) => p.status);
  const showLegends = tab === "legends" && legends.length > 0;
  const filtered = useMemo(() => {
    const q = tableQuery.trim().toLowerCase();
    return standings.filter((r) =>
      (!legendFilter || r.legend === legendFilter) &&
      (!q || r.handle.toLowerCase().includes(q) || (r.name || "").toLowerCase().includes(q)));
  }, [standings, tableQuery, legendFilter]);
  const pageSize = narrow ? PAGE_NARROW : PAGE;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageNow = Math.min(page, pages);
  const shown = filtered.slice((pageNow - 1) * pageSize, pageNow * pageSize);
  const myPos = meIdx >= 0 ? filtered.findIndex((r) => r.i === meIdx) : -1;
  const full = view === "full";
  const cutN = state ? Math.min(K || 0, state.eligibleCount) : 0;
  // Rotating a phone (or resizing) changes the page size: stay on the page with the same first row.
  const lastSize = useRef(pageSize);
  useEffect(() => {
    const prev = lastSize.current;
    if (prev !== pageSize) setPage((p) => Math.floor(((p - 1) * prev) / pageSize) + 1);
    lastSize.current = pageSize;
  }, [pageSize]);
  // Phones: the pager sits under a long list, so a new page starts at the top of the standings.
  const goPage = (n) => {
    setPage(n);
    const el = standingsRef.current;
    if (narrow && el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ behavior: smooth(), block: "start" });
  };
  const goMine = () => { setPage(Math.floor(myPos / pageSize) + 1); if (narrow) setScrollMine(true); };
  useEffect(() => {
    if (!scrollMine) return;
    setScrollMine(false);
    document.querySelector(".card.mine")?.scrollIntoView({ behavior: smooth(), block: "center" });
  }, [scrollMine]);
  const pendingByPlayer = useMemo(() => {
    const m = new Map();
    state?.pending.forEach((p) => { m.set(p.a, p); m.set(p.b, p); });
    return m;
  }, [state]);

  function submit(e) {
    e.preventDefault();
    const id = parseEventId(input);
    if (!id) { setError("Paste a locator link like locator.riftbound.uvsgames.com/events/683264, or just the number."); return; }
    load(id);
  }

  // Phones: once the follow card has scrolled up out of view, a small bar pinned to the bottom
  // keeps the followed player's odds in sight; tapping it scrolls back to the card.
  const showFocus = !!(data && state && !isCut && meIdx >= 0 && state.eligible[meIdx] && odds?.results[meIdx]);
  const showGroup = !!(data && state && !isCut && members.length >= 2);
  useEffect(() => {
    const el = zoneRef.current;
    if (!narrow || !showFocus || !el || typeof IntersectionObserver === "undefined") { setFocusAbove(false); return; }
    const io = new IntersectionObserver(([e]) => setFocusAbove(!e.isIntersecting && e.boundingClientRect.top < 0));
    io.observe(el);
    return () => io.disconnect();
  }, [narrow, showFocus, showGroup, meIdx]);
  const showBar = narrow && showFocus && focusAbove;
  // Phones: picking someone in the group card shows their card just below it.
  const openFromGroup = (id) => {
    focusPlayer(id);
    if (narrow) setTimeout(() => focusRef.current?.scrollIntoView({ behavior: smooth(), block: "start" }), 60);
  };
  const eventLinkId = data ? (data.isDemo ? "demo" : data.id ?? eventId) : eventId;

  // Everything a standings row or card needs besides the player itself.
  const rowProps = {
    state, cutN, day2, full, actual, hasStatus, rewindTo,
    onOpen: focusPlayer, onStar: toggleMember,
    onLegend: (l) => { setLegendFilter(l); setTableQuery(""); goPage(1); },
  };

  const status = !state ? null
    : isCut ? (data.cut.status === "COMPLETE" ? "Top cut complete" : "Top cut in progress")
    : state.rewindTo ? `Rewound to the start of round ${state.rewindTo}`
    : !state.n ? "No pairings yet"
    : state.roundInProgress ? `Round ${state.currentRound} of ${state.roundsTotal} · in progress`
    : state.futureRounds > 0 ? `Round ${state.roundsPaired} of ${state.roundsTotal} complete`
    : "Swiss complete";

  return (
    <div className={`wrap ${data && state ? "wide" : ""} ${showBar ? "has-bar" : ""}`}>
      <header>
        <div className="label head-links">Riftbound · Live event odds{!PREVIEW && <>{" "}<span>· <a href="/planner.html">Swiss planner →</a></span></>}
          {DONATE_URL && <>{" "}<span>· <a href={DONATE_URL} target="_blank" rel="noopener noreferrer">Support this site</a></span></>}</div>
        <h1>Who makes the cut — <span>with the standings as they are right now.</span></h1>
        <p>Paste a Riftbound event locator link. The calculator pulls the current standings and pairings, plays out every result still to come, and ranks players using the official tiebreakers.</p>
      </header>

      <form className="panel load" onSubmit={submit}>
        <label className="label" htmlFor="event">Event link or number</label>
        <div className="load-row">
          <input id="event" value={input} onChange={(e) => setInput(e.target.value)}
            placeholder={narrow ? "683264 or a link" : "https://locator.riftbound.uvsgames.com/events/683264"} inputMode="url" autoComplete="off"
            autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="go" />
          <button type="submit" className="primary" disabled={loading}>{loading ? "Loading…" : data && parseEventId(input) === eventId ? "Refresh" : "Load event"}</button>
        </div>
        {loading && progress?.total >= 3 && <p className="hint" aria-live="polite">Loading rounds… {progress.done} of {progress.total}</p>}
        {error && <p className="err">{error}</p>}
        {!data && !loading && lastEvent && !lastEvent.auto && (
          <p className="hint">Pick up where you left off: <button type="button" className="link last-event" onClick={() => { setInput(lastEvent.id); load(lastEvent.id); }}>{lastEvent.name || `event ${lastEvent.id}`}</button></p>
        )}
        {!data && !loading && (
          <p className="hint">No event handy? <button type="button" className="link" onClick={() => { setInput("demo"); load("demo"); }}>Try the demo event</button></p>
        )}
      </form>

      {data && state && (
        <>
          <section className="event">
            <div>
              <h2>{data.name}</h2>
              <p className="muted">
                {[data.store, data.start && new Date(data.start).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }), data.playerCount && `${data.playerCount} players`].filter(Boolean).join(" · ")}
              </p>
            </div>
            <div className="event-status">
              <span className={`chip ${state.roundInProgress ? "live" : ""}`}>{status}</span>
              <span className="muted small">Updated {timeAgo(data.fetchedAt, now)}{data.isDemo ? " · sample data" : ""}</span>
            </div>
          </section>
          {linkNote && (
            <div className="linknote" role="status">
              <p>
                {linkNote.kind === "replaced" && <>Showing <b>{linkNote.shared.name || "a shared group"}</b> from a link ({linkNote.shared.ids.length} player{linkNote.shared.ids.length === 1 ? "" : "s"}). Your own group of {linkNote.prev.ids.length} is set aside.{linkNote.missing ? ` ${linkNote.missing} player${linkNote.missing === 1 ? " in the link isn't" : "s in the link aren't"} in this event.` : ""}</>}
                {linkNote.kind === "partial" && <>{linkNote.missing} player{linkNote.missing === 1 ? " in this link isn't" : "s in this link aren't"} in this event, so {linkNote.missing === 1 ? "they're" : "they're"} not shown.</>}
                {linkNote.kind === "none" && <>None of the {linkNote.count} player{linkNote.count === 1 ? "" : "s"} in this link {linkNote.count === 1 ? "is" : "are"} in this event.</>}
              </p>
              <div className="ln-actions">
                {linkNote.kind === "replaced" && <>
                  <button type="button" className="link small" onClick={() => {
                    const ids = [...new Set([...linkNote.shared.ids, ...linkNote.prev.ids])].slice(0, MAX_GROUP);
                    commitGroup(ids, linkNote.shared.name || linkNote.prev.name, focusChoice); setLinkNote(null);
                  }}>Combine with mine</button>
                  <button type="button" className="link small" onClick={() => { commitGroup(linkNote.prev.ids, linkNote.prev.name, linkNote.prev.ids[0] ?? null); setLinkNote(null); }}>Back to my group</button>
                </>}
                <button type="button" className="ln-x" aria-label="Dismiss" onClick={() => setLinkNote(null)}>×</button>
              </div>
            </div>
          )}
          {staleError && (
            <div className="stale" role="alert">
              <p><b>Couldn't update.</b> {staleError} Showing results from {new Date(data.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.</p>
              <button type="button" className="link small" onClick={() => load(eventId)} disabled={loading}>{loading ? "Trying…" : "Try again"}</button>
            </div>
          )}

          <form className={`panel settings ${moreOpen ? "open" : ""} ${dirty ? "dirty" : ""} ${stages[Number(form.phase)]?.cut ? "cutview" : ""}`} onSubmit={applySettings} noValidate>
            <div className={`controls ${d2info?.rounds > 0 && Number(form.phase) === 0 ? "seven" : ""}`}>
            {stages.length > 1 && (
              <div className="field f-phase">
                <label className="label" htmlFor="phase">Phase</label>
                <select id="phase" value={form.phase} onChange={edit("phase")}>
                  {stages.map((o, i) => (
                    <option key={i} value={i} disabled={!o.started}>{o.label}{o.started ? "" : " (not started)"}</option>
                  ))}
                </select>
                <div className="hint">
                  {stages[Number(form.phase)]?.cut
                    ? "Single elimination: lose once and you're out"
                    : Number(form.phase) > 0 ? "Only players who made this day are ranked; earlier records carry over"
                    : phases.length ? (d2info?.rounds ? "Day 1 standings; odds play out Day 2 too" : "First day of Swiss, on its own") : "All Swiss rounds"}
                </div>
              </div>
            )}
            {!stages[Number(form.phase)]?.cut && <>
            <div className="field adv">
              <label className="label" htmlFor="asof">Show odds as of</label>
              <select id="asof" value={form.asof} onChange={edit("asof")}>
                {(phases.length
                  ? (data.rounds || []).filter((r) => (r.phase ?? 0) === Number(form.phase) && r.hasPairings && r.matches.length).map((r) => r.number)
                  : state.roundsAvailable
                ).map((n) => (
                  <option key={n} value={n}>Start of round {n}</option>
                ))}
                <option value="">Latest results</option>
              </select>
              <div className="hint">{form.asof !== "" ? `Round ${form.asof} pairings posted, nothing reported yet` : "Rewind to see the odds earlier in the event"}</div>
            </div>
            <div className="field adv">
              <label className="label" htmlFor="cut">Top cut / target rank</label>
              <input id="cut" type="number" inputMode="numeric" min="1" max={state.n || 1} value={form.cut} onChange={edit("cut")} />
              <div className="hint">Finish in the top N</div>
            </div>
            <div className="field adv">
              <label className="label" htmlFor="rounds">Swiss rounds</label>
              <input id="rounds" type="number" inputMode="numeric" min={state.roundsPaired} max="18" value={form.rounds} onChange={edit("rounds")} />
              <div className="hint">{state.plannedRounds ? `Event lists ${state.plannedRounds}` : "Not listed"}{state.futureRounds ? ` · ${state.futureRounds} still to pair` : ""}</div>
            </div>
            <div className="field adv">
              <label className="label" htmlFor="draws">Draw rate %</label>
              <input id="draws" type="number" inputMode="decimal" min="0" max="60" value={form.draws} onChange={edit("draws")} />
              <div className="hint">About 3% of matches at big events</div>
            </div>
            {d2info?.rounds > 0 && Number(form.phase) === 0 && (
              <div className="field adv">
                <label className="label" htmlFor="d2t">Day 2 at (pts)</label>
                <input id="d2t" type="number" inputMode="numeric" min="1" max={3 * (d2info.day1Rounds || 18)} value={form.d2t} onChange={edit("d2t")} />
                <div className="hint">
                  {d2info.used != null ? `This event's cutoff was ${d2info.used}` : `Rule: two losses or better (${d2info.rule})`} · {d2info.rounds} Day 2 rounds
                </div>
              </div>
            )}
            <div className="field f-follow">
              <label className="label" htmlFor="me">{members.length ? `Following ${members.length}` : "Follow players"}</label>
              {state.n > BIG_EVENT ? (
                <PlayerSearch players={state.players} exclude={inGroup} onPick={focusPlayer} full={members.length >= MAX_GROUP}
                  placeholder={members.length >= MAX_GROUP ? "Group is full" : members.length ? "Add another player" : "Find a player to follow"} />
              ) : (
                <select id="me" value="" onChange={(e) => e.target.value && focusPlayer(e.target.value)} disabled={members.length >= MAX_GROUP}>
                  <option value="">{members.length >= MAX_GROUP ? "Group is full" : members.length ? "Add another player…" : "Choose a player…"}</option>
                  {[...state.players].filter((p) => !inGroup.has(idxById.get(String(p.id)))).sort((a, b) => a.handle.localeCompare(b.handle)).map((p) => (
                    <option key={p.id} value={p.id}>{p.handle}{p.name && p.name !== p.handle ? ` (${p.name})` : ""}</option>
                  ))}
                </select>
              )}
              <div className="hint">
                {members.length >= MAX_GROUP ? `Up to ${MAX_GROUP} players · remove someone to add more`
                  : members.length ? "Or use ☆ on any player · saved on this device"
                  : "Or use ☆ on any player · follow friends as a group"}
              </div>
            </div>
            </>}
            {!stages[Number(form.phase)]?.cut && (
              <button type="button" className="set-toggle" aria-expanded={moreOpen} aria-controls="asof" onClick={() => setMoreOpen((v) => !v)}>
                <span className="set-toggle-text">
                  <span className="label">{moreOpen ? "Fewer settings" : "More settings"}</span>
                  {!moreOpen && (
                    <span className="set-sum">
                      {[form.asof !== "" ? `As of round ${form.asof}` : "Latest results", `Top ${form.cut}`, `${form.rounds} rounds`, `${form.draws}% draws`,
                        d2info?.rounds > 0 && Number(form.phase) === 0 && form.d2t !== "" ? `Day 2 at ${form.d2t}` : null].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </span>
                <span className="chev" aria-hidden="true" />
              </button>
            )}
            </div>
            <div className="apply-row">
              <div className="apply-left">
                <button type="submit" className="primary" disabled={!dirty}>Apply changes</button>
                {dirty
                  ? <><span className="muted small">Odds still show the old settings.</span> <button type="button" className="link small" onClick={() => setDraft(null)}>Undo</button></>
                  : <span className="muted small">Change any setting above, then apply.</span>}
              </div>
              {!isCut && (
                <div className="view-pick">
                  <span className="label">Table</span>
                  <div className="view-tabs" role="tablist" aria-label="Table columns">
                    {[["compact", "Compact"], ["full", "Full"]].map(([v, label]) => (
                      <button key={v} type="button" role="tab" aria-selected={view === v} className={`vtab ${view === v ? "on" : ""}`}
                        title={v === "full" ? "Adds the tiebreakers: OMW%, GW%, OGW%" : "Hides the tiebreaker columns"}
                        onClick={() => { setView(v); store.set("rb-view", v); }}>{label}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </form>

          {isCut && <TopCutView cut={data.cut} seeds={seeds} members={members} focusId={focusChoice ?? members[0]} handleOf={handleOf}
            onOpen={focusPlayer} onStar={toggleMember} narrow={narrow} day2Event={phases.length > 1}
            groupName={group.name} link={shareUrl(eventLinkId, members, group.name)} eventName={data.name} onClear={clearGroup} />}

          {!isCut && (showGroup || showFocus) && (
          <div className="follow-zone" ref={zoneRef}>
            {showGroup && <GroupCard members={members} idxById={idxById} standings={standings} state={state} odds={odds} cutN={cutN} day2={day2}
              full={full} actual={actual} hasStatus={hasStatus} rewindTo={rewindTo} pendingByPlayer={pendingByPlayer} focusIdx={meIdx}
              name={group.name} narrow={narrow} link={shareUrl(eventLinkId, members, group.name)} eventName={data.name}
              day2View={phases.length > 0 && swissIdx > 0} handleOf={handleOf}
              onOpen={openFromGroup} onStar={toggleMember} onRename={renameGroup} onClear={clearGroup} onLegend={rowProps.onLegend} />}
            {showFocus && <FocusCard state={state} odds={odds} i={meIdx} K={cutN} standings={standings} pending={pendingByPlayer.get(meIdx)}
              onUnfollow={() => removeMember(String(state.players[meIdx].id))} day2={day2} need={need} left={meLeft} groupSize={members.length}
              cardRef={focusRef} link={shareUrl(eventLinkId, [String(state.players[meIdx].id)])} eventName={data.name} />}
          </div>
          )}

          {!isCut && <>

          <section className="stack standings" ref={standingsRef}>
            <div className="section-head">
              <div className="sec-title">
                <h2 className="sec">{showLegends ? "Legends" : `Standings and top ${cutN} odds`}{phases.length ? ` · Day ${swissIdx + 1}` : ""}</h2>
                {legends.length > 0 && (
                  <div className="view-tabs" role="tablist" aria-label="Show">
                    {[["standings", "Standings"], ["legends", "Legends"]].map(([v, label]) => (
                      <button key={v} type="button" role="tab" aria-selected={tab === v} className={`vtab ${tab === v ? "on" : ""}`} onClick={() => pickTab(v)}>{label}</button>
                    ))}
                  </div>
                )}
              </div>
              {day2 && <span className="muted small">Top {cutN} odds include Day 2. Only players on {day2.threshold}+ pts after Day 1 play it.</span>}
              {odds?.method === "equal-start" && (
                <span className="muted small">Round 1, no results yet: everyone starts equal (top {cutN} ÷ {state.eligibleCount} players). Win/lose columns are simulated.</span>
              )}
            </div>
            <div className="table-tools">
              <div className="tt-left">
                {showLegends && <span className="muted small">{legends.length} legends · {narrow ? "tap" : "click"} one to see its players</span>}
                {!showLegends && standings.length > 50 && (
                  <input id="tq" type="search" placeholder="Find a player" value={tableQuery}
                    onChange={(e) => { setTableQuery(e.target.value); setPage(1); }} autoComplete="off" />
                )}
                {!showLegends && legends.length > 0 && (
                  <select id="legend" className="legend-select" value={legendFilter} onChange={(e) => { setLegendFilter(e.target.value); setPage(1); }}>
                    <option value="">All legends ({standings.length.toLocaleString()})</option>
                    {legends.map(([l, c]) => <option key={l} value={l}>{legendShort(l)} ({c.toLocaleString()})</option>)}
                  </select>
                )}
                {!showLegends && (tableQuery || legendFilter) && (
                  <span className="muted small">{filtered.length.toLocaleString()} match{filtered.length === 1 ? "" : "es"}</span>
                )}
              </div>
              <div className="tt-right">
                <RunStatus odds={odds} />
                {!data.isDemo && (
                  <label className="check" htmlFor="auto">Auto-refresh
                    <select id="auto" className="inline" value={autoMin} onChange={(e) => setAutoMin(Number(e.target.value))}>
                      <option value={0}>Off</option>
                      <option value={5}>5 min</option>
                      <option value={10}>10 min</option>
                    </select>
                  </label>
                )}
              </div>
              {odds && !odds.done && !odds.stale && !odds.combos && (
                <div className="progress"><i style={{ width: `${Math.min(1, odds.runs / odds.target) * 100}%` }} /></div>
              )}
            </div>
            {showLegends ? (
              <LegendTable standings={standings} odds={odds} state={state} K={cutN} day2={day2} day2View={phases.length > 0 && swissIdx > 0} narrow={narrow}
                onPick={(l) => { setLegendFilter(l); setTableQuery(""); setPage(1); pickTab("standings"); }} />
            ) : (<>
            {narrow ? (
              <ol className="cards" aria-label="Standings">
                {shown.map((r) => (
                  <StandingCard key={r.id} {...rowProps} r={r} o={odds?.results[r.i]} pend={pendingByPlayer.get(r.i)}
                    focused={r.i === meIdx} member={inGroup.has(r.i)} />
                ))}
              </ol>
            ) : (
            <div className="tablebox">
              <table className={full ? "full" : "compact"}>
                <thead><StandingsHead cutN={cutN} full={full} day2={day2} actual={actual} hasStatus={hasStatus} /></thead>
                <tbody>
                  {shown.map((r) => (
                    <StandingRow key={r.id} {...rowProps} r={r} o={odds?.results[r.i]} pend={pendingByPlayer.get(r.i)}
                      focused={r.i === meIdx} member={inGroup.has(r.i)} />
                  ))}
                </tbody>
              </table>
            </div>
            )}
            <Pager page={pageNow} pages={pages} total={filtered.length} size={pageSize} narrow={narrow} onPage={goPage}
              onMine={myPos >= 0 ? goMine : null} />
            {hasStatus && <p className="muted small">{rewindTo ? `Status shows who was still playing at round ${rewindTo}.` : "Status comes from the event locator and shows where things stand now."} Legends are whatever players entered at registration.</p>}
            {actual && <p className="muted small">Rewound view: odds use only what was known when round {rewindTo} was paired. The last column shows how each player {actual.complete ? "actually finished" : "stands now"} — green means inside the top {cutN}.</p>}
            {odds?.method === "simulation" && <p className="muted small">With more than one round left, odds come from playing the event out many times, so players in identical spots can differ by about the accuracy shown above.</p>}
            <p className="muted small">{narrow ? "Tap a player" : "Click a row"} to follow them and see their card; ☆ adds or removes someone from your group without switching the card. "If win / draw / lose" is each player's top {cutN} chance after {narrow ? "their next match" : "the match in the Next match column"}: the one they're playing now, or their next round if they've already reported. A bye counts as a win.</p>
            </>)}
          </section>
          {showBar && <FollowBar state={state} i={meIdx} o={odds.results[meIdx]} K={cutN} row={standings.find((r) => r.i === meIdx)}
            pending={pendingByPlayer.get(meIdx)} rewound={!!rewindTo} extra={members.length - 1}
            onJump={() => zoneRef.current?.scrollIntoView({ behavior: smooth(), block: "start" })} />}
          </>}
        </>
      )}

      {toast && (
        <div className={`toast ${showBar ? "above-bar" : ""}`} role="status" aria-live="polite">
          <span>{toast.msg}</span>
          {toast.undo && <button type="button" onClick={toast.undo}>Undo</button>}
        </div>
      )}

      <section className="panel notes">
        <h2>How it works</h2>
        <div className="notes-grid">
          <div>
            <h3>Standings</h3>
            <p>Rebuilt from every reported match and ranked the same way as the event locator: points, then opponents' match win %, game win %, and opponents' game win %. Checked against the locator's own standings at three 1,800-player events.</p>
          </div>
          <div>
            <h3>The odds</h3>
            <p>Every result still to come is played out, with pairings by points and no rematches. When only this round's matches are left, every possible finish is checked, so the odds are exact. Unplayed matches are treated as even, with draws at the rate you set. Byes count as a win, and players who've dropped aren't paired again.</p>
          </div>
          <div>
            <h3>Two-day events</h3>
            <p>The Day 1 view plays out Day 2 as well. Only players on enough points after Day 1 (two losses or better, unless you change it) keep playing, and only they can make the top cut.</p>
          </div>
          <div>
            <h3>Data</h3>
            <p>Everything comes from the public Riftbound event locator. This is an unofficial tool and isn't affiliated with Riot Games or UVS Games.</p>
            {DONATE_URL && <p className="donate">Free to use, no ads. If it helped at your event, you can <a href={DONATE_URL} target="_blank" rel="noopener noreferrer">chip in for hosting</a>.</p>}
          </div>
        </div>
      </section>
    </div>
  );
}

const onEnter = (fn) => (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } };

/* ☆ / ★: add a player to the followed group, or take them out. Doesn't open their card. */
function StarButton({ on, name, onToggle }) {
  return (
    <button type="button" className={`star ${on ? "on" : ""}`} aria-pressed={on}
      aria-label={on ? `Stop following ${name}` : `Follow ${name}`} title={on ? "Following · tap to stop" : "Follow (add to your group)"}
      onClick={(e) => { e.stopPropagation(); onToggle(); }} onKeyDown={(e) => e.stopPropagation()}>
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <path d="M10 1.8l2.47 5.2 5.66.7-4.16 3.92 1.06 5.62L10 14.5l-5.03 2.74 1.06-5.62L1.87 7.7l5.66-.7z"
          fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/* Desktop standings table: header and one row. Shared by the standings and the group table. */
function StandingsHead({ cutN, full, day2, actual, hasStatus }) {
  return (
    <tr>
      <th className="star-col"><span className="sr-only">Follow</span></th>
      <th className="num">#</th><th>Player</th><th>Record</th><th className="num">Pts</th>
      {full && <><th className="num" title="Opponents' match win % (1st tiebreaker)">OMW%</th><th className="num" title="Game win % (2nd tiebreaker)">GW%</th><th className="num" title="Opponents' game win % (3rd tiebreaker)">OGW%</th></>}
      <th className="num">Top {cutN}</th>
      {day2 && <th className="num" title={`Chance of ${day2.threshold}+ pts after Day 1`}>Day 2</th>}
      <th title="The match the next three columns are about">Next match</th>
      <th className="num">If win</th><th className="num">If draw</th><th className="num">If lose</th>
      {actual && <th>{actual.complete ? "Actual finish" : "Now"}</th>}
      {hasStatus && <th>Status</th>}
    </tr>
  );
}
function StandingRow({ r, o, pend, focused, member, state, cutN, day2, full, actual, hasStatus, rewindTo, onOpen, onStar, onLegend }) {
  const showName = r.name && r.name !== r.handle;
  return (
    <tr className={`${focused ? "mine" : member ? "grp" : ""}`} onClick={() => onOpen(r.id)}>
      <td className="star-col"><StarButton on={member} name={r.handle} onToggle={() => onStar(r.id)} /></td>
      <td className="num">{r.tied ? `T${r.rank}` : r.rank}</td>
      <td className="player-cell">
        <div className="who"><span className="nm" title={r.handle}>{r.handle}</span>{pend && (rewindTo ? <span className="tag">Table {pend.table}</span> : <span className="tag live">Playing · T{pend.table}</span>)}</div>
        {(showName || r.legend) && (
          <div className="sub">
            {showName && <span className="muted small">{r.name}</span>}
            {r.legend && (
              <button type="button" className="legend-chip" title={`${r.legend} · show only this legend`}
                onClick={(e) => { e.stopPropagation(); onLegend(r.legend); }}>{legendShort(r.legend)}</button>
            )}
          </div>
        )}
      </td>
      <td className="mono">{rec(r.w, r.l, r.d)}</td>
      <td className="num">{r.pts}</td>
      {full && <>
        <td className="num">{(r.omw * 100).toFixed(1)}</td>
        <td className="num">{(r.gwp * 100).toFixed(1)}</td>
        <td className="num">{(r.ogw * 100).toFixed(1)}</td>
      </>}
      <td className="num"><span className={pillClass(o?.pTop)}>{o ? pct(o.pTop) : "…"}</span></td>
      {day2 && <td className="num"><span className="cond">{o?.pDay2 != null ? pct(o.pDay2) : "…"}</span></td>}
      <td>{pend
        ? <span className={rewindTo ? "nextm" : "nextm live"} title={`Round ${pend.round}, table ${pend.table}${rewindTo ? "" : ", being played now"}`}>Round {pend.round}{rewindTo ? "" : " · now"}</span>
        : state.futureRounds > 0 && state.active[r.i]
          ? <span className="nextm muted" title={`Round ${state.roundsPaired + 1} isn't paired yet. A bye counts as a win.`}>Round {state.roundsPaired + 1}</span>
          : <span className="muted">—</span>}</td>
      {[0, 1, 2].map((k) => (
        <td className="num" key={k}>{o?.cond[k] ? <span className="cond">{pct(o.cond[k].top)}</span> : <span className="muted">—</span>}</td>
      ))}
      {actual && (() => {
        const a = actual.byId.get(r.id);
        if (!a && actual.outIds?.has(r.id)) return <td><span className="missed small">Out after Day 1</span></td>;
        if (!a) return <td className="muted">—</td>;
        const inTop = a.rank <= cutN;
        return <td className="mono"><span className={inTop ? "made" : "missed"}>{a.tied ? "T" : "#"}{a.rank}</span> <span className="muted small">{rec(a.w, a.l, a.d)}</span></td>;
      })()}
      {hasStatus && (() => {
        const st = statusOf(r);
        return <td>{st ? <span className={`status ${st.cls}`}>{st.label}</span> : <span className="muted">—</span>}</td>;
      })()}
    </tr>
  );
}

/* Phone layout: one card per player instead of a wide table row.
   Top line: rank (and ☆), name, top-cut pill. Then name/legend, record line, and a strip with the
   next match and the If win / draw / lose odds. */
function StandingCard({ r, o, focused, member, pend, state, cutN, day2, full, actual, hasStatus, rewindTo, onOpen, onStar, onLegend }) {
  const mine = focused;
  const showName = r.name && r.name !== r.handle;
  // Cards only flag the exceptions (dropped, eliminated…); "Active" on every card is just noise
  const st0 = hasStatus ? statusOf(r) : null;
  const st = st0 && st0.cls !== "st-in" ? st0 : null;
  const upcoming = !pend && state.futureRounds > 0 && state.active[r.i];
  const hasCond = !!o?.cond.some(Boolean);
  let act = null;
  if (actual) {
    const a = actual.byId.get(r.id);
    act = !a ? (actual.outIds?.has(r.id) ? <span className="missed">Out after Day 1</span> : null)
      : <span><span className="c-k">{actual.complete ? "Finished" : "Now"}</span> <b className={`mono ${a.rank <= cutN ? "made" : "missed"}`}>{a.tied ? "T" : "#"}{a.rank}</b> <span className="mono muted">{rec(a.w, a.l, a.d)}</span></span>;
  }
  const open = () => onOpen(r.id);
  return (
    <li className={`card ${mine ? "mine" : member ? "grp" : ""}`} tabIndex={0} onClick={open} onKeyDown={onEnter(open)} aria-current={mine || undefined}>
      <div className="c-rank">
        <span className="mono">{r.tied ? `T${r.rank}` : r.rank}</span>
        <StarButton on={member} name={r.handle} onToggle={() => onStar(r.id)} />
      </div>
      <div className="c-main">
        <div className="c-name"><span className="nm">{r.handle}</span></div>
        {(showName || r.legend) && (
          <div className="sub">
            {showName && <span className="muted small c-real">{r.name}</span>}
            {r.legend && (
              <button type="button" className="legend-chip" title={`${r.legend} · show only this legend`}
                onClick={(e) => { e.stopPropagation(); onLegend(r.legend); }} onKeyDown={(e) => e.stopPropagation()}>{legendShort(r.legend)}</button>
            )}
          </div>
        )}
        <div className="c-meta">
          <span className="mono c-rec">{rec(r.w, r.l, r.d)}</span>
          <span><b className="mono">{r.pts}</b> pts</span>
          {day2 && <span><span className="c-k">Day 2</span> <b className="mono">{o?.pDay2 != null ? pct(o.pDay2) : "…"}</b></span>}
          {st && <span className={`status ${st.cls}`}>{st.label}</span>}
        </div>
        {full && (
          <div className="c-meta c-tb mono">
            <span><span className="c-k">OMW</span> {(r.omw * 100).toFixed(1)}</span>
            <span><span className="c-k">GW</span> {(r.gwp * 100).toFixed(1)}</span>
            <span><span className="c-k">OGW</span> {(r.ogw * 100).toFixed(1)}</span>
          </div>
        )}
        {act && <div className="c-meta">{act}</div>}
      </div>
      <div className="c-top">
        <span className={pillClass(o?.pTop)}>{o ? pct(o.pTop) : "…"}</span>
        <span className="c-toplabel">Top {cutN}</span>
      </div>
      {(pend || upcoming || hasCond) && (
        <div className="c-strip">
          <div className="c-cell c-next">
            <span className="c-k">Next</span>
            {pend
              ? rewindTo ? <span className="nextm">R{pend.round} · T{pend.table}</span> : <span className="nextm live">Now · T{pend.table}</span>
              : upcoming ? <span className="nextm muted" title="Not paired yet">Round {state.roundsPaired + 1}</span>
              : <span className="muted">—</span>}
          </div>
          {["If win", "If draw", "If lose"].map((lab, k) => (
            <div className="c-cell" key={k}>
              <span className="c-k">{lab}</span>
              {o?.cond[k] ? <b className="mono">{pct(o.cond[k].top)}</b> : <span className="muted">—</span>}
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

/* Legends: how each legend is doing in this event. Click a row to see its players. */
function LegendTable({ standings, odds, state, K, day2, day2View, onPick, narrow }) {
  const [sort, setSort] = useState("players");
  const rows = useMemo(() => {
    const g = new Map();
    const get = (l) => {
      if (!g.has(l)) g.set(l, { legend: l, players: 0, day1: 0, wins: 0, games: 0, top: 0, d2: 0, best: null });
      return g.get(l);
    };
    for (const r of standings) {
      const e = get(r.legend || "");
      e.players++;
      const byes = state.base.byes[r.i];
      e.wins += r.w - byes; e.games += r.w + r.l + r.d - byes;
      const o = odds?.results[r.i];
      if (o) { e.top += o.pTop; if (o.pDay2 != null) e.d2 += o.pDay2; }
      if (!e.best) e.best = r; // standings are in rank order
    }
    if (day2View) for (const p of state.players) get(p.legend || "").day1++;
    const total = standings.length || 1;
    return [...g.values()].map((e) => ({ ...e, field: e.players / total, win: e.games ? e.wins / e.games : null, share: K ? e.top / K : 0 }));
  }, [standings, odds, state, K, day2View]);
  const sorted = [...rows].sort((a, b) =>
    sort === "win" ? (b.win ?? -1) - (a.win ?? -1) || b.players - a.players
      : sort === "top" ? b.top - a.top || b.players - a.players
      : b.players - a.players || b.top - a.top);
  const maxShare = Math.max(0.0001, ...rows.map((r) => r.share));
  const Th = ({ k, children, title }) => (
    <th className="num"><button type="button" className={`th-sort ${sort === k ? "on" : ""}`} title={title} onClick={() => setSort(k)}>{children}{sort === k ? " ↓" : ""}</button></th>
  );
  const f1 = (x) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
  const note = <p className="muted small">Legends are whatever players entered at registration. "Top {K} (expected)" adds up each player's top {K} chance, so it's the average number of top {K} spots that legend ends up with. {narrow ? "Tap" : "Click"} a legend to see its players in the standings.</p>;
  if (narrow) {
    return (
      <>
        <div className="seg-row">
          <span className="label">Sort</span>
          <div className="view-tabs" role="tablist" aria-label="Sort legends">
            {[["players", "Players"], ["win", "Win %"], ["top", `Top ${K}`]].map(([k, lab]) => (
              <button key={k} type="button" role="tab" aria-selected={sort === k} className={`vtab ${sort === k ? "on" : ""}`} onClick={() => setSort(k)}>{lab}</button>
            ))}
          </div>
        </div>
        <ol className="cards" aria-label="Legends">
          {sorted.map((e) => {
            const pick = () => e.legend && onPick(e.legend);
            return (
              <li key={e.legend || "none"} className={`card lcard ${e.legend ? "" : "no-click"}`} tabIndex={e.legend ? 0 : -1} onClick={pick} onKeyDown={onEnter(pick)}>
                <div className="c-main">
                  <div className="c-name"><span className="nm">{e.legend ? legendShort(e.legend) : "Not entered"}</span></div>
                  {e.legend && e.legend.includes(",") && <div className="sub"><span className="muted small c-real">{e.legend.split(",").slice(1).join(",").trim()}</span></div>}
                </div>
                <div className="c-top">
                  <b className="mono c-big">{e.players.toLocaleString()}</b>
                  <span className="c-toplabel">{day2View ? "In Day 2" : `${f1(e.field)} of field`}</span>
                </div>
                <div className="c-share">
                  <div className="share"><i style={{ width: `${(100 * e.share) / maxShare}%` }} /></div>
                  <span className="mono small">{odds ? f1(e.share) : "…"}</span>
                  <span className="c-k">of top {K} odds</span>
                </div>
                <div className="c-strip c-strip3">
                  {day2View && <div className="c-cell"><span className="c-k">Made Day 2</span><b className="mono">{e.day1 ? f1(e.players / e.day1) : "—"}</b></div>}
                  {day2 && <div className="c-cell"><span className="c-k">Day 2 (exp.)</span><b className="mono">{odds ? e.d2.toFixed(1) : "…"}</b></div>}
                  <div className="c-cell"><span className="c-k">Match win</span><b className="mono">{f1(e.win)}</b></div>
                  <div className="c-cell"><span className="c-k">Top {K} (exp.)</span><b className="mono">{odds ? e.top.toFixed(2) : "…"}</b></div>
                </div>
                {e.best && (
                  <div className="c-best small">
                    <span className="c-k">Best</span> <b className="nm">{e.best.handle}</b> <span className="muted mono">{e.best.tied ? "T" : "#"}{e.best.rank} · {rec(e.best.w, e.best.l, e.best.d)}</span>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {note}
      </>
    );
  }
  return (
    <>
      <div className="tablebox">
        <table className="compact legends">
          <thead><tr>
            <th>Legend</th>
            <Th k="players" title="Sort by number of players">{day2View ? "In Day 2" : "Players"}</Th>
            {day2View ? <th className="num" title="Players on this legend who started Day 1">Day 1</th> : <th className="num">Of field</th>}
            {day2View && <th className="num" title="Share of this legend's Day 1 players who made Day 2">Made Day 2</th>}
            {day2 && <th className="num" title={`Expected players on ${day2.threshold}+ pts after Day 1`}>Day 2 (expected)</th>}
            <Th k="win" title="Match win rate so far, byes not counted">Match win %</Th>
            <Th k="top" title={`How many of the top ${K} this legend is expected to have`}>Top {K} (expected)</Th>
            <th>Share of top {K} odds</th>
            <th>Best placed</th>
          </tr></thead>
          <tbody>
            {sorted.map((e) => (
              <tr key={e.legend || "none"} onClick={() => e.legend && onPick(e.legend)} className={e.legend ? "" : "no-click"}>
                <td className="player-cell">
                  <div className="who"><span className="nm" title={e.legend || ""}>{e.legend ? legendShort(e.legend) : "Not entered"}</span></div>
                  {e.legend && e.legend.includes(",") && <div className="sub"><span className="muted small">{e.legend.split(",").slice(1).join(",").trim()}</span></div>}
                </td>
                <td className="num">{e.players.toLocaleString()}</td>
                {day2View ? <td className="num">{e.day1.toLocaleString()}</td> : <td className="num">{f1(e.field)}</td>}
                {day2View && <td className="num">{e.day1 ? f1(e.players / e.day1) : "—"}</td>}
                {day2 && <td className="num">{odds ? `${e.d2.toFixed(1)} (${f1(e.players ? e.d2 / e.players : 0)})` : "…"}</td>}
                <td className="num">{f1(e.win)}</td>
                <td className="num">{odds ? e.top.toFixed(2) : "…"}</td>
                <td>
                  <div className="sharecell">
                    <div className="share"><i style={{ width: `${(100 * e.share) / maxShare}%` }} /></div>
                    <span className="mono small">{odds ? f1(e.share) : "…"}</span>
                  </div>
                </td>
                <td className="best">{e.best ? <><b className="nm" title={e.best.handle}>{e.best.handle}</b> <span className="muted small">{e.best.tied ? "T" : "#"}{e.best.rank} · {rec(e.best.w, e.best.l, e.best.d)}</span></> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note}
    </>
  );
}

function FocusCard({ state, odds, i, K, standings, pending, onUnfollow, day2, need, left, cardRef, link, eventName, groupSize = 1 }) {
  const [shareMsg, share] = useShare(i);
  const p = state.players[i];
  const row = standings.find((r) => r.i === i);
  const o = odds.results[i];
  const oppIdx = pending ? (pending.a === i ? pending.b : pending.a) : -1;
  const opp = oppIdx >= 0 ? state.players[oppIdx] : null;
  const next = pending
    ? state.rewindTo
      ? `Round ${state.rewindTo}: paired with ${opp?.handle || "an opponent"} at table ${pending.table}`
      : `Playing ${opp?.handle || "an opponent"} at table ${pending.table} now`
    : state.futureRounds > 0 ? `Next up: round ${state.roundsPaired + 1} (not paired yet)` : "No matches left in Swiss";
  const labels = ["Win", "Draw / ID", "Lose"];
  const after = pending
    ? `Top ${K} chance after this match (round ${pending.round})`
    : `Top ${K} chance after round ${state.roundsPaired + 1} · a bye counts as a win`;
  return (
    <section className="panel focus" ref={cardRef}>
      <div className="focus-head">
        <div>
          <div className="focus-label">
            <span className="label">Following</span>
            <button type="button" className="link small" onClick={onUnfollow}>{groupSize > 1 ? "Remove from group" : "Stop following"}</button>
            <button type="button" className="share-btn" aria-label={`Share a link to ${p.handle}'s odds`}
              onClick={() => share(link, `${p.handle} · ${eventName || "Riftbound event"}`)}>
              {SHARE_ICON}{shareMsg === "copied" ? "Link copied" : groupSize > 1 ? "Share player" : "Share"}
            </button>
            <span className="sr-only" aria-live="polite">{shareMsg === "copied" ? "Link copied" : ""}</span>
          </div>
          <h2 className="sec">{p.handle}</h2>
          <p className="muted small">{row ? `${row.tied ? "Tied " : ""}#${row.rank} · ${rec(row.w, row.l, row.d)} · ${row.pts} pts` : ""}</p>
        </div>
        <div className="big">
          <div className="label">Top {K} chance</div>
          <span className={pillClass(o.pTop) + " big-pill"}>{pct(o.pTop)}</span>
          <div className="muted small">Expected finish ≈ #{o.expRank.toFixed(1)}</div>
          {day2 && o.pDay2 != null && <div className="muted small">Day 2 ({day2.threshold}+ pts): <b className="cond">{pct(o.pDay2)}</b></div>}
        </div>
      </div>
      {shareMsg === "manual" && (
        <div className="share-manual">
          <label className="small muted" htmlFor="share-url">Copy this link to share {p.handle}'s odds:</label>
          <input id="share-url" readOnly value={link} onFocus={(e) => e.target.select()} autoFocus />
        </div>
      )}
      <p className="muted">{next}</p>
      {o.cond.some(Boolean) && <div className="label">{after}</div>}
      {o.cond.some(Boolean) && (
        <div className="outcomes">
          {o.cond.map((c, k) => (
            <div className="outcome" key={k}>
              <div className="label">{labels[k]}</div>
              <span className={pillClass(c?.top)}>{c ? pct(c.top) : "—"}</span>
            </div>
          ))}
        </div>
      )}
      {left >= 2 && <NeedTable row={row} need={need} K={K} day2={day2} name={p.handle} />}
    </section>
  );
}

/* The followed group (2+ players): everyone's odds at a glance, best-placed first.
   Tap a player to show their full card below; ☆ takes them out of the group. */
const SHARE_ICON = <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.5v8M4.8 4.6 8 1.5l3.2 3.1M3 8.5v5h10v-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
function useShare(resetKey) {
  const [msg, setMsg] = useState(null); // "copied" | "manual" | null
  useEffect(() => { setMsg(null); }, [resetKey]);
  useEffect(() => {
    if (msg !== "copied") return;
    const t = setTimeout(() => setMsg(null), 2500);
    return () => clearTimeout(t);
  }, [msg]);
  const share = async (url, title) => { const r = await shareLink(url, title); if (r === "copied" || r === "manual") setMsg(r); };
  return [msg, share];
}
function GroupCard({ members, idxById, standings, state, odds, cutN, day2, full, actual, hasStatus, rewindTo, pendingByPlayer, focusIdx,
  name, narrow, link, eventName, day2View, handleOf, onOpen, onStar, onRename, onClear, onLegend }) {
  const [editing, setEditing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [msg, share] = useShare(link);
  const byIdx = useMemo(() => new Map(standings.map((r) => [r.i, r])), [standings]);
  const ranked = [], out = [];
  for (const id of members) {
    const i = idxById.get(id);
    const r = i != null ? byIdx.get(i) : null;
    if (r) ranked.push(r);
    else out.push({ id, i: i ?? -1, handle: i != null ? state.players[i].handle : handleOf(id) });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.handle.localeCompare(b.handle));
  // Big groups: the best-placed 6 (plus whoever's card is open) until "Show all".
  const LIMIT = 8, FOLD = 6;
  const folded = !showAll && ranked.length + out.length > LIMIT;
  const shownRanked = folded ? ranked.filter((r, k) => k < FOLD || r.i === focusIdx) : ranked;
  const shownOut = folded ? [] : out;
  const hidden = ranked.length + out.length - shownRanked.length - shownOut.length;
  const outLabel = (x) => {
    if (x.i < 0) return "Not in this part of the event";
    const b = state.base, rec1 = rec(b.w[x.i], b.l[x.i], b.d[x.i]);
    return day2View ? `Didn't make Day 2 · ${rec1} on Day 1` : `Not ranked here · ${rec1}`;
  };
  const title = name || "Your group";
  const saveName = (v) => { onRename(v); setEditing(false); };
  const cols = 10 + (full ? 3 : 0) + (day2 ? 1 : 0) + (actual ? 1 : 0) + (hasStatus ? 1 : 0);
  return (
    <section className="panel group" aria-label={`Followed players: ${title}`}>
      <div className="group-head">
        <div className="gh-title">
          <span className="label">Following · {members.length} players</span>
          {editing ? (
            <input className="gh-name-input" aria-label="Group name" autoFocus maxLength={MAX_NAME} defaultValue={name} placeholder="Name this group"
              onKeyDown={(e) => { if (e.key === "Enter") saveName(e.currentTarget.value); if (e.key === "Escape") setEditing(false); }}
              onBlur={(e) => saveName(e.currentTarget.value)} />
          ) : <h2 className="sec">{title}</h2>}
        </div>
        <div className="gh-actions">
          <button type="button" className="share-btn" onClick={() => share(link, `${title} · ${eventName || "Riftbound event"}`)}
            aria-label={`Share a link to this group of ${members.length} players`}>
            {SHARE_ICON}{msg === "copied" ? "Link copied" : "Share group"}
          </button>
          {!editing && <button type="button" className="link small" onClick={() => setEditing(true)}>{name ? "Rename" : "Name it"}</button>}
          <button type="button" className="link small" onClick={onClear}>Clear</button>
          <span className="sr-only" aria-live="polite">{msg === "copied" ? "Link copied" : ""}</span>
        </div>
      </div>
      {msg === "manual" && (
        <div className="share-manual">
          <label className="small muted" htmlFor="group-url">Copy this link to share the group:</label>
          <input id="group-url" readOnly value={link} onFocus={(e) => e.target.select()} autoFocus />
        </div>
      )}
      {narrow ? (
        <ol className="g-list" aria-label="Followed players">
          {shownRanked.map((r) => {
            const o = odds?.results[r.i], pend = pendingByPlayer.get(r.i), on = r.i === focusIdx;
            const upcoming = !pend && state.futureRounds > 0 && state.active[r.i];
            const open = () => onOpen(r.id);
            return (
              <li key={r.id} className={`g-row ${on ? "on" : ""}`} tabIndex={0} onClick={open} onKeyDown={onEnter(open)} aria-current={on || undefined}>
                <span className="g-rank mono">{r.tied ? `T${r.rank}` : r.rank}</span>
                <span className="g-main">
                  <span className="g-name"><span className="nm">{r.handle}</span></span>
                  <span className="g-sub">
                    <span className="mono">{rec(r.w, r.l, r.d)}</span>
                    {pend ? <span className={rewindTo ? "nextm" : "nextm live"}>{rewindTo ? `R${pend.round} · T${pend.table}` : `Now · T${pend.table}`}</span>
                      : upcoming ? <span className="nextm">Round {state.roundsPaired + 1}</span> : null}
                  </span>
                  {o?.cond.some(Boolean) && (
                    <span className="g-cond" title="Top-cut chance if they win / draw / lose their next match">
                      {["W", "D", "L"].map((lab, k) => <span key={k}><span className="c-k">{lab}</span> <b className="mono">{o.cond[k] ? pct(o.cond[k].top) : "—"}</b></span>)}
                      {day2 && <span className="g-d2-s"><span className="c-k">Day 2</span> <b className="mono">{o?.pDay2 != null ? pct(o.pDay2) : "…"}</b></span>}
                    </span>
                  )}
                </span>
                <span className="g-top">
                  <span className={pillClass(o?.pTop)}>{o ? pct(o.pTop) : "…"}</span>
                  <span className="c-toplabel">Top {cutN}</span>
                  {day2 && <span className="g-d2"><span className="c-k">Day 2</span> <b className="mono">{o?.pDay2 != null ? pct(o.pDay2) : "…"}</b></span>}
                </span>
                <StarButton on name={r.handle} onToggle={() => onStar(r.id)} />
              </li>
            );
          })}
          {shownOut.map((x) => (
            <li key={x.id} className="g-row out">
              <span className="g-rank mono">–</span>
              <span className="g-main"><span className="g-name"><span className="nm">{x.handle}</span></span><span className="g-sub">{outLabel(x)}</span></span>
              <span />
              <StarButton on name={x.handle} onToggle={() => onStar(x.id)} />
            </li>
          ))}
        </ol>
      ) : (
        <div className="tablebox">
          <table className={full ? "full" : "compact"}>
            <thead><StandingsHead cutN={cutN} full={full} day2={day2} actual={actual} hasStatus={hasStatus} /></thead>
            <tbody>
              {shownRanked.map((r) => (
                <StandingRow key={r.id} r={r} o={odds?.results[r.i]} pend={pendingByPlayer.get(r.i)} focused={r.i === focusIdx} member
                  state={state} cutN={cutN} day2={day2} full={full} actual={actual} hasStatus={hasStatus} rewindTo={rewindTo}
                  onOpen={onOpen} onStar={onStar} onLegend={onLegend} />
              ))}
              {shownOut.map((x) => (
                <tr key={x.id} className="no-click out-row">
                  <td className="star-col"><StarButton on name={x.handle} onToggle={() => onStar(x.id)} /></td>
                  <td className="num muted">–</td>
                  <td className="player-cell"><div className="who"><span className="nm muted">{x.handle}</span></div></td>
                  <td colSpan={cols - 3} className="muted small">{outLabel(x)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(folded || showAll) && ranked.length + out.length > LIMIT && (
        <button type="button" className="more-btn" aria-expanded={!folded} onClick={() => setShowAll((v) => !v)}>
          {folded ? `Show all ${members.length} players (${hidden} more)` : "Show fewer"}
        </button>
      )}
      <p className="muted small">{narrow ? "Tap" : "Click"} a player to see their full card{ranked.length ? " below" : ""}. ☆ takes them out of the group.</p>
    </section>
  );
}

/* Phones: pinned to the bottom once the follow card is scrolled away. Tap to go back to it. */
function FollowBar({ state, i, o, K, row, pending, rewound, extra = 0, onJump }) {
  const p = state.players[i];
  const next = pending ? (rewound ? `R${pending.round} · T${pending.table}` : `Now · T${pending.table}`)
    : state.futureRounds > 0 && state.active[i] ? `Round ${state.roundsPaired + 1}` : null;
  return (
    <button type="button" className="follow-bar" onClick={onJump} aria-label={`${p.handle}: top ${K} chance ${pct(o.pTop)}. Show the follow card`}>
      <span className="fb-main">
        <span className="fb-name">{p.handle}</span>
        <span className="fb-sub">
          {row && <span className="mono">{row.tied ? "T" : "#"}{row.rank} · {rec(row.w, row.l, row.d)}</span>}
          {next && <span className={pending && !rewound ? "nextm live" : "nextm"}>{next}</span>}
          {extra > 0 && <span className="fb-more">+{extra} more</span>}
        </span>
      </span>
      <span className="fb-top">
        <span className={pillClass(o.pTop)}>{pct(o.pTop)}</span>
        <span className="c-toplabel">Top {K}</span>
      </span>
      <span className="fb-up" aria-hidden="true" />
    </button>
  );
}

/* "What you need": every way the followed player's remaining matches can go.
   With Day 2 in play and the player still on Day 1, it covers the rest of Day 1 and the
   odds include playing Day 2. */
function NeedTable({ row, need, K, day2, name }) {
  if (!row) return null;
  const inDay1 = !!day2;
  const heading = `What ${name} needs · rest of ${inDay1 ? "Day 1" : "the event"}`;
  if (!need) return <div className="need"><div className="label">{heading}</div><p className="muted small">Working it out… (starts once the main odds finish)</p></div>;
  const L = need.left;
  const rows = need.rows.filter((x) => x.top != null)
    .map((x) => ({ ...x, pts: row.pts + 3 * x.w + x.d }))
    .sort((a, b) => b.pts - a.pts || b.w - a.w);
  const find = (f) => rows.find(f);
  const winOut = find((x) => x.w === L), loseOut = find((x) => x.l === L);
  const least = [...rows].filter((x) => x.top >= 0.9).sort((a, b) => a.pts - b.pts || a.d - b.d)[0];
  const tag = (x) => (x.w === L ? "Win out" : x.d === L ? "ID out" : x.l === L ? "Lose out" : "");
  const d2Reachable = !inDay1 || rows.some((x) => x.pts >= day2.threshold);
  let verdict;
  if (!d2Reachable) verdict = <>Day 2 ({day2.threshold} pts) is out of reach from here, so the top {K} is too.</>;
  else if (loseOut && loseOut.top >= 0.99) verdict = <>Top {K} even if they lose out.</>;
  else verdict = <>
    {winOut && <>Winning out: <span className={pillClass(winOut.top)}>{pct(winOut.top)}</span>. </>}
    {least ? <>The least for a 90%+ shot is <b className="mono">{rec(least.w, least.l, least.d)}</b>{inDay1 ? " for the rest of Day 1" : ""}.</>
      : inDay1 ? <>No Day 1 finish gets to 90% on its own; the rest depends on Day 2.</> : <>No result gets to 90%; it'll come down to tiebreakers.</>}
  </>;
  let d2txt = null;
  if (inDay1 && d2Reachable) {
    const reach = [...rows].filter((x) => x.pts >= day2.threshold).sort((a, b) => a.pts - b.pts || a.d - b.d)[0];
    d2txt = row.pts >= day2.threshold ? ` Day 2 is already locked in.`
      : reach ? ` Making Day 2 (${day2.threshold} pts) takes ${rec(reach.w, reach.l, reach.d)} or better.` : ` Day 2 is out of reach.`;
  }
  return (
    <div className="need">
      <div className="label">{heading}</div>
      <p>{verdict}{d2txt}{!need.done && <span className="muted small"> · still sharpening…</span>}</p>
      <div className="tablebox need-box">
        <table className="need-table">
          <thead><tr>
            <th>Rest of {inDay1 ? "Day 1" : "event"}</th><th>Record after</th><th className="num">{inDay1 ? "Pts after Day 1" : "Points"}</th>
            <th className="num">Top {K}</th>{inDay1 && <th className="num">Day 2</th>}
          </tr></thead>
          <tbody>
            {rows.map((x) => (
              <tr key={`${x.w}-${x.l}-${x.d}`}>
                <td className="mono">{rec(x.w, x.l, x.d)}{tag(x) && <span className="tag">{tag(x)}</span>}</td>
                <td className="mono">{rec(row.w + x.w, row.l + x.l, row.d + x.d)}</td>
                <td className="num">{x.pts}</td>
                <td className="num"><span className={pillClass(x.top)}>{pct(x.top)}</span></td>
                {inDay1 && <td className="num">{x.pts >= day2.threshold ? <span className="made">✓</span> : <span className="muted">—</span>}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RunStatus({ odds }) {
  if (!odds) return <div className="runstatus muted small">Calculating…</div>;
  if (odds.stale) return <div className="runstatus small" title="Numbers below are from the previous settings until this finishes."><span className="acc working">Recalculating…</span><span className="muted">showing previous numbers</span></div>;
  if (odds.combos) {
    return <div className="runstatus small"><span className="acc exact">Exact</span> All {odds.combos.toLocaleString()} ways the unfinished matches can end{odds.done ? "" : " · working…"}</div>;
  }
  const secs = Math.round(odds.elapsedMs / 1000);
  let note;
  if (!odds.done) note = `${odds.runs.toLocaleString()} of ${odds.target.toLocaleString()} runs · ${secs}s`;
  else if (odds.stoppedByTime) note = `${odds.runs.toLocaleString()} runs · hit the 30s limit`;
  else note = `${odds.runs.toLocaleString()} simulated finishes in ${secs || "<1"}s`;
  // After the main odds, extra runs sharpen the "If draw" column (draws are rare, so it gets fewer samples).
  const dr = odds.draw;
  const drawNote = dr && !dr.done ? "sharpening If draw…" : null;
  return (
    <div className="runstatus small">
      <span className={`acc ${odds.done ? "" : "working"}`} title="How far a player near 50% could be off by chance">Accurate to about {fmtMargin(odds.margin)}</span>
      <span className="muted" title={odds.stoppedByTime ? `Stopped at the 30-second limit (aimed for ${fmtMargin(odds.targetMargin)})` : undefined}>{note}{drawNote ? ` · ${drawNote}` : ""}</span>
    </div>
  );
}

// Big events: type part of a name to add that player (people already followed are left out).
function PlayerSearch({ players, exclude, onPick, placeholder, full }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (t.length < 2) return [];
    const out = [];
    for (let k = 0; k < players.length; k++) {
      const p = players[k];
      if (exclude?.has(k)) continue;
      if (p.handle.toLowerCase().includes(t) || (p.name || "").toLowerCase().includes(t)) out.push(p);
      if (out.length >= 8) break;
    }
    return out;
  }, [q, players, exclude]);
  return (
    <div className="psearch">
      <input id="me" type="search" autoComplete="off" enterKeyHint="search" disabled={full}
        placeholder={placeholder}
        value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && matches.length > 0 && (
        <ul className="psearch-list" role="listbox">
          {matches.map((p) => (
            <li key={p.id}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { onPick(p.id); setQ(""); setOpen(false); }}>
                <b>{p.handle}</b>{p.name && p.name !== p.handle && <span className="muted small"> {p.name}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && q.trim().length >= 2 && matches.length === 0 && <div className="psearch-list muted small" style={{ padding: "8px 10px" }}>No player matches "{q}"</div>}
    </div>
  );
}

function Pager({ page, pages, total, size = PAGE, narrow, onPage, onMine }) {
  if (total === 0) return <p className="muted small">No players match.</p>;
  const from = (page - 1) * size + 1, to = Math.min(total, page * size);
  // page numbers to show: first, last, and a window around the current page (narrower on phones)
  const w = narrow ? 1 : 2;
  const nums = new Set([1, pages, page - w, page, page + w, page - 1, page + 1].filter((n) => n >= 1 && n <= pages));
  const list = [...nums].sort((a, b) => a - b);
  const items = [];
  list.forEach((n, k) => {
    if (k > 0 && n - list[k - 1] > 1) items.push(<span key={`gap${n}`} className="pg-gap">…</span>);
    items.push(
      <button key={n} type="button" className={`pg-num ${n === page ? "on" : ""}`} aria-current={n === page ? "page" : undefined} onClick={() => onPage(n)}>{n}</button>
    );
  });
  return (
    <nav className="pager" aria-label="Standings pages">
      <span className="muted small pg-range">{from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}</span>
      {pages > 1 && (
        <div className="pg-buttons">
          {!narrow && <button type="button" className="pg-arrow" onClick={() => onPage(1)} disabled={page === 1} aria-label="First page">«</button>}
          <button type="button" className="pg-arrow" onClick={() => onPage(page - 1)} disabled={page === 1} aria-label="Previous page">‹</button>
          {items}
          <button type="button" className="pg-arrow" onClick={() => onPage(page + 1)} disabled={page === pages} aria-label="Next page">›</button>
          {!narrow && <button type="button" className="pg-arrow" onClick={() => onPage(pages)} disabled={page === pages} aria-label="Last page">»</button>}
        </div>
      )}
      {onMine && pages > 1 && <button type="button" className="link small" onClick={onMine}>Go to followed player</button>}
    </nav>
  );
}

/* ---------- Top cut: single elimination ---------- */
function roundName(k, total) {
  const left = total - k + 1; // matches left including this one
  if (left === 1) return "Final";
  if (left === 2) return "Semifinals";
  if (left === 3) return "Quarterfinals";
  return `Top ${2 ** left}`;
}

function TopCutView({ cut, seeds, members = [], focusId, handleOf, onOpen, onStar, narrow, day2Event, groupName, link, eventName, onClear }) {
  const total = cut.plannedRounds || cut.rounds.length;
  const paired = cut.rounds.filter((r) => r.hasPairings && r.matches.length);
  const [msg, share] = useShare(link);
  const inGroup = new Set(members);
  const cls = (id) => (String(id) === String(focusId) ? "mine" : inGroup.has(String(id)) ? "grp" : "");

  // Everyone in the cut and how far they've got (keyed by id as text, like the group)
  const people = new Map();
  const swissById = new Map([...(seeds || new Map())].map(([k, v]) => [String(k), v]));
  const touch = (p) => {
    const key = String(p.id);
    if (!people.has(key)) {
      const sw = swissById.get(key);
      people.set(key, { ...p, legend: p.legend || sw?.legend || null, seed: sw?.rank ?? null, swiss: sw, wins: 0, out: null, playing: false });
    }
    return people.get(key);
  };
  paired.forEach((r, k) => {
    for (const m of r.matches) {
      const ps = m.players.map(touch);
      const done = m.status === "COMPLETE" || m.winner != null;
      if (ps.length === 1 && !m.isBye && m.isDoubleLoss) { ps[0].out = roundName(k + 1, total); continue; } // no-show loss
      if (m.isBye || ps.length === 1) { ps[0].wins++; continue; }
      if (!done) { ps.forEach((p) => (p.playing = true)); continue; }
      for (const p of ps) {
        if (p.id === m.winner) p.wins++;
        else p.out = roundName(k + 1, total);
      }
    }
  });
  const list = [...people.values()].sort((a, b) => (a.seed ?? 1e9) - (b.seed ?? 1e9));
  // With every match a coin flip, each match still to play halves a player's chance.
  const chanceToReach = (p, k) => (p.out ? (p.wins >= k - 1 ? 1 : 0) : p.wins >= k - 1 ? 1 : 0.5 ** (k - 1 - p.wins));
  const champion = list.find((p) => p.wins >= total);
  const winChance = (p) => (p.out ? 0 : p.wins >= total ? 1 : 0.5 ** (total - p.wins));

  // The followed group's story in the top cut: still in, out in which round, or where they finished Swiss.
  const groupRows = members.map((id) => {
    const p = people.get(id);
    if (p) {
      const next = roundName(Math.min(total, p.wins + 1), total);
      const status = p.wins >= total ? "Champion" : p.out ? `Out · ${p.out}` : p.playing ? `Playing now · ${next}` : `Still in · next: ${next}`;
      return { id, handle: p.handle, seed: p.seed, inCut: true, p, status, sort: p.seed ?? 900 };
    }
    const sw = swissById.get(id);
    if (sw) return { id, handle: sw.handle, inCut: false, status: `Missed the top ${cut.size || "cut"} · Swiss #${sw.rank} (${rec(sw.w, sw.l, sw.d)})`, sort: 1000 + sw.rank };
    return { id, handle: handleOf(id), inCut: false, status: day2Event ? "Out after Day 1" : "Didn't make the top cut", sort: 1e6 };
  }).sort((a, b) => a.sort - b.sort);
  const groupTitle = members.length > 1 ? groupName || "Your group" : groupRows[0]?.handle;

  return (
    <section className="stack">
      {members.length > 0 && (
        <section className="panel group">
          <div className="group-head">
            <div className="gh-title">
              <span className="label">Following{members.length > 1 ? ` · ${members.length} players` : ""}</span>
              <h2 className="sec">{groupTitle}</h2>
            </div>
            <div className="gh-actions">
              <button type="button" className="share-btn" onClick={() => share(link, `${groupTitle} · ${eventName || "Riftbound event"}`)}>
                {SHARE_ICON}{msg === "copied" ? "Link copied" : members.length > 1 ? "Share group" : "Share"}
              </button>
              <button type="button" className="link small" onClick={onClear}>{members.length > 1 ? "Clear" : "Stop following"}</button>
              <span className="sr-only" aria-live="polite">{msg === "copied" ? "Link copied" : ""}</span>
            </div>
          </div>
          {msg === "manual" && (
            <div className="share-manual">
              <label className="small muted" htmlFor="cut-group-url">Copy this link to share:</label>
              <input id="cut-group-url" readOnly value={link} onFocus={(e) => e.target.select()} autoFocus />
            </div>
          )}
          <ol className="g-list" aria-label="Followed players in the top cut">
            {groupRows.map((g) => {
              const w = g.inCut ? winChance(g.p) : null;
              return (
                <li key={g.id} className={`g-row ${g.inCut ? "" : "out"} ${g.inCut && g.p.out ? "out" : ""}`}>
                  <span className="g-rank mono" title={g.inCut ? "Seed" : undefined}>{g.inCut ? g.seed ?? "–" : "–"}</span>
                  <span className="g-main">
                    <span className="g-name"><span className="nm">{g.handle}</span></span>
                    <span className="g-sub">
                      <span className={g.inCut && g.p.playing ? "nextm live" : g.status === "Champion" ? "made" : ""}>{g.status}</span>
                    </span>
                  </span>
                  <span className="g-top">
                    {w != null && !g.p.out && <>{w === 1 ? <span className="pill p-lock">Won</span> : <span className={pillClass(w)}>{pct(w)}</span>}<span className="c-toplabel">{w === 1 ? "Champion" : "Win it all"}</span></>}
                  </span>
                  <StarButton on name={g.handle} onToggle={() => onStar(g.id)} />
                </li>
              );
            })}
          </ol>
        </section>
      )}
      <div className="section-head">
        <h2 className="sec">Top {cut.size || list.length} · single elimination</h2>
        <span className="muted small">Lose once and you're out. Seeds come from the final Swiss standings.</span>
      </div>

      <div className="bracket">
        {Array.from({ length: total }, (_, i) => {
          const r = paired[i];
          return (
            <div className="b-col" key={i}>
              <div className="label">{roundName(i + 1, total)}</div>
              <div className="b-round">
              {!r && <div className="b-match muted small">Not paired yet</div>}
              {r && [...r.matches].sort((a, b) => (a.table ?? 0) - (b.table ?? 0)).map((m) => {
                const done = m.status === "COMPLETE" || m.winner != null;
                return (
                  <div className={`b-match ${done ? "" : "live"}`} key={m.id}>
                    {m.players.map((p) => {
                      const pp = people.get(String(p.id));
                      const won = done && m.winner === p.id;
                      const games = !done || m.isBye ? "" : won ? m.gamesWinner ?? "" : m.gamesLoser ?? "";
                      return (
                        <button type="button" key={p.id} className={`b-player ${won ? "won" : done ? "lost" : ""} ${String(p.id) === String(focusId) ? "me" : inGroup.has(String(p.id)) ? "grp" : ""}`} onClick={() => onOpen(p.id)}>
                          <span className="b-seed">{pp?.seed ?? "–"}</span>
                          <span className="b-name">{p.handle}{pp?.legend && <span className="muted small"> · {legendShort(pp.legend)}</span>}</span>
                          <span className="b-games">{games}</span>
                        </button>
                      );
                    })}
                    {m.isBye && <div className="b-player bye"><span className="b-seed" /><span className="b-name muted">Bye</span></div>}
                    {!done && !m.isBye && <div className="b-status">Playing</div>}
                  </div>
                );
              })}
              </div>
            </div>
          );
        })}
      </div>

      {narrow ? (
        <ol className="cards" aria-label="Top cut players">
          {list.map((p) => {
            const win = winChance(p);
            const pick = () => onOpen(p.id);
            return (
              <li key={p.id} className={`card ${cls(p.id)} ${p.out ? "out" : ""}`} tabIndex={0} onClick={pick} onKeyDown={onEnter(pick)}>
                <div className="c-rank">
                  <span className="mono">{p.seed ?? "–"}</span>
                  <StarButton on={inGroup.has(String(p.id))} name={p.handle} onToggle={() => onStar(p.id)} />
                </div>
                <div className="c-main">
                  <div className="c-name"><span className="nm">{p.handle}</span></div>
                  {((p.name && p.name !== p.handle) || p.legend) && (
                    <div className="sub">
                      {p.name && p.name !== p.handle && <span className="muted small c-real">{p.name}</span>}
                      {p.legend && <span className="legend-chip static">{legendShort(p.legend)}</span>}
                    </div>
                  )}
                  <div className="c-meta">
                    <span><span className="c-k">Swiss</span> <span className="mono">{p.swiss ? rec(p.swiss.w, p.swiss.l, p.swiss.d) : "—"}</span></span>
                    {p.out ? <span className="status st-out">Out · {p.out}</span>
                      : p.playing ? <span className="tag live">Playing now</span>
                      : p.wins < total && <span className="status st-in">Still in</span>}
                  </div>
                </div>
                {!p.out && (
                  <div className="c-top">
                    {win === 1 ? <span className="pill p-lock">Won</span> : <span className={pillClass(win)}>{pct(win)}</span>}
                    <span className="c-toplabel">{win === 1 ? "Champion" : "Win it all"}</span>
                  </div>
                )}
                {total > 1 && !p.out && win < 1 && (
                  <div className="c-strip" style={{ gridTemplateColumns: `repeat(${total - 1}, minmax(0,1fr))` }}>
                    {Array.from({ length: total - 1 }, (_, i) => {
                      const c = chanceToReach(p, i + 2);
                      return (
                        <div className="c-cell" key={i}>
                          <span className="c-k">Reach {roundName(i + 2, total).replace("finals", "")}</span>
                          {p.wins >= i + 1 ? <span className="made">✓</span> : p.out ? <span className="muted">—</span> : <b className="mono">{pct(c)}</b>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
      <div className="tablebox">
        <table className="compact">
          <thead>
            <tr>
              <th className="star-col"><span className="sr-only">Follow</span></th><th className="num">Seed</th><th>Player</th><th>Swiss record</th>
              {Array.from({ length: total - 1 }, (_, i) => <th className="num" key={i}>Reach {roundName(i + 2, total).replace("finals", "")}</th>)}
              <th className="num">Win it all</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => {
              const win = winChance(p);
              return (
                <tr key={p.id} className={cls(p.id)} onClick={() => onOpen(p.id)}>
                  <td className="star-col"><StarButton on={inGroup.has(String(p.id))} name={p.handle} onToggle={() => onStar(p.id)} /></td>
                  <td className="num">{p.seed ?? "–"}</td>
                  <td className="player-cell">
                    <div className="who"><span className="nm" title={p.handle}>{p.handle}</span>{p.playing && <span className="tag live">Playing</span>}</div>
                    {((p.name && p.name !== p.handle) || p.legend) && (
                      <div className="sub">
                        {p.name && p.name !== p.handle && <span className="muted small">{p.name}</span>}
                        {p.legend && <span className="legend-chip static">{legendShort(p.legend)}</span>}
                      </div>
                    )}
                  </td>
                  <td className="mono">{p.swiss ? rec(p.swiss.w, p.swiss.l, p.swiss.d) : "—"}</td>
                  {Array.from({ length: total - 1 }, (_, i) => {
                    if (p.wins >= i + 1) return <td className="num" key={i}><span className="made" title="Already there">✓</span></td>;
                    const c = chanceToReach(p, i + 2);
                    return <td className="num" key={i}>{p.out ? <span className="muted">—</span> : <span className={pillClass(c)}>{pct(c)}</span>}</td>;
                  })}
                  <td className="num">{win === 1 ? <span className="made">✓</span> : p.out ? <span className="muted">—</span> : <span className={pillClass(win)}>{pct(win)}</span>}</td>
                  <td>
                    {p.wins >= total ? <span className="status st-in">Champion</span>
                      : p.out ? <span className="status st-out">Out · {p.out}</span>
                      : <span className="status st-in">Still in</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
      <p className="muted small">
        {champion ? `${champion.handle} won the event. ` : ""}
        Every unplayed match is treated as a coin flip, so a player still in with two matches to go has a 25% chance to win it all.
      </p>
    </section>
  );
}
