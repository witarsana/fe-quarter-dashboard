import { authed, FIRST_QUARTER, quarterOf } from "./_lib.js";
import { buildKpi } from "./_kpi.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!authed(req)) return res.status(401).json({ error: "login required" });
  const now = quarterOf(new Date().toISOString());
  const q = String(req.query.q || (now < FIRST_QUARTER ? FIRST_QUARTER : now)).toUpperCase();
  if (!/^\d{4}-Q[1-4]$/.test(q)) return res.status(400).json({ error: "q must look like 2026-Q4" });
  try {
    return res.status(200).json(await buildKpi(q, { refresh: req.query.refresh === "1" }));
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
