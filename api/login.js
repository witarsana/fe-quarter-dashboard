import { passwordOk, sessionCookie } from "./_lib.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  try {
    if (!passwordOk(String(body.password || ""))) {
      await new Promise((s) => setTimeout(s, 1000)); // slow down guessing
      return res.status(401).json({ error: "Password salah" });
    }
    res.setHeader("Set-Cookie", sessionCookie());
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
