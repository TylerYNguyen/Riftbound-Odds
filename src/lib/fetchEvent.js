// Loads an event from this site's server: first the event and its round list (/api/event),
// then each paired round (/api/round), at most 2 rounds at a time. Finished rounds are kept in
// memory for an hour, so a refresh only downloads the round being played (and anything new).
// Every way it can fail becomes a plain message.

const FEED_CHANGED = "The Riftbound event locator changed how it shares event data, so this site can't read it right now. The odds are paused until the site is updated.";
const ROUND_CONCURRENCY = 2; // rounds requested at once (each fetches up to 4 locator pages; see server/loadEvent.js)
const KEEP_MS = 60 * 60 * 1000; // how long a finished round is reused before it's downloaded again
const roundCache = new Map(); // round id → { matches, at }

async function getJSON(url, signal) {
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if (signal?.aborted) throw e; // replaced by a newer load: not an error to show
    throw new Error(typeof navigator !== "undefined" && navigator.onLine === false
      ? "You're offline. Check your connection and try again."
      : "Couldn't reach this site's server. Check your connection and try again.");
  }
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON: handled below */ }
  if (!res.ok) {
    if (json?.error) throw new Error(json.error);
    if (res.status === 504) throw new Error("Loading this event took too long. Big events can take a while; try again in a minute.");
    if (res.status === 429) throw new Error("Too many requests right now. Wait a minute, then try again.");
    throw new Error(`The server had a problem loading this event (status ${res.status}). Try again in a minute.`);
  }
  if (!json) {
    // A web page instead of data: this site's server didn't recognize the address (e.g. a local dev
    // server still running an older setup), or something in between answered instead.
    if (/html/i.test(res.headers.get("content-type") || "") || /^\s*</.test(text)) {
      throw new Error("This site's server answered with a web page instead of event data. Reload the page and try again."
        + (import.meta.env?.DEV ? " (Running it on your computer? Stop npm run dev with Ctrl+C and start it again.)" : ""));
    }
    throw new Error("The server sent back something unreadable. Try again in a minute.");
  }
  return json;
}

function stopIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("This load was replaced by a newer one.", "AbortError");
}

// Runs `task` over `items`, `limit` at a time; stops starting new ones after the first failure
// or once `signal` is aborted.
async function runLimited(items, limit, task, signal) {
  let next = 0, failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      stopIfAborted(signal);
      const item = items[next++];
      try { await task(item); } catch (e) { failed = true; throw e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const okMatches = (list) => Array.isArray(list) && list.every((m) => m && Array.isArray(m.players) && m.players.every((p) => p && p.id != null));

/** onProgress({ done, total }): rounds downloaded so far, out of the rounds that need downloading.
 *  signal: an AbortSignal; aborting stops the load (it then rejects with an AbortError). */
export async function fetchEvent(id, { onProgress, signal } = {}) {
  const info = await getJSON(`/api/event?id=${encodeURIComponent(id)}`, signal);
  const okRound = (r) => r && r.id != null && r.number != null;
  if (!info || !Array.isArray(info.rounds) || !info.rounds.every(okRound)
    || (info.cut && !(Array.isArray(info.cut.rounds) && info.cut.rounds.every(okRound)))) throw new Error(FEED_CHANGED);

  const paired = [...info.rounds, ...(info.cut?.rounds || [])].filter((r) => r.hasPairings);
  // The newest paired round is always downloaded fresh (it may still be in play, and players'
  // status comes with their newest match).
  let newest = null;
  for (const r of paired) if (!newest || r.number > newest.number) newest = r;
  const now = Date.now();
  const have = new Map(); // round id → matches, for this load
  const need = [];
  for (const r of paired) {
    const key = String(r.id), kept = roundCache.get(key);
    if (r !== newest && kept && now - kept.at < KEEP_MS) have.set(key, kept.matches);
    else need.push(r);
  }

  let done = 0;
  onProgress?.({ done, total: need.length });
  await runLimited(need, ROUND_CONCURRENCY, async (r) => {
    const live = r === newest;
    const j = await getJSON(`/api/round?id=${encodeURIComponent(r.id)}${live ? "&live=1" : ""}`, signal);
    if (!j || !okMatches(j.matches)) throw new Error(FEED_CHANGED);
    const key = String(r.id);
    have.set(key, j.matches);
    if (j.done && !live) roundCache.set(key, { matches: j.matches, at: Date.now() });
    else roundCache.delete(key);
    onProgress?.({ done: ++done, total: need.length });
  }, signal);
  stopIfAborted(signal);

  const fill = (r) => ({ ...r, matches: r.hasPairings ? have.get(String(r.id)) : [] });
  return {
    ...info,
    rounds: info.rounds.map(fill),
    cut: info.cut ? { ...info.cut, rounds: info.cut.rounds.map(fill) } : info.cut,
  };
}
