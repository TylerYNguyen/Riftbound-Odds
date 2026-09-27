// Vercel serverless function: GET /api/round?id=<roundId>[&live=1]
// One round's matches. A finished round never changes, so Vercel's CDN keeps it (see DONE_CACHE)
// and serves it to every visitor without asking the locator again. A round still being played is
// only held for 20 seconds. The page adds live=1 for the event's newest round, which is always
// kept short: players' dropped / eliminated status comes with their newest match and can still change.
import { loadRound, parseRoundId } from "../server/loadEvent.js";
import { DONE_CACHE, LIVE_CACHE, badInput, sendError } from "../server/respond.js";

export default async function handler(req, res) {
  const id = parseRoundId(req.query?.id);
  if (!id) return badInput(res, "That round couldn't be found. Reload the event and try again.");
  try {
    const data = await loadRound(id);
    const live = req.query?.live === "1";
    res.setHeader("Cache-Control", data.done && !live ? DONE_CACHE : LIVE_CACHE);
    res.status(200).json(data);
  } catch (err) {
    sendError(res, err, "round", id);
  }
}
