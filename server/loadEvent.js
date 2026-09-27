// Reads the Riftbound event locator's public data feed and returns a small, normalized shape
// the front end can work with. Used by the Vercel functions (api/event.js, api/round.js) and by
// the Vite dev server.
//
// The page loads an event in two steps, so finished rounds can be cached:
//   loadEventInfo(eventId): the event, its phases and its round list (no matches), one request.
//   loadRound(roundId): one round's matches, plus `done` (every match has a result). A finished
//     round never changes, so the CDN can keep it and serve it to everyone.

const BASE = "https://api.cloudflare.riftbound.uvsgames.com/hydraproxy/api/v2";

export class FeedError extends Error {
  // code: a short tag the page can use (NOT_FOUND, BUSY, DOWN, TIMEOUT, FEED_CHANGED)
  constructor(status, message, code = "FEED_ERROR", detail = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail; // for the server log only
  }
}

const FEED_CHANGED = "The Riftbound event locator changed how it shares event data, so this site can't read it right now. The odds are paused until the site is updated.";
const changed = (what) => new FeedError(502, FEED_CHANGED, "FEED_CHANGED", what);
const REQUEST_TIMEOUT_MS = 15000; // per request to the locator
// Pages of one round fetched at the same time. The page also fetches at most 2 rounds at once
// (src/lib/fetchEvent.js), so one visitor never has more than ~8 requests open at the locator.
export const PAGE_CONCURRENCY = 4;

async function getJSON(url, { notFound = "No event with that ID on the Riftbound locator." } = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "riftbound-odds (github.com/TylerYNguyen)",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new FeedError(504, "The Riftbound locator is taking too long to answer. Try again in a minute.", "TIMEOUT");
    }
    throw new FeedError(502, "Couldn't reach the Riftbound locator. It may be down; try again in a minute.", "DOWN");
  }
  if (res.status === 404) throw new FeedError(404, notFound, "NOT_FOUND");
  if (res.status === 429) throw new FeedError(503, "The Riftbound locator is limiting requests right now. Try again in a minute.", "BUSY");
  if (res.status >= 500) throw new FeedError(502, `The Riftbound locator is having trouble right now (status ${res.status}). Try again in a minute.`, "DOWN");
  if (!res.ok) throw new FeedError(502, `The Riftbound locator refused the request (status ${res.status}). Try again in a minute.`, "DOWN");
  try {
    return await res.json();
  } catch {
    // A web page or garbage instead of data: usually an outage page, sometimes a changed feed.
    throw new FeedError(502, "The Riftbound locator sent back something this site can't read. It may be down; try again in a minute.", "DOWN");
  }
}

// The feed is paginated. Read page 1 to learn how many pages there are,
// then fetch the rest a few at a time (big events have 10+ pages per round).
async function getAllPages(path) {
  const size = 100;
  const first = await getJSON(`${BASE}${path}?page=1&page_size=${size}`);
  if (!first || !Array.isArray(first.results)) throw changed("match page without results");
  const out = [...first.results];
  const perPage = first.page_size || size;
  const pages = Math.min(100, Math.ceil((first.count ?? out.length) / perPage)); // 100 pages = 10,000 matches in a round
  const rest = [];
  for (let p = 2; p <= pages; p++) rest.push(p);
  for (let i = 0; i < rest.length; i += PAGE_CONCURRENCY) {
    const batch = await Promise.all(
      rest.slice(i, i + PAGE_CONCURRENCY).map((p) => getJSON(`${BASE}${path}?page=${p}&page_size=${size}`))
    );
    for (const j of batch) {
      if (!j || !Array.isArray(j.results)) throw changed("match page without results");
      out.push(...j.results);
    }
  }
  return out;
}

// The feed is public but undocumented. If its match format changes, stop with a clear
// message instead of quietly computing odds from bad data.
function checkMatches(raw) {
  let bad = 0;
  for (const m of raw) {
    const rels = m?.player_match_relationships;
    if (!Array.isArray(rels) || rels.length === 0 || rels.some((r) => r?.player?.id == null)) bad++;
  }
  if (raw.length && bad > Math.max(2, raw.length * 0.02)) throw changed(`${bad} of ${raw.length} matches unreadable`);
}

/** Accepts "512931" or any locator URL like https://locator.riftbound.uvsgames.com/events/512931 */
export function parseEventId(input) {
  const s = String(input || "").trim();
  const m = s.match(/events\/(\d+)/) || s.match(/^(\d+)$/);
  return m ? m[1] : null;
}

/** A round id as the feed gives it (digits today; letters, digits and dashes allowed). Anything else is refused,
 *  so a request can't reach other paths on the locator. */
export function parseRoundId(input) {
  const s = String(input ?? "").trim();
  return /^[A-Za-z0-9-]{1,64}$/.test(s) ? s : null;
}

function normalizeMatch(m) {
  const rels = [...(m.player_match_relationships || [])].sort(
    (a, b) => (a.player_order ?? 0) - (b.player_order ?? 0)
  );
  return {
    id: m.id,
    table: m.table_number,
    status: m.status,
    isBye: !!m.match_is_bye,
    isDraw: !!(m.match_is_intentional_draw || m.match_is_unintentional_draw),
    isIntentionalDraw: !!m.match_is_intentional_draw,
    isDoubleLoss: !!m.match_is_loss && m.winning_player == null,
    winner: m.winning_player ?? null,
    gamesWinner: m.games_won_by_winner ?? null,
    gamesLoser: m.games_won_by_loser ?? null,
    gamesDrawn: m.games_drawn ?? null,
    players: rels.map((r) => ({
      id: r.player?.id,
      name: r.player?.best_identifier || "",
      handle: r.user_event_status?.best_identifier || r.player?.best_identifier || "",
      // The legend they registered, e.g. "Master Yi, Wuju Bladesman" (null if not entered)
      legend: r.user_event_status?.deck_defining_card?.name || null,
      // Their status right now: COMPLETE (still in), ELIMINATED, DROPPED, ...
      status: r.user_event_status?.registration_status || null,
    })),
  };
}

// A match is settled once it has a result (same rule the odds engine uses), or has one player (bye / no-show loss).
function isSettled(m) {
  if ((m?.player_match_relationships || []).length < 2) return true;
  return m.status === "COMPLETE" || m.winning_player != null || !!m.match_is_intentional_draw
    || !!m.match_is_unintentional_draw || !!m.match_is_loss;
}

const roundInfo = (r) => ({
  id: r.id,
  number: r.round_number,
  status: r.status,
  hasPairings: r.pairings_status === "GENERATED",
});

/** The event, its Swiss phases (as one continuous Swiss) and top cut, with every round listed but no matches.
 *  The page then loads each paired round with loadRound(). */
export async function loadEventInfo(eventId) {
  const ev = await getJSON(`${BASE}/events/${eventId}/`);
  if (!ev || typeof ev !== "object" || !Array.isArray(ev.tournament_phases)) throw changed("event without phases");
  const phases = [...ev.tournament_phases].sort(
    (a, b) => (a.order_in_phases ?? 0) - (b.order_in_phases ?? 0)
  );
  // Big events run Swiss over more than one phase (Day 1 rounds 1–8, Day 2 rounds 9–13).
  // Treat all Swiss phases as one continuous Swiss.
  const swissPhases = phases.filter((p) => p.round_type === "SWISS");
  if (!swissPhases.length && phases[0]) swissPhases.push(phases[0]);
  const swiss = swissPhases[0] || null;
  const lastSwiss = swissPhases[swissPhases.length - 1] || null;
  const afterSwiss = lastSwiss ? phases.filter((p) => (p.order_in_phases ?? 0) > (lastSwiss.order_in_phases ?? 0)) : [];

  const rounds = swissPhases
    .flatMap((p, phase) => (p.rounds || []).map((r) => ({ ...r, phase })))
    .sort((a, b) => a.round_number - b.round_number)
    .map((r) => ({
      ...roundInfo(r),
      phase: r.phase, // 0 = first Swiss phase (Day 1), 1 = second (Day 2), ...
      isFinal: !!r.final_round_in_event,
    }));

  // Top cut (single elimination after Swiss)
  const cutPhase = afterSwiss.find((p) => /ELIM/i.test(p.round_type || "")) || null;
  let cut = null;
  if (cutPhase) {
    const cutRounds = [...(cutPhase.rounds || [])].sort((a, b) => a.round_number - b.round_number).map(roundInfo);
    cut = {
      name: cutPhase.phase_name,
      type: cutPhase.round_type,
      status: cutPhase.status,
      size: cutPhase.rank_required_to_enter_phase ?? null,
      plannedRounds: cutPhase.number_of_rounds ?? cutRounds.length,
      rounds: cutRounds,
    };
  }

  return {
    id: ev.id,
    name: ev.name,
    start: ev.start_datetime,
    timezone: ev.timezone || ev.store?.timezone || null,
    store: ev.store?.name || null,
    lifecycle: ev.event_lifecycle_status || null,
    playerCount: ev.starting_player_count ?? ev.registered_user_count ?? null,
    swiss: swiss
      ? {
          name: swiss.phase_name,
          status: swissPhases.every((p) => p.status === "COMPLETE") ? "COMPLETE" : lastSwiss.status,
          plannedRounds: swissPhases.reduce((n, p) => n + (p.number_of_rounds || 0), 0) || null,
          phases: swissPhases.map((p) => {
            const nums = (p.rounds || []).map((r) => r.round_number);
            return { name: p.phase_name, rounds: p.number_of_rounds, status: p.status, first: nums.length ? Math.min(...nums) : null };
          }),
        }
      : null,
    // Size of the cut after Swiss, e.g. 8 for a top-8 single elimination
    topCut: afterSwiss.find((p) => p.rank_required_to_enter_phase)?.rank_required_to_enter_phase ?? null,
    cut,
    laterPhases: afterSwiss.map((p) => ({ name: p.phase_name, type: p.round_type, status: p.status })),
    rounds,
    fetchedAt: new Date().toISOString(),
  };
}

/** One round's matches. `done` = every match has a result, so the round won't change any more. */
export async function loadRound(roundId) {
  const raw = await getAllPages(`/tournament-rounds/${roundId}/matches/paginated/`);
  checkMatches(raw);
  const kept = raw.filter((m) => m?.player_match_relationships?.length);
  return {
    id: roundId,
    done: kept.length > 0 && kept.every(isSettled),
    matches: kept.map(normalizeMatch),
  };
}

/** The whole event in one go (info + every paired round), in the shape the page works with.
 *  The site itself loads rounds separately (src/lib/fetchEvent.js); this is for scripts and tests. */
export async function loadEvent(eventId) {
  const info = await loadEventInfo(eventId);
  const fill = async (r) => ({ ...r, matches: r.hasPairings ? (await loadRound(r.id)).matches : [] });
  const rounds = [];
  for (const r of info.rounds) rounds.push(await fill(r));
  const cut = info.cut ? { ...info.cut, rounds: [] } : null;
  if (cut) for (const r of info.cut.rounds) cut.rounds.push(await fill(r));
  return { ...info, rounds, cut };
}
