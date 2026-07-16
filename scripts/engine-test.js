/* 규칙 엔진 단위 테스트 — node scripts/engine-test.js */
"use strict";
const E = require("../public/engine.js");
let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
};

/* ── 시나리오 리그 구성 ── */
const L = E.newLeague(1, "테스트리그", "2026-07-20", "2026-08-23");
const mk = (id, name, tier, team) =>
  ({ id, userId: id, name, tier, initialTier: tier, pos: null, team, price: null, round: 0, promoCredited: false, active: true });
// 팀1: S+A+ / 팀2: B-+C- (언더독 유도)
L.players = [
  mk(1, "가", "S", 1),  mk(2, "나", "S", 1),  mk(3, "다", "A+", 1), mk(4, "라", "A+", 1),
  mk(5, "마", "B-", 2), mk(6, "바", "B-", 2), mk(7, "사", "C-", 2), mk(8, "아", "C-", 2),
  mk(9, "자", "B", null),   // 무소속
];
L.teams = [
  { id: 1, name: "강팀", coach: "", managerId: null, color: "#f00", coins: 0, capBonus: 0, skills: [], active: true },
  { id: 2, name: "약팀", coach: "", managerId: null, color: "#0f0", coins: 0, capBonus: 0, skills: [], active: true },
];

console.log("── 주차 계산 ──");
ok("시작일 주 = 1주차", E.weekOf(L, "2026-07-20") === 1);
ok("일요일도 같은 주", E.weekOf(L, "2026-07-26") === 1);
ok("다음 월요일 = 2주차", E.weekOf(L, "2026-07-27") === 2);
ok("시작일 이전 = 1주차 고정", E.weekOf(L, "2026-07-01") === 1);

console.log("── 기본 승패 ±30 ──");
// 합: 강팀 3300+3300+3100+3100=12800, 약팀 2500+2500+2100+2100=9200 → 차 3600 = 언더독
L.matches = [{ id: 1, date: "2026-07-21", week: 1, type: "리그",
  red: { team: 1, name: "", players: [1, 2, 3, 4], skills: [] },
  blue: { team: 2, name: "", players: [5, 6, 7, 8], skills: [] }, result: "red" }];
let c = E.recalc(L);
ok("언더독 판정(blue)", c.matchCalc[1].und === "blue");
ok("강팀 승 +20", c.mmr[1] === 3320, `got ${c.mmr[1]}`);
ok("언더독 패 -20", c.mmr[5] === 2480, `got ${c.mmr[5]}`);

console.log("── 언더독 승리 +40 ──");
L.matches.push({ id: 2, date: "2026-07-22", week: 1, type: "리그",
  red: { team: 1, name: "", players: [1, 2, 3, 4], skills: [] },
  blue: { team: 2, name: "", players: [5, 6, 7, 8], skills: [] }, result: "blue" });
c = E.recalc(L);
ok("언더독 승 +40 (2480+40)", c.mmr[5] === 2520, `got ${c.mmr[5]}`);
ok("강팀 패 -40 (3320-40)", c.mmr[1] === 3280, `got ${c.mmr[1]}`);

console.log("── 무승부 0 / 비언더독 ±30 ──");
// 비슷한 팀끼리 (가,마) vs (나,바) 2:2는 룰상 없지만 계산 검증용 4:4 구성
L.matches.push({ id: 3, date: "2026-07-23", week: 1, type: "아마추어",
  red: { team: null, name: "임시A", players: [1, 5, 7, 9], skills: [] },
  blue: { team: null, name: "임시B", players: [2, 6, 8, 3], skills: [] }, result: "draw" });
const before = E.recalc(L).mmr[1];
c = E.recalc(L);
ok("무승부 변동 0", c.mmr[1] === before);

console.log("── mmr_adjust 리플레이 (같은 날짜: 조정 먼저) ──");
L.adjusts.push({ id: 1, playerId: 1, delta: -200, reason: "휴면 강등", at: "2026-07-22" });
c = E.recalc(L);
// 7/21 경기(+20) → 7/22 조정(-200) 먼저 → 7/22 경기(-40) = 3300+20-200-40 = 3080
ok("조정 포함 재계산", c.mmr[1] === 3080, `got ${c.mmr[1]}`);
// 조정으로 합이 바뀌어도 7/22 경기의 언더독 재판정 여부 확인 (차이 3600-240 → 여전히 언더독)
ok("조정 후에도 언더독 유지", c.matchCalc[2].und === "blue");

console.log("── 경기 삭제 = 재계산 ──");
L.matches = L.matches.filter(m => m.id !== 2);
c = E.recalc(L);
ok("삭제 반영 (3300+20-200)", c.mmr[1] === 3120, `got ${c.mmr[1]}`);
L.matches.push({ id: 2, date: "2026-07-22", week: 1, type: "리그",
  red: { team: 1, name: "", players: [1, 2, 3, 4], skills: [] },
  blue: { team: 2, name: "", players: [5, 6, 7, 8], skills: [] }, result: "blue" });

console.log("── 랭킹 (동점: 승수→승률→가나다) ──");
c = E.recalc(L);
const rank = E.rankings(L, c);
ok("1위 = 최고 MMR", c.mmr[rank[0].id] === Math.max(...rank.map(p => c.mmr[p.id])));
ok("티어 없는 선수 제외", rank.every(p => p.tier));
// 동점 케이스: 나(2)와 가(1)는 같은 경기들 — 가만 -200 조정 → 나가 위
ok("조정받은 선수가 아래", rank.findIndex(p => p.id === 2) < rank.findIndex(p => p.id === 1));

console.log("── 팀 순위 (리그 경기만, 승자승) ──");
const st = E.standings(L, c);
ok("아마추어 경기 제외 (1승 1패씩)", st[0].w === 1 && st[1].w === 1);
ok("동률 승자승 → 최근 승리와 무관, 서로 1승씩 → 가나다", st[0].t.name === "강팀");
ok("승점 = 3", st[0].pts === 3 && st[1].pts === 3);

console.log(`\n결과: ${passed} 통과 / ${failed} 실패`);
process.exit(failed ? 1 : 0);
