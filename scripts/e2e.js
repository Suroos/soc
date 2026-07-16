/* E2E 시나리오 테스트 — 관리자 흐름을 API로 재연하고 규칙 엔진 결과까지 검증
 * 전제: 깨끗한 data/ 상태에서 서버 실행 중.  node scripts/e2e.js [port] */
"use strict";
const E = require("../public/engine.js");
const BASE = `http://localhost:${process.argv[2] || 3311}`;
let cookie = "", passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
};
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get("set-cookie");
  if (sc && sc.includes("sid=") && !sc.includes("Max-Age=0")) cookie = sc.split(";")[0];
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data, res };
}
async function put(L) {
  const r = await call("PUT", `/api/league/${L.id}`, L);
  if (r.status !== 200) throw new Error("PUT 실패: " + JSON.stringify(r.data));
  L.rev = r.data.rev;
}

(async () => {
  console.log("── 정적 페이지 서빙 ──");
  for (const [p, frag] of [["/", "TOP RATE"], ["/admin", "관리자"], ["/engine.js", "SKILL_MASTER"]]) {
    const res = await fetch(BASE + p);
    const body = await res.text();
    ok(`GET ${p} 200 + 내용`, res.status === 200 && body.includes(frag));
  }

  console.log("── 관리자 셋업 ──");
  await call("POST", "/api/setup", { password: "e2e-pass-1" });
  const names = ["릴리", "쿼스크", "말환", "갈비", "수아", "치킨", "쥬지", "민물고기", "쵸비", "노"];
  const users = [];
  for (const n of names) { const r = await call("POST", "/api/users", { name: n }); users.push(r.data); }
  ok("유저 10명 등록", users.every(u => u && u.id));

  let r = await call("POST", "/api/leagues", { name: "E2E 리그", start: "2026-07-20", end: "2026-08-23" });
  const L = r.data;
  ok("리그 생성", L.id > 0);

  console.log("── 리그 셋업 (관리자 SPA가 하는 일 재연) ──");
  // 선수 등록 + 티어 배치
  const tierOf = ["S", "S", "A+", "A", "B+", "B", "B", "C-", "C+", "C"];
  names.forEach((n, i) => {
    L.players.push({ id: L.seq.player++, userId: users[i].id, name: n,
      tier: tierOf[i], initialTier: tierOf[i], pos: ["공격", "미드", "수비"][i % 3],
      team: null, price: null, round: E.HI_TIERS.includes(tierOf[i]) ? 1 : 2, promoCredited: false, active: true });
  });
  // 팀 2개 + 로스터 (레드팀: 상위 4, 블루팀: 하위 4)
  L.teams.push(
    { id: L.seq.team++, name: "레드팀", coach: "", managerId: null, color: "#ff4d6a", coins: 50, capBonus: 0, skills: ["점멸"], active: true },
    { id: L.seq.team++, name: "블루팀", coach: "", managerId: null, color: "#5aa2ff", coins: 30, capBonus: 0, skills: ["귀환"], active: true });
  [0, 1, 2, 3].forEach(i => { L.players[i].team = 1; });
  [4, 5, 6, 7].forEach(i => { L.players[i].team = 2; });
  L.teams[0].managerId = L.players[0].id;
  // 경기 2건: ①언더독(레드 12800 vs 블루 9800 → 3000p차) 레드 승 ②블루 승
  L.matches.push(
    { id: L.seq.match++, date: "2026-07-21", week: 1, type: "리그",
      red: { team: 1, name: "", players: [1, 2, 3, 4], skills: ["점멸"] },
      blue: { team: 2, name: "", players: [5, 6, 7, 8], skills: ["귀환"] }, result: "red" },
    { id: L.seq.match++, date: "2026-07-22", week: 1, type: "리그",
      red: { team: 1, name: "", players: [1, 2, 3, 4], skills: [] },
      blue: { team: 2, name: "", players: [5, 6, 7, 8], skills: [] }, result: "blue" });
  // 휴면 보정 이벤트 + 코인 지급 + 스킬 구매 기록
  L.adjusts.push({ id: L.seq.adjust++, playerId: 9, delta: -200, reason: "휴면 강등", at: "2026-07-27" });
  L.ledger.push({ id: L.seq.ledger++, type: "coin", at: "2026-07-22", text: "레드팀 코인 +10 (보상)", teamId: 1, delta: 10 });
  await put(L);
  ok("전체 상태 저장(rev 갱신)", L.rev >= 2);

  console.log("── 서버 저장본으로 규칙 검증 ──");
  r = await call("GET", `/api/league/${L.id}`);
  const S = r.data;
  const calc = E.recalc(S);
  // 언더독: 강팀 승 +20, 언더독 패 -20 / 2차전: 강팀 패 -40, 언더독 승 +40
  ok("경기1 언더독 판정", calc.matchCalc[1].und === "blue");
  ok("릴리(S 3300): +20 -40 = 3280", calc.mmr[1] === 3280, `got ${calc.mmr[1]}`);
  ok("수아(B+ 2700): -20 +40 = 2720", calc.mmr[5] === 2720, `got ${calc.mmr[5]}`);
  ok("휴면 보정: 쵸비 2300-200=2100", calc.mmr[9] === 2100, `got ${calc.mmr[9]}`);
  const rank = E.rankings(S, calc);
  ok("랭킹 1위 = 쿼스크/릴리 그룹(S)", rank[0].tier === "S");
  const st = E.standings(S, calc);
  ok("팀 순위: 1승 1패 동률", st.length === 2 && st[0].w === 1 && st[1].w === 1);
  ok("승자승 동률(1:1) → 가나다 (레드팀)", st[0].t.name === "레드팀");

  console.log("── 경기 삭제 = 재계산 ──");
  S.matches = S.matches.filter(m => m.id !== 2);
  await put(S);
  r = await call("GET", `/api/league/${L.id}`);
  const calc2 = E.recalc(r.data);
  ok("삭제 후 릴리 3320 (경기1만)", calc2.mmr[1] === 3320, `got ${calc2.mmr[1]}`);

  console.log("── 주차 자동 산출 ──");
  ok("7/21 = 1주차 / 7/27 = 2주차", E.weekOf(r.data, "2026-07-21") === 1 && E.weekOf(r.data, "2026-07-27") === 2);

  console.log(`\n결과: ${passed} 통과 / ${failed} 실패`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("E2E 실패:", e); process.exit(1); });
