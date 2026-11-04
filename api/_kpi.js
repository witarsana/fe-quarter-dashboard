// FE KPI pyramid: department metric -> FE -> member -> ticket. Server-side only.
// Design + verification steps: docs/kpi-pyramid.md and the Notion page "FE KPI Pyramid — Metodologi".
// Invariant: read-only against Notion. Every FE adjustment lives in mapping.json.
import fs from "node:fs";
import path from "node:path";
import { buildReport, notion, plain, queryAll, TEAM } from "./_lib.js";

const HEX32 = /^[0-9a-f]{32}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const METRIC_EPIC_PROP = "📽️ Epic Development Tracker";
const MODES = ["shown", "hidden", "team"];
export const norm = (id) => String(id || "").replace(/-/g, "").toLowerCase();

// ---------------------------------------------------------------- mapping.json
export function loadMapping(file = path.join(process.cwd(), "api", "_mapping.json")) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Structural checks that need no Notion data. Throws with every problem listed, never half-applies.
export function validateMapping(m) {
  const errs = [];
  if (m?.version !== 1) errs.push("version must be 1");
  const audit = (where, e) => {
    if (!e.reason || typeof e.reason !== "string") errs.push(`${where}: reason wajib`);
    if (!e.by || typeof e.by !== "string") errs.push(`${where}: by wajib`);
    if (!DATE.test(e.date || "")) errs.push(`${where}: date harus YYYY-MM-DD`);
  };
  for (const [q, c] of Object.entries(m?.quarters || {})) {
    if (!/^\d{4}-Q[1-4]$/.test(q)) errs.push(`quarter key ${q} tidak valid`);
    if (!HEX32.test(c.metricsDb || "")) errs.push(`${q}.metricsDb harus 32 hex`);
    for (const [id, e] of Object.entries(c.metrics || {})) {
      const w = `${q}.metrics.${id}`;
      if (!HEX32.test(id)) errs.push(`${w}: id harus 32 hex`);
      if (!MODES.includes(e.fe)) errs.push(`${w}: fe harus salah satu ${MODES.join("/")}`);
      if (e.targetUnit !== undefined && typeof e.targetUnit !== "string") errs.push(`${w}: targetUnit harus teks`);
      if (e.fe === "team") {
        try { new RegExp(e.count?.titleRegex || "", e.count?.flags || ""); } catch { errs.push(`${w}: count.titleRegex tidak valid`); }
        if (!e.count?.titleRegex) errs.push(`${w}: mode team butuh count.titleRegex`);
      }
      audit(w, e);
    }
    for (const key of ["extraEpics", "excludeEpics"]) {
      (c[key] || []).forEach((e, i) => {
        const w = `${q}.${key}[${i}]`;
        if (!HEX32.test(e.epic || "")) errs.push(`${w}.epic harus 32 hex`);
        if (!HEX32.test(e.metric || "")) errs.push(`${w}.metric harus 32 hex`);
        audit(w, e);
      });
    }
    (c.rules || []).forEach((r, i) => {
      const w = `${q}.rules[${i}]`;
      const keys = Object.keys(r.when || {});
      if (!keys.length) errs.push(`${w}.when kosong`);
      for (const k of keys) if (!["issueType", "hasEpic"].includes(k)) errs.push(`${w}.when.${k} tidak dikenal`);
      if (!HEX32.test(r.metric || "")) errs.push(`${w}.metric harus 32 hex`);
      audit(w, r);
    });
  }
  if (errs.length) throw new Error("mapping.json tidak valid:\n- " + errs.join("\n- "));
  return m;
}

// Checks against the metrics actually present in the quarter's Notion DB.
export function checkMappingAgainstMetrics(qmap, metricIds) {
  const known = new Set(metricIds);
  const errs = [];
  for (const id of Object.keys(qmap.metrics || {})) if (!known.has(id)) errs.push(`metrics.${id} tidak ada di DB metric`);
  for (const key of ["extraEpics", "excludeEpics", "rules"])
    (qmap[key] || []).forEach((e, i) => { if (!known.has(e.metric)) errs.push(`${key}[${i}].metric ${e.metric} tidak ada di DB metric`); });
  if (errs.length) throw new Error("mapping.json tidak cocok dengan Notion:\n- " + errs.join("\n- "));
}

// ---------------------------------------------------------------- pure computation
const ruleMatches = (when, t) =>
  (when.issueType === undefined || t.issueType === when.issueType) &&
  (when.hasEpic === undefined || (t.epicIds.length > 0) === when.hasEpic);

// metrics: [{ id, epicIds }]; tickets: rekap tickets with epicIds (normalized). Returns Map(ticketId -> [{id, source}]).
export function assignTickets(tickets, metrics, qmap) {
  const excluded = new Set((qmap.excludeEpics || []).map((e) => `${e.metric}:${e.epic}`));
  const byEpic = new Map(); // epic -> [{metric, source}]
  const add = (epic, metric, source) => {
    if (!byEpic.has(epic)) byEpic.set(epic, []);
    const list = byEpic.get(epic);
    if (!list.some((x) => x.metric === metric)) list.push({ metric, source });
  };
  for (const m of metrics) for (const e of m.epicIds) if (!excluded.has(`${m.id}:${e}`)) add(e, m.id, "notion");
  for (const x of qmap.extraEpics || []) add(x.epic, x.metric, "mapping");

  const out = new Map();
  for (const t of tickets) {
    const got = [];
    for (const e of t.epicIds) for (const { metric, source } of byEpic.get(e) || [])
      if (!got.some((g) => g.id === metric)) got.push({ id: metric, source });
    // A metric reached via Notion wins over the same metric reached via mapping.
    for (const g of got) if (g.source === "mapping" && t.epicIds.some((e) => (byEpic.get(e) || []).some((x) => x.metric === g.id && x.source === "notion"))) g.source = "notion";
    if (!got.length) {
      const rule = (qmap.rules || []).find((r) => ruleMatches(r.when, t));
      if (rule) got.push({ id: rule.metric, source: "rule" });
    }
    out.set(t.id, got);
  }
  return out;
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

// Numbers for one node. share(t) = how much of the ticket this node owns (1 for the team, 1/k for a member).
export function summarize(tickets, share = () => 1) {
  let points = 0, ptsDeployed = 0, ptsQa = 0, deployed = 0, qa = 0, unweighted = 0;
  for (const t of tickets) {
    const p = (t.weight ?? 0) * share(t);
    if (t.weight == null) unweighted++;
    points += p;
    if (t.stage === 7) { deployed++; ptsDeployed += p; }
    if (t.stage >= 5) { qa++; ptsQa += p; }
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    tickets: tickets.length, points: r2(points), unweighted,
    deployed, qa, deployedPct: pct(deployed, tickets.length), qaPct: pct(qa, tickets.length),
    deployedPtsPct: pct(ptsDeployed, points), qaPtsPct: pct(ptsQa, points),
  };
}

export function buildPyramids({ quarter, metrics, tickets, qmap, epicTitles = new Map() }) {
  const assigned = assignTickets(tickets, metrics, qmap);
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const members = TEAM.map((m) => m.name);
  const out = [];
  for (const m of metrics) {
    const cfg = qmap.metrics?.[m.id] || { fe: "shown" };
    const base = {
      id: m.id, name: m.name, kind: m.kind, target: m.target, actualDept: m.actualDept, url: m.url,
      epicCount: m.epicIds.length, mode: cfg.fe, modeReason: cfg.reason || null, targetUnit: cfg.targetUnit || null,
    };
    if (cfg.fe === "hidden") { out.push(base); continue; }
    if (cfg.fe === "team") {
      const re = new RegExp(cfg.count.titleRegex, cfg.count.flags || "");
      const list = tickets.filter((t) => re.test(t.title));
      out.push({ ...base, countLabel: cfg.count.label || null, fe: summarize(list), ticketIds: list.map((t) => t.id) });
      continue;
    }
    const ids = [...assigned].filter(([, ms]) => ms.some((x) => x.id === m.id)).map(([id]) => id);
    const list = ids.map((id) => byId.get(id));
    const bySource = { notion: 0, mapping: 0, rule: 0 };
    for (const id of ids) bySource[assigned.get(id).find((x) => x.id === m.id).source]++;
    const fe = { ...summarize(list), bySource };
    const memberNodes = members.map((name) => {
      const mine = list.filter((t) => t.members.includes(name));
      return { name, ...summarize(mine, (t) => 1 / t.members.length), ticketIds: mine.map((t) => t.id) };
    });
    const noAssignee = list.filter((t) => !t.members.length).map((t) => t.id);
    out.push({ ...base, fe, members: memberNodes, noAssignee, ticketIds: ids });
  }
  const outside = tickets.filter((t) => !assigned.get(t.id).length).map((t) => t.id);
  const ticketMap = Object.fromEntries(tickets.map((t) => [t.id, {
    title: t.title, url: t.url, stage: t.stage, status: t.status, weight: t.weight, issueType: t.issueType,
    sprint: t.sprint, members: t.members, agent: t.agent,
    epics: t.epicIds.map((e) => ({ id: e, title: epicTitles.get(e) || null })),
    metrics: assigned.get(t.id),
  }]));
  return { quarter, metrics: out, outside, tickets: ticketMap, uniqueTickets: tickets.length };
}

// ---------------------------------------------------------------- Notion fetch (read-only)
// Relation properties are truncated at 25 items in page objects; page through the property endpoint.
async function fullRelation(pageId, prop) {
  if (!prop?.has_more) return (prop?.relation || []).map((r) => norm(r.id));
  const ids = [];
  let cursor;
  do {
    const d = await notion("GET", `/pages/${pageId}/properties/${encodeURIComponent(prop.id)}${cursor ? `?start_cursor=${cursor}` : ""}`);
    ids.push(...d.results.map((r) => norm(r.relation.id)));
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor);
  return ids;
}

export async function loadMetrics(dbId) {
  const pages = await queryAll(dbId);
  const out = [];
  for (const p of pages) {
    const pr = p.properties;
    const actual = pr["Actual %"];
    out.push({
      id: norm(p.id), url: p.url,
      name: plain(Object.values(pr).find((v) => v.type === "title")) || "(untitled)",
      kind: plain(pr["KPI"]), target: pr["Target %"]?.number ?? null,
      actualDept: actual?.type === "rollup" && actual.rollup?.type === "number" ? actual.rollup.number : null,
      epicIds: await fullRelation(p.id, pr[METRIC_EPIC_PROP]),
    });
  }
  return out;
}

async function loadEpicTitles(ids) {
  const titles = new Map();
  const missing = [];
  const queue = [...ids];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        const p = await notion("GET", `/pages/${id}`);
        titles.set(id, plain(Object.values(p.properties).find((v) => v.type === "title")) || null);
      } catch { missing.push(id); }
    }
  };
  await Promise.all([worker(), worker(), worker()]); // Notion allows ~3 req/s
  return { titles, missing };
}

const cache = new Map();
const TTL_MS = 5 * 60 * 1000;

export async function buildKpi(quarter, { refresh = false, mapping = loadMapping() } = {}) {
  const hit = cache.get(quarter);
  if (!refresh && hit && Date.now() - hit.at < TTL_MS) return hit.data;

  validateMapping(mapping);
  const qmap = mapping.quarters?.[quarter];
  if (!qmap) throw new Error(`mapping.json belum punya quarter ${quarter}`);

  const [metrics, report] = await Promise.all([loadMetrics(qmap.metricsDb), buildReport({ q: quarter }, { refresh })]);
  checkMappingAgainstMetrics(qmap, metrics.map((m) => m.id));

  const tickets = [];
  for (const t of report.tickets) {
    const epicIds = t.epicHasMore ? await fullRelation(t.pageId, { has_more: true, id: t.epicPropId }) : t.epicIds;
    tickets.push({ ...t, epicIds: epicIds.map(norm) });
  }
  const epicIds = new Set([...tickets.flatMap((t) => t.epicIds), ...(qmap.extraEpics || []).map((e) => e.epic)]);
  const { titles, missing } = await loadEpicTitles(epicIds);

  const warnings = [];
  for (const m of metrics) if (m.actualDept == null && m.epicIds.length) warnings.push(`${m.name}: Actual % kosong atau tidak terbaca`);
  if (missing.length) warnings.push(`${missing.length} epic tidak bisa dibaca (cek akses integration): ${missing.join(", ")}`);
  for (const e of qmap.extraEpics || []) if (!titles.has(e.epic)) warnings.push(`extraEpics: epic ${e.epic} tidak ditemukan`);
  const unweighted = tickets.filter((t) => t.weight == null).length;
  if (unweighted) warnings.push(`${unweighted} tiket tanpa Weight (poin dihitung 0)`);
  if (report.unknownStatuses?.length) warnings.push(`Status belum dipetakan: ${report.unknownStatuses.join(", ")}`);

  const data = {
    ...buildPyramids({ quarter, metrics, tickets, qmap, epicTitles: titles }),
    generatedAt: new Date().toISOString(),
    mapping: {
      version: mapping.version,
      metrics: qmap.metrics || {}, extraEpics: qmap.extraEpics || [], excludeEpics: qmap.excludeEpics || [], rules: qmap.rules || [],
    },
    team: report.team, stages: report.stages, quarters: Object.keys(mapping.quarters).sort(),
    warnings,
  };
  cache.set(quarter, { at: Date.now(), data });
  return data;
}
