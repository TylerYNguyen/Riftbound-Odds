// Vercel serverless function: GET /api/event?id=512931
// The browser can't read the locator feed directly, so this runs on Vercel and returns the
// event with its round list (no matches). The page then loads each round from /api/round.
import { loadEventInfo, parseEventId } from "../server/loadEvent.js";
import { EVENT_CACHE, badInput, sendError } from "../server/respond.js";

export default async function handler(req, res) {
  const id = parseEventId(req.query?.id);
  if (!id) return badInput(res, "Paste a Riftbound locator event link or its number, e.g. 512931.");
  try {
    const data = await loadEventInfo(id);
    res.setHeader("Cache-Control", EVENT_CACHE);
    res.status(200).json(data);
  } catch (err) {
    sendError(res, err, "event", id);
  }
}
