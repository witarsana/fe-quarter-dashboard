// Shared logic for the FE quarterly completion dashboard. Server-side only.
// Rules mirror hermes-fe skill fe-quarter-report/scripts/quarter_report.py (agreed with Koyo 2026-11-02).
import crypto from "node:crypto";

export const TICKETS_DB = "32e29af7-d7dd-4df6-9310-270de8830d1a";
export const SPRINTS_DB = "e24adcac-28d6-4eae-9ce5-9794034dec75"; // database id (data source: d44f00ea-…)
const NOTION_VERSION = "2022-06-28";
const SPRINT_DATE_PROP = "Project Release Date"; // the sprint's start..end date range
export const FIRST_QUARTER = "2026-Q4";
// Pipeline stage per status — keep in sync with hermes-fe quarter_report.py STAGES.
export const STAGES = [
  { n: 1, name: "Belum mulai", statuses: ["Not started", "Agent queued", "Need review QA", "Need review Product", "On Hold"] },
  { n: 2, name: "Dikerjakan", statuses: ["In progress", "Blocked", "Failed test dev", "Failed test Project", "Failed test Production"] },
  { n: 3, name: "Code review", statuses: ["Code review"] },
  { n: 4, name: "QA dev", statuses: ["Ready testing dev", "In testing dev"] },
  { n: 5, name: "Lolos QA dev", statuses: ["Ready for project", "Ready testing project", "In testing project"] },
  { n: 6, name: "Menuju rilis", statuses: ["Ready testing prod", "In testing prod", "Ready for release with notes", "Ready for release"] },
  { n: 7, name: "Deployed", statuses: ["Deployed"] },
];
const STAGE_OF = new Map(STAGES.flatMap((s) => s.statuses.map((st) => [st, s.n])));
// Closed without delivery — never counted under any criterion.
export const NEVER = ["Archived", "Not bug", "Can't reproduce bug", "Need Research", "Intermittent bug"];
export const CRITERIA = [
  { key: "assigned", min: 1, label: "Semua yang di-assign (termasuk Not started)" },
  { key: "progress", min: 2, label: "Mulai dikerjakan ke atas" },
  { key: "review", min: 3, label: "Code review ke atas" },
  { key: "qa", min: 5, label: "Lolos QA dev ke atas" },
  { key: "deployed", min: 7, label: "Deployed saja" },
];
export const DEFAULT_CRITERIA = "qa";
// Notion user id -> member. Order = fixed color slot order in the UI.
export const TEAM = [
  { id: "346199eb-6b5d-4a25-bcc8-4d2ce2406dab", name: "Koyo", full: "Made Witarsana" },
  { id: "5033a0de-a77c-45c9-8be1-d36a89a1775e", name: "Dendy", full: "Dendy Anggaditya" },
  { id: "b734e51f-9d2b-46e9-91ae-5b08a42462c1", name: "Galang", full: "Galang Kerta" },
];

async function notion(method, path, body) {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN not configured");
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch("https://api.notion.com/v1" + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 1000 * (attempt + 1))); continue; }
    if (!r.ok) throw new Error(`Notion ${r.status} ${path}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
  throw new Error("Notion rate limited");
}

async function queryAll(db, filter) {
  const out = [];
  let cursor;
  do {
    const d = await notion("POST", `/databases/${db}/query`, {
      page_size: 100, ...(filter ? { filter } : {}), ...(cursor ? { start_cursor: cursor } : {}),
    });
    out.push(...d.results);
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor);
  return out;
}

const plain = (p) => {
  if (!p) return null;
  const v = p[p.type];
  if (p.type === "title" || p.type === "rich_text") return v.map((x) => x.plain_text).join("");
  if (p.type === "select" || p.type === "status") return v ? v.name : null;
  if (p.type === "unique_id") return v ? `${v.prefix}-${v.number}` : null;
  return v;
};

export const quarterOf = (iso) => {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
};

// Sprint quarter: the "[YYQn]" tag in the sprint name wins (e.g. "[26Q4] Sprint 20" starts 29 Sep
// but belongs to Q4); only untagged sprints fall back to the quarter of their start date.
export const sprintQuarter = (s) => {
  const m = /\[(\d{2})Q([1-4])\]/.exec(s.name || "");
  return m ? `20${m[1]}-Q${m[2]}` : quarterOf(s.start);
};

// "[26Q4] Sprint 20  – Ver. 2.24.0" -> "[26Q4] Sprint 20"
export const shortSprint = (name) => String(name || "").split(/\s+[–-]\s+/)[0].trim();

const cache = new Map(); // quarter -> { at, data }
const TTL_MS = 5 * 60 * 1000;

// Returns every FE ticket of the quarter's sprints with its pipeline stage; the browser applies
// the chosen criterion (minimum stage), so switching criteria needs no new Notion call.
// period: { q: "2026-Q4" } or { from: sprintId, to: sprintId } (inclusive, by sprint start date).
export async function buildReport(period, { refresh = false } = {}) {
  const key = period.q || `${period.from}..${period.to}`;
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const sprints = new Map();
  for (const p of await queryAll(SPRINTS_DB)) {
    const date = p.properties[SPRINT_DATE_PROP]?.date;
    if (!date?.start) continue;
    const name = plain(Object.values(p.properties).find((v) => v.type === "title"));
    const s = { id: p.id, name, start: date.start.slice(0, 10), end: (date.end || date.start).slice(0, 10) };
    s.q = sprintQuarter(s);
    sprints.set(p.id, s);
  }
  const quarters = [...new Set([...sprints.values()].map((s) => s.q))].filter((q) => q >= FIRST_QUARTER).sort();
  const allSprints = [...sprints.values()].filter((s) => s.q >= FIRST_QUARTER).sort((a, b) => a.start.localeCompare(b.start));
  let quarterSprints, quarter, periodLabel;
  if (period.q) {
    quarter = period.q;
    quarterSprints = allSprints.filter((s) => s.q === quarter);
    periodLabel = quarter;
  } else {
    const a = sprints.get(period.from), b = sprints.get(period.to);
    if (!a || !b) throw new Error("unknown sprint in range");
    const [lo, hi] = a.start <= b.start ? [a, b] : [b, a];
    quarterSprints = allSprints.filter((s) => s.start >= lo.start && s.start <= hi.start);
    quarter = null;
    periodLabel = `${shortSprint(lo.name)} – ${shortSprint(hi.name)}`;
  }
  const inPeriod = new Set(quarterSprints.map((s) => s.id));

  const pages = quarterSprints.length ? await queryAll(TICKETS_DB, {
    and: [
      { property: "Team who handled", select: { equals: "Front-end" } },
      { or: quarterSprints.map((s) => ({ property: "Sprint", relation: { contains: s.id } })) },
    ],
  }) : [];

  const byId = new Map(TEAM.map((m) => [m.id, m]));
  const tickets = [];
  const unknownStatuses = new Set();
  let closed = 0;
  for (const pg of pages) {
    const pr = pg.properties;
    const rel = (pr["Sprint"]?.relation || []).map((r) => sprints.get(r.id)).filter(Boolean);
    if (!rel.length) continue;
    const latest = rel.reduce((a, b) => (b.start > a.start ? b : a)); // carry-over: latest sprint, counted once
    if (!inPeriod.has(latest.id)) continue; // carry-over: counted only where its LATEST sprint falls
    const status = plain(pr["Status"]);
    const stage = STAGE_OF.get(status);
    if (!stage) { if (NEVER.includes(status)) closed++; else unknownStatuses.add(status); continue; }
    const w = plain(pr["Weight"]);
    const members = (pr["Assignee"]?.people || []).map((u) => u.id).filter((u) => byId.has(u)).map((u) => byId.get(u).name);
    tickets.push({
      id: plain(pr["Task ID"]) || pg.id.slice(0, 8), title: plain(pr["Task name"]) || "(untitled)", url: pg.url,
      status, stage, weight: w ? Number(w) : null, agent: plain(pr["Built by"]) === "Agent FE",
      sprintId: latest.id, sprint: latest.name, sprintStart: latest.start, members,
      issueType: plain(pr["Issue Type"]),
    });
  }
  tickets.sort((a, b) => b.sprintStart.localeCompare(a.sprintStart) || a.id.localeCompare(b.id));

  // Note only (never counted): FE members' tickets in the period whose Team is not Front-end.
  const otherTeam = [];
  if (quarterSprints.length) {
    for (const pg of await queryAll(TICKETS_DB, {
      and: [
        { or: quarterSprints.map((s) => ({ property: "Sprint", relation: { contains: s.id } })) },
        { or: TEAM.map((m) => ({ property: "Assignee", people: { contains: m.id } })) },
      ],
    })) {
      const pr = pg.properties;
      const team = plain(pr["Team who handled"]);
      const status = plain(pr["Status"]);
      const rel = (pr["Sprint"]?.relation || []).map((r) => sprints.get(r.id)).filter(Boolean);
      if (team === "Front-end" || NEVER.includes(status) || !rel.length) continue;
      if (!inPeriod.has(rel.reduce((a, b) => (b.start > a.start ? b : a)).id)) continue;
      otherTeam.push({
        id: plain(pr["Task ID"]) || pg.id.slice(0, 8), title: plain(pr["Task name"]) || "(untitled)", url: pg.url,
        team: team || "(kosong)", status, weight: plain(pr["Weight"]),
        members: (pr["Assignee"]?.people || []).filter((u) => byId.has(u.id)).map((u) => byId.get(u.id).name),
      });
    }
  }

  const data = {
    quarter, periodLabel, range: period.q ? null : { from: period.from, to: period.to },
    allSprints: allSprints.map(({ id, name, start, q }) => ({ id, name: shortSprint(name), full: name, start, q })),
    quarters, generatedAt: new Date().toISOString(), team: TEAM.map(({ name, full }) => ({ name, full })),
    stages: STAGES.map(({ n, name, statuses }) => ({ n, name, statuses })), criteria: CRITERIA,
    defaultCriteria: DEFAULT_CRITERIA, never: NEVER, sprints: quarterSprints.map(({ id, name, start, end }) => ({ id, name, start, end })),
    tickets, otherTeam, closed, unknownStatuses: [...unknownStatuses].filter(Boolean),
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

// --- auth: single shared password -> HMAC-signed, HttpOnly cookie ---------------------------
const COOKIE = "fe_dash";
const MAX_AGE_S = 7 * 24 * 3600;
const secret = () => {
  const s = process.env.DASHBOARD_SECRET;
  if (!s || s.length < 32) throw new Error("DASHBOARD_SECRET missing or shorter than 32 chars");
  return s;
};
const sign = (v) => crypto.createHmac("sha256", secret()).update(v).digest("base64url");
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function passwordOk(given) {
  const want = process.env.DASHBOARD_PASSWORD;
  if (!want) throw new Error("DASHBOARD_PASSWORD not configured");
  return safeEq(sign("pw:" + given), sign("pw:" + want));
}

export function sessionCookie() {
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE_S);
  return `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE_S}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export function authed(req) {
  const raw = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return false;
  const [exp, mac] = raw.slice(COOKIE.length + 1).split(".");
  if (!exp || !mac || +exp < Date.now() / 1000) return false;
  return safeEq(mac, sign(exp));
}
