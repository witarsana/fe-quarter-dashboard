import { authed, buildReport, FIRST_QUARTER, quarterOf } from "./_lib.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!authed(req)) return res.status(401).json({ error: "login required" });
  let period;
  if (req.query.from || req.query.to) {
    const from = String(req.query.from || ""), to = String(req.query.to || "");
    if (!UUID.test(from) || !UUID.test(to)) return res.status(400).json({ error: "from/to must be sprint ids" });
    period = { from, to };
  } else {
    const now = quarterOf(new Date().toISOString());
    const q = String(req.query.q || (now < FIRST_QUARTER ? FIRST_QUARTER : now)).toUpperCase();
    if (!/^\d{4}-Q[1-4]$/.test(q)) return res.status(400).json({ error: "q must look like 2026-Q4" });
    period = { q };
  }
  try {
    return res.status(200).json(await buildReport(period, { refresh: req.query.refresh === "1" }));
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
