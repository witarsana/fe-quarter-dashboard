import { clearCookie } from "./_lib.js";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Set-Cookie", clearCookie());
  res.status(200).json({ ok: true });
}
