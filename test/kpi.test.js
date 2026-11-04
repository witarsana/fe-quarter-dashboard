import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { assignTickets, buildPyramids, checkMappingAgainstMetrics, loadMapping, summarize, validateMapping } from "../api/_kpi.js";
import { NEVER, STAGES, TEAM } from "../api/_lib.js";

const M = {
  committed: "2b1c6dc1a8eb8180be88f3c9d8de4d4d",
  additional: "2b1c6dc1a8eb81978801e9deebb84bed",
  platform: "2b1c6dc1a8eb81c4997ed8b61b6a55ff",
  bug: "2b1c6dc1a8eb81f9b201c123d7125bec",
  uptime: "3f7c6dc1a8eb80328305fc5808981b5a",
  incident: "3f7c6dc1a8eb80e499e1c8ecb8f9adef",
};
// Epic relations of the 2026 Q4 ProdDev Metrics rows, read via Notion MCP on 2026-11-04.
const EPICS = {
  committed: "3c3c6dc1a8eb80978e81ffdc7ab77c87 3e3c6dc1a8eb81e3b748d98fb4c5e225 3dec6dc1a8eb80afa4e2d43b4dcdcb7a 3d7c6dc1a8eb80e98cbfd29804983bf1 3ebc6dc1a8eb8036b4e7ec3bac52dc4f 3eac6dc1a8eb801fb17df5af92b23d91 3eac6dc1a8eb80dca83ffe2e9eebb7a6 3eac6dc1a8eb80398450d2c1fdcd7020",
  additional: "391c6dc1a8eb80b292f6ca9b0cd25f10 3e3c6dc1a8eb8105b93cdf4bd2cf750d 401c6dc1a8eb81f48b91f632193259d0",
  platform: "3ddc6dc1a8eb80029eb8c8fb9ce83331 3dec6dc1a8eb81fba1e1e33d3e33c5c4 3e3c6dc1a8eb8185a1a0ddad341f8932 3e3c6dc1a8eb81e883ebfbbc304fd69d 3e5c6dc1a8eb8147be30cf4757dfa494 3e7c6dc1a8eb81e99424ee029404717d 3dcc6dc1a8eb8009a405c21c01ec3788 3eac6dc1a8eb817aa4d3e42d56ff7939 3eac6dc1a8eb817a87cef042d8d1c9d8 3eac6dc1a8eb813caadee54e6fcd0785 3eac6dc1a8eb81c9ad96c86e1029f2a3 3eac6dc1a8eb815d9a4efcb19fe48fc4 3eac6dc1a8eb8134846dedd5fbbf4ff0 3f0c6dc1a8eb80d1a410c942a3b62fb9 401c6dc1a8eb81de8445f21fd28af897 401c6dc1a8eb816792d7cb5239b579a2 401c6dc1a8eb81f6bda4d003d9a0d7e6 402c6dc1a8eb81b9a4ede844e0eb866c bfdc6dc1a8eb83ae9ed901f87c48af88 40cc6dc1a8eb810a868dfd6488535d88",
  bug: "3e3c6dc1a8eb81118096e6632d5a658c 3e3c6dc1a8eb81b1a6e5c79a0345897f",
  uptime: "", incident: "",
};
const METRICS = Object.entries(M).map(([k, id]) => ({ id, name: k, kind: k === "platform" ? "Rocks" : "Score Card", target: 100, actualDept: null, epicIds: EPICS[k].split(" ").filter(Boolean) }));
const EMPTY_Q = { metrics: {}, extraEpics: [], excludeEpics: [], rules: [] };

const STAGE_OF = new Map(STAGES.flatMap((s) => s.statuses.map((st) => [st, s.n])));
const NAME_OF = new Map(TEAM.map((m) => [m.id, m.name]));
function fixtureTickets() {
  const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/q4-fe-tickets-2026-11-04.json", import.meta.url)));
  return fx.rows.filter((r) => !NEVER.includes(r.status)).map((r) => ({
    id: `TSP-${r.taskId}`, title: r.title, status: r.status, stage: STAGE_OF.get(r.status), weight: r.weight ? Number(r.weight) : null,
    issueType: r.issueType, epicIds: r.epic,
    members: r.assignee.map((u) => NAME_OF.get(u.replace("user://", ""))).filter(Boolean),
  }));
}
const count = (p, id) => p.metrics.find((m) => m.id === id).fe.tickets;

// --- real data (2026-11-04) -------------------------------------------------------------------
test("fixture: 92 tiket FE dengan Weight 292 setelah status pengecualian", () => {
  const t = fixtureTickets();
  assert.equal(t.length, 92);
  assert.equal(t.reduce((s, x) => s + (x.weight || 0), 0), 292);
  assert.ok(t.every((x) => x.stage), "semua status terpetakan ke tahap");
});

test("tanpa mapping: cakupan sama dengan analisis MCP (Platform 45, Bug 16, Committed 12, Additional 0, di luar 19)", () => {
  const p = buildPyramids({ quarter: "2026-Q4", metrics: METRICS, tickets: fixtureTickets(), qmap: EMPTY_Q });
  assert.equal(count(p, M.platform), 45);
  assert.equal(count(p, M.bug), 16);
  assert.equal(count(p, M.committed), 12);
  assert.equal(count(p, M.additional), 0);
  assert.equal(p.outside.length, 19);
  const w = (id) => p.metrics.find((m) => m.id === id).fe.points;
  assert.deepEqual([w(M.platform), w(M.bug), w(M.committed)], [140, 41, 72]);
});

test("dengan mapping.json Q4: tiap tiket muncul di >=1 piramid atau Di luar KPI", () => {
  const qmap = validateMapping(loadMapping()).quarters["2026-Q4"];
  const tickets = fixtureTickets();
  const p = buildPyramids({ quarter: "2026-Q4", metrics: METRICS, tickets, qmap });
  const seen = new Set([...p.outside, ...p.metrics.filter((m) => m.mode === "shown").flatMap((m) => m.ticketIds)]);
  assert.equal(seen.size, tickets.length);
  // Org map link (4) -> Platform, LC discount (5) -> Committed, 7 bug tanpa epic -> Bug.
  assert.equal(count(p, M.platform), 49);
  assert.equal(count(p, M.committed), 17);
  assert.equal(count(p, M.bug), 23);
  assert.equal(p.outside.length, 3); // 2 epic lain + 1 ticket tanpa epic
  const plat = p.metrics.find((m) => m.id === M.platform);
  assert.deepEqual(plat.fe.bySource, { notion: 45, mapping: 4, rule: 0 });
  assert.equal(p.metrics.find((m) => m.id === M.bug).fe.bySource.rule, 7);
  assert.equal(p.metrics.find((m) => m.id === M.uptime).mode, "hidden");
  const inc = p.metrics.find((m) => m.id === M.incident);
  assert.equal(inc.mode, "team");
  assert.equal(inc.members, undefined, "incident tidak diturunkan ke anggota");
});

// --- algorithm edge cases ---------------------------------------------------------------------
const T = (id, epicIds, extra = {}) => ({ id, title: id, stage: 5, weight: 2, issueType: "Ticket", members: ["Koyo"], epicIds, ...extra });
const E1 = "a".repeat(32), E2 = "b".repeat(32), MA = "1".repeat(32), MB = "2".repeat(32);
const metrics = [{ id: MA, epicIds: [E1] }, { id: MB, epicIds: [E2] }];

test("tiket multi-epic masuk ke dua metric, total tidak dijumlah ganda", () => {
  const a = assignTickets([T("x", [E1, E2])], metrics, EMPTY_Q);
  assert.deepEqual(a.get("x").map((g) => g.id).sort(), [MA, MB]);
});

test("excludeEpics mengeluarkan epic dari metric tertentu saja", () => {
  const a = assignTickets([T("x", [E1])], metrics, { ...EMPTY_Q, excludeEpics: [{ epic: E1, metric: MA }] });
  assert.deepEqual(a.get("x"), []);
});

test("Notion menang atas mapping untuk metric yang sama", () => {
  const a = assignTickets([T("x", [E1])], metrics, { ...EMPTY_Q, extraEpics: [{ epic: E1, metric: MA }] });
  assert.deepEqual(a.get("x"), [{ id: MA, source: "notion" }]);
});

test("rule hanya berlaku untuk tiket tanpa metric", () => {
  const rules = [{ when: { issueType: "Bug", hasEpic: false }, metric: MB }];
  const a = assignTickets([T("bug-no-epic", [], { issueType: "Bug" }), T("bug-epic", [E1], { issueType: "Bug" }), T("bug-other", ["c".repeat(32)], { issueType: "Bug" })], metrics, { ...EMPTY_Q, rules });
  assert.deepEqual(a.get("bug-no-epic"), [{ id: MB, source: "rule" }]);
  assert.deepEqual(a.get("bug-epic"), [{ id: MA, source: "notion" }]);
  assert.deepEqual(a.get("bug-other"), []);
});

test("summarize: Deployed vs Lolos QA, poin dibagi rata antar assignee", () => {
  const ts = [
    { stage: 7, weight: 4, members: ["Koyo", "Galang"] },
    { stage: 5, weight: 2, members: ["Koyo"] },
    { stage: 2, weight: null, members: ["Koyo"] },
  ];
  const team = summarize(ts);
  assert.equal(team.deployedPct, 33.3);
  assert.equal(team.qaPct, 66.7);
  assert.equal(team.points, 6);
  assert.equal(team.unweighted, 1);
  const koyo = summarize(ts, (t) => 1 / t.members.length);
  assert.equal(koyo.points, 4);
  assert.equal(summarize([]).deployedPct, null);
});

// --- mapping validation -----------------------------------------------------------------------
test("mapping.json yang ada valid dan cocok dengan metric Q4", () => {
  const m = validateMapping(loadMapping());
  checkMappingAgainstMetrics(m.quarters["2026-Q4"], Object.values(M));
});

test("validasi menolak entri tanpa alasan, ID rusak, dan metric yang tidak ada", () => {
  const bad = { version: 1, quarters: { "2026-Q4": { metricsDb: "x", extraEpics: [{ epic: "123", metric: MA }], metrics: { [MA]: { fe: "nope" } } } } };
  assert.throws(() => validateMapping(bad), (e) => /metricsDb/.test(e.message) && /epic harus 32 hex/.test(e.message) && /reason wajib/.test(e.message) && /fe harus/.test(e.message));
  assert.throws(() => checkMappingAgainstMetrics({ extraEpics: [{ epic: E1, metric: "9".repeat(32) }] }, [MA]), /tidak ada di DB metric/);
});

// --- Notion fetch: relation > 25 items -------------------------------------------------------
test("loadMetrics mengambil relasi epic lengkap saat Notion memotong di 25 item", async (t) => {
  const { loadMetrics } = await import("../api/_kpi.js");
  const ids = Array.from({ length: 30 }, (_, i) => i.toString(16).padStart(32, "0"));
  process.env.NOTION_TOKEN = "test";
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    const json = (b) => ({ ok: true, status: 200, json: async () => b });
    if (url.endsWith("/databases/db/query")) return json({ has_more: false, results: [{
      id: MA, url: "u", properties: {
        Name: { type: "title", title: [{ plain_text: "Platform" }] },
        KPI: { type: "select", select: { name: "Rocks" } },
        "Target %": { type: "number", number: 100 },
        "Actual %": { type: "rollup", rollup: { type: "number", number: 62.5 } },
        "📽️ Epic Development Tracker": { id: "abc%3D", type: "relation", has_more: true, relation: ids.slice(0, 25).map((id) => ({ id })) },
      } }] });
    const page2 = url.includes("start_cursor=c2");
    return json({ has_more: !page2, next_cursor: "c2", results: (page2 ? ids.slice(25) : ids.slice(0, 25)).map((id) => ({ type: "relation", relation: { id } })) });
  });
  const [m] = await loadMetrics("db");
  assert.equal(m.epicIds.length, 30);
  assert.equal(m.actualDept, 62.5);
  assert.equal(calls.filter((u) => u.includes("/properties/")).length, 2);
});
