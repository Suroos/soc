/* JSON 스토어 + API 스모크 테스트 — node scripts/smoke.js [port]
 * 깨끗한 data 상태에서 전체 흐름을 검증한다 (한글 포함). */
"use strict";
const BASE = `http://localhost:${process.argv[2] || 3311}`;
let cookie = "";
let passed = 0, failed = 0;

function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie && setCookie.includes("sid=") && !setCookie.includes("Max-Age=0"))
    cookie = setCookie.split(";")[0];
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

(async () => {
  console.log("── 1. 초기 상태 / 최초 설정 ──");
  let r = await call("GET", "/api/system");
  ok("needsSetup=true", r.data.needsSetup === true);

  r = await call("POST", "/api/setup", { password: "12345" });
  ok("짧은 비번 거부(400)", r.status === 400);
  r = await call("POST", "/api/setup", { password: "test-pass-1" });
  ok("최초 설정 성공 + 세션 발급", r.status === 200 && cookie.startsWith("sid="));
  r = await call("POST", "/api/setup", { password: "another-pass" });
  ok("재설정 차단(409)", r.status === 409);

  console.log("── 2. 유저 (한글) ──");
  r = await call("POST", "/api/users", { name: "릴리" });
  ok("유저 추가", r.status === 200 && r.data.name === "릴리");
  r = await call("POST", "/api/users", { name: "릴리" });
  ok("중복 거부(409)", r.status === 409);
  r = await call("POST", "/api/users", { name: "  쿼스크  " });
  ok("공백 트림", r.data && r.data.name === "쿼스크");

  console.log("── 3. 리그 생성/조회 ──");
  r = await call("POST", "/api/leagues", { name: "2026 썸머리그", start: "2026-07-20", end: "2026-08-23" });
  const lid = r.data.id;
  ok("리그 생성", r.status === 200 && r.data.name === "2026 썸머리그");
  ok("티어 10종 기본값", Object.keys(r.data.tiers).length === 10 && r.data.tiers["S"].mmr === 3300);
  ok("스킬 54종 기본 배치", Object.keys(r.data.skillTier).length === 54 && r.data.skillTier["점멸"] === "S");
  ok("C- 정원 무제한(null)", r.data.tiers["C-"].cap === null);

  cookie = "";   // 비로그인으로 조회 (공개)
  r = await call("GET", `/api/league/${lid}`);
  ok("비로그인 리그 조회 가능", r.status === 200 && r.data.config.salaryCap === 90);
  const league = r.data;

  console.log("── 4. 리그 저장 (전체 상태 PUT + 낙관적 잠금) ──");
  r = await call("PUT", `/api/league/${lid}`, league);
  ok("비로그인 저장 차단(401)", r.status === 401);

  r = await call("POST", "/api/login", { password: "wrong!" });
  ok("틀린 비번(401)", r.status === 401);
  r = await call("POST", "/api/login", { password: "test-pass-1" });
  ok("로그인", r.status === 200);

  league.players.push({ id: 1, userId: 1, name: "릴리", tier: "S", initialTier: "S",
    pos: "공격", team: null, price: null, round: 1, promoCredited: false, active: true });
  league.seq.player = 2;
  league.ledger.push({ id: 1, type: "coin", at: "2026-07-14", text: "쥬지팀 코인 +10 (테스트)" });
  r = await call("PUT", `/api/league/${lid}`, league);
  ok("전체 상태 저장", r.status === 200 && r.data.rev === league.rev + 1);

  r = await call("PUT", `/api/league/${lid}`, league);   // 낡은 rev 그대로 재전송
  ok("rev 충돌 감지(409)", r.status === 409 && r.data.rev === league.rev + 1);

  console.log("── 5. 메타 수정 / 보관 ──");
  r = await call("PATCH", `/api/league/${lid}/meta`, { end: "2026-08-30", status: "archived" });
  ok("기간 수정 + 보관", r.status === 200);
  r = await call("GET", `/api/league/${lid}`);
  ok("저장 반영 확인", r.data.end === "2026-08-30" && r.data.status === "archived"
    && r.data.players.length === 1 && r.data.players[0].name === "릴리");

  console.log("── 6. 시스템 목록 ──");
  r = await call("GET", "/api/system");
  ok("유저 2명 · 리그 1개", r.data.users.length === 2 && r.data.leagues.length === 1);
  ok("리그 목록에 상태 반영", r.data.leagues[0].status === "archived");

  console.log(`\n결과: ${passed} 통과 / ${failed} 실패`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("테스트 실행 실패:", e.message); process.exit(1); });
