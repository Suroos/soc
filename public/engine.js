/* 초축 리그 — 공용 규칙 상수/기본값 (서버·브라우저 공유)
 * 서버는 require("../public/engine.js"), 브라우저는 <script src="/engine.js">로 사용한다. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== "undefined" ? self : this, function () {

  /* ── 티어 (기본값: 기획안 수치, 리그별 tiers에 복사 후 수정 가능) ── */
  const TIER_ORDER = ["S", "A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-"];
  const TIER_DEFAULT = {
    "S":  { mmr: 3300, sal: 30, cap: 8 },
    "A+": { mmr: 3100, sal: 25, cap: 4 },
    "A":  { mmr: 3000, sal: 25, cap: 3 },
    "A-": { mmr: 2900, sal: 25, cap: 1 },
    "B+": { mmr: 2700, sal: 20, cap: 6 },
    "B":  { mmr: 2600, sal: 20, cap: 6 },
    "B-": { mmr: 2500, sal: 20, cap: 6 },
    "C+": { mmr: 2300, sal: 15, cap: 6 },
    "C":  { mmr: 2200, sal: 15, cap: 6 },
    "C-": { mmr: 2100, sal: 15, cap: null },   // 최하위 받이 — 정원 없음
  };
  const HI_TIERS = ["S", "A+", "A", "A-"];               // S~A- (로스터 상한 판정)
  /* 비공식 경기 자격 (기획안 8-1/8-2) — 두 구간이 10개 티어를 정확히 양분한다 */
  const PRO_TIERS = ["S", "A+", "A", "A-", "B+"];        // 프로: S~B+
  const AMA_TIERS = ["B", "B-", "C+", "C", "C-"];        // 아마추어: B~C-
  const groupOf = tier => tier ? tier[0] : null;         // "A-" → "A"

  /* ── 스킬 마스터 (고정 54종 — 리그와 무관, 불변) ── */
  const SKILL_MASTER = {
    S: [["유체이탈","👻"],["점멸","⚡"],["염력","🧠"],["쇄도","🌊"],["시즈모드","💥"],["핵폭발","☢️"],["웹","🕸️"],["저격","🎯"]],
    A: [["부스터","🚀"],["표식","📍"],["골리앗","🤖"],["쇠약","🩸"],["강타","👊"],["쐐기벌레","🐛"],["장애물","🚧"],["그물","🥅"],
        ["시한폭탄","💣"],["비행","🕊️"],["포탈","🌀"],["울트라","🦏"],["저장","💾"],["질주","💨"],["킥력","🦵"],["돌격","🐗"]],
    B: [["봉인","🔒"],["토템","🗿"],["충격탄","🔫"],["은신","🥷"],["자석","🧲"],["깃털","🪶"],["백스텝","↩️"],["와이어","🪢"],
        ["압정","📌"],["워프","🌌"],["셔틀","🛸"],["디펜시브","🛡️"],["늪","🐸"],["위성","🛰️"],["촉수","🐙"]],
    C: [["귀환","🏠"],["포톤캐논","🔆"],["잠복","🕳️"],["일섬","🗡️"],["피지컬","💪"],["집중","🧘"],["왜곡","🌫️"],["감아차기","🍌"],
        ["마취","💉"],["점령","🚩"],["빙의","😈"],["목줄","⛓️"],["주력","👟"],["끈기","🔥"],["야마토건","🔱"]],
  };
  const SKILL_ICON = {};
  const SKILL_TIER_DEFAULT = {};
  for (const [tier, list] of Object.entries(SKILL_MASTER))
    for (const [name, icon] of list) { SKILL_ICON[name] = icon; SKILL_TIER_DEFAULT[name] = tier; }

  /* ── 기능 모듈 (유니티 컴포넌트처럼 리그별로 켜고 끄기 — 끄면 화면만 숨고 데이터는 보존) ── */
  const FEATURE_DEFS = [
    { key: "board", label: "팀 편성",      desc: "팀 관리 — 인원·코인(포인트)·트레이드 + 팀 순위표" },
    { key: "skill", label: "스킬 관리",    desc: "스킬 티어 설정 · 팀 스킬 보유/구매 · 경기 스킬 기록" },
    { key: "draft", label: "경매 드래프트", desc: "코인 경매로 로스터 구성 (자동 진행 툴)" },
  ];
  /* 켜짐 판정 — features가 없는 옛 리그는 전부 켜진 것으로 취급 */
  const featOn = (league, key) => !league.features || league.features[key] !== false;

  /* ── 리그 규칙 기본값 (config — 전부 리그별 수정 가능) ── */
  const CONFIG_DEFAULT = {
    win: 30, lose: 30, draw: 0,                       // 기본 승/패/무 포인트
    underdogGap: 500,                                 // 4인 MMR 합 차이 기준
    udWin: 40, udLose: 20,                            // 언더독(약팀) 승/패
    udStrongWin: 20, udStrongLose: 40,                // 강팀 승/패
    salaryCap: 90,                                    // 출전 4인 급여 상한 (팀별 +cap_bonus)
    rosterCap: { total: 9, hi: 4, lo: 7, skill: 13 }, // 총원(감독 포함)/S~A-/B+~C-/스킬 소유
    skillCap: { S: 2, A: 4, B: 4, C: 4 },             // 티어별 스킬 소유 상한 (기획안 3-3·4-3)
    skillPrice: { S: 50, A: 30, B: 20, C: 10 },       // 시즌 중 스킬 구매 가격
    auctionLimit: { S: 2, A: 2, B: 6, C: 6 },         // 경매 팀당 티어별 획득 상한 (감독 제외)
    coinR1: 200, coinR2: 200, coinCarry: true,        // 드래프트 라운드별 지급 코인 / 잔여 이월 (기획안 3-2)
    gaugePerUse: 5,                                   // 벤/리로드 게이지 5개 = 1회 사용 (기획안 4-3)
    dormancyPenalty: 200,                             // 휴면 강등 -200p (M2)
    positions: ["공격", "미드", "수비"],               // 주 포지션 선택지
    showCoinsPublic: true,                            // 공개 팀 순위에 코인 노출 (확정: 노출)
  };

  /* ── 새 리그 상태 팩토리 (data/league-<id>.json 의 초기 모양) ── */
  function newLeague(id, name, start, end) {
    const tiers = {};
    for (const t of TIER_ORDER) tiers[t] = { ...TIER_DEFAULT[t] };
    return {
      rev: 1,                                  // 저장 충돌 감지용 (PUT마다 +1)
      id, name: name || "새 리그",
      start: start || "", end: end || "",      // 기간 — 진행 중에도 수정 가능
      status: "active",                        // active | archived
      createdAt: new Date().toISOString(),
      features: { board: true, skill: true, draft: true },
      config: JSON.parse(JSON.stringify(CONFIG_DEFAULT)),
      tiers,                                   // 티어별 {mmr(스타트), sal, cap}
      skillTier: { ...SKILL_TIER_DEFAULT },    // 스킬명 → S/A/B/C (리그별)
      players: [],  // {id, userId, name, tier, initialTier, pos, team, price, round, promoCredited, active}
      teams: [],    // {id, name, coach, managerId, color, coins, gauge, salaryCap, promoCount, skills:[], active}
      draft: { started: false, done: false, round: 1, queue: [], poolR2: [], log: [] },
      matches: [],  // {id, date, week, type, red:{team,name,players,skills}, blue:{...}, result}
      adjusts: [],  // mmr_adjust: {id, playerId, delta, reason, at(date)} — 재계산 시 경기와 시간순 리플레이
      ledger: [],   // 통합 거래 내역(coin/gauge/trade/roster/draft/skill) {id, type, at, text, undoOf?}
      approvals: [],// 자동 제안 처리 이력 {id, key, type, status:approved|rejected, reason, at} — 재제안 방지
      weekly: [],   // 주간 갱신 이력 (M2)
      seq: { player: 1, team: 1, match: 1, adjust: 1, ledger: 1, approval: 1 },
    };
  }

  /* ══════════ 계산부 ══════════ */

  /* 주차: 리그 시작일이 속한 주(월요일 시작)가 1주차 */
  function weekOf(league, dateStr) {
    if (!league.start || !dateStr) return 1;
    const monday = d => {
      const dt = new Date(d + "T00:00:00");
      dt.setDate(dt.getDate() - (dt.getDay() + 6) % 7);
      return dt.getTime();
    };
    return Math.max(1, Math.floor((monday(dateStr) - monday(league.start)) / 604800000) + 1);
  }

  /* 전체 재계산 — 경기 + mmr_adjust 이벤트를 시간순으로 리플레이.
   * 베이스 MMR = 최초 배치 티어(initialTier)의 스타트 값.
   * 같은 날짜에서는 조정(휴면·보정)이 경기보다 먼저 적용된다. */
  function recalc(L) {
    const mmr = {};
    for (const p of L.players)
      if (p.initialTier && L.tiers[p.initialTier]) mmr[p.id] = L.tiers[p.initialTier].mmr;

    const events = [];
    for (const m of L.matches) events.push({ date: m.date || "", order: 1, seq: m.id, match: m });
    for (const a of L.adjusts) events.push({ date: a.at || "", order: 0, seq: a.id, adjust: a });
    events.sort((x, y) =>
      x.date < y.date ? -1 : x.date > y.date ? 1 : (x.order - y.order) || (x.seq - y.seq));

    const matchCalc = {};   // matchId → {rs, bs, und, delta:{pid}, after:{pid}}
    const records = {};     // pid → {w, d, l}
    const c = L.config;
    for (const ev of events) {
      if (ev.adjust) {
        const a = ev.adjust;
        if (mmr[a.playerId] != null) mmr[a.playerId] += a.delta;
        continue;
      }
      const m = ev.match;
      const sum = s => m[s].players.reduce((t, id) => t + (mmr[id] ?? 0), 0);
      const rs = sum("red"), bs = sum("blue");
      const und = Math.abs(rs - bs) >= c.underdogGap ? (rs < bs ? "red" : "blue") : null;
      const mc = { rs, bs, und, delta: {}, after: {} };
      for (const s of ["red", "blue"]) {
        const draw = m.result === "draw", win = m.result === s;
        const loan = new Set(m[s].loan || []);   // 임대 출전 (기획안 6-1)
        let d = draw ? (c.draw || 0) : win ? c.win : -c.lose;
        if (und && !draw) d = (s === und) ? (win ? c.udWin : -c.udLose)
                                          : (win ? c.udStrongWin : -c.udStrongLose);
        for (const id of m[s].players) {
          // 임대는 랭크 시스템 미적용 — MMR·전적 모두 건드리지 않는다 (출전 기록은 경기에 남음)
          if (loan.has(id)) { mc.delta[id] = 0; mc.after[id] = mmr[id] ?? null; continue; }
          if (mmr[id] != null) mmr[id] += d;
          mc.delta[id] = d;
          mc.after[id] = mmr[id] ?? null;
          const r = records[id] || (records[id] = { w: 0, d: 0, l: 0 });
          if (draw) r.d++; else if (win) r.w++; else r.l++;
        }
      }
      matchCalc[m.id] = mc;
    }
    return { mmr, matchCalc, records };
  }

  /* TOP RATE — MMR 내림차순, 동점: 승수 → 승률 → 이름 가나다 */
  function rankings(L, calc) {
    const rec = id => calc.records[id] || { w: 0, d: 0, l: 0 };
    const rate = r => { const n = r.w + r.d + r.l; return n ? r.w / n : 0; };
    return L.players
      .filter(p => p.active !== false && p.tier && calc.mmr[p.id] != null)
      .sort((a, b) => {
        const d = calc.mmr[b.id] - calc.mmr[a.id]; if (d) return d;
        const ra = rec(a.id), rb = rec(b.id);
        if (rb.w !== ra.w) return rb.w - ra.w;
        if (rate(rb) !== rate(ra)) return rate(rb) - rate(ra);
        return a.name.localeCompare(b.name, "ko");
      });
  }

  /* 팀 순위 — 리그 유형 경기만. 동률: 승점 → 다승 → 승자승 → 팀명 가나다 */
  function standings(L, calc, maxWeek) {
    const rows = L.teams.filter(t => t.active !== false)
      .map(t => ({ t, w: 0, d: 0, l: 0, pts: 0 }));
    const by = {}; rows.forEach(r => { by[r.t.id] = r; });
    const h2h = {};   // "승팀:패팀" → 승수
    for (const m of L.matches) {
      if (m.type !== "리그") continue;
      if (maxWeek != null && (m.week || 1) > maxWeek) continue;   // 주간 보상 산정용 누적 순위
      const R = by[m.red.team], B = by[m.blue.team];
      if (!R || !B) continue;
      if (m.result === "draw") { R.d++; B.d++; }
      else {
        const [win, lose] = m.result === "red" ? [R, B] : [B, R];
        win.w++; lose.l++;
        const k = `${win.t.id}:${lose.t.id}`;
        h2h[k] = (h2h[k] || 0) + 1;
      }
    }
    rows.forEach(r => { r.pts = r.w * 3 + r.d; });
    rows.sort((a, b) =>
      b.pts - a.pts || b.w - a.w ||
      ((h2h[`${b.t.id}:${a.t.id}`] || 0) - (h2h[`${a.t.id}:${b.t.id}`] || 0)) ||
      a.t.name.localeCompare(b.t.name, "ko"));
    return rows;
  }

  /* ══════════ 자동 제안 (관리자 승인/거절 대기함) ══════════
   * 규칙상 자동으로 판정 가능한 것들을 감지해 제안으로 내놓는다. 시스템이 바로 반영하지 않고
   * 관리자가 승인해야 적용되며, 거절하면 사유와 함께 기록에 남고 다시 뜨지 않는다.
   * 판정이 애매한 규칙(휴면 등)도 관리자가 보고 거르면 되므로 이 구조로 흡수한다. */
  const capOfTeam = (L, t) => t.salaryCap ?? (L.config.salaryCap + (t.capBonus || 0));

  function proposals(L) {
    const out = [];
    const decided = new Set((L.approvals || []).map(a => a.key));
    const c = L.config;
    const teams = L.teams.filter(t => t.active !== false);
    const P = id => L.players.find(p => p.id === id);
    const add = o => { if (!decided.has(o.key)) out.push(o); };

    /* ① 임대 정산 — 임대 보낸 팀에 경기 1회당 게이지 1개 (기획안 5-2·6-1) */
    for (const m of L.matches)
      for (const s of ["red", "blue"])
        for (const id of (m[s].loan || [])) {
          const p = P(id); if (!p || p.team == null) continue;
          const t = L.teams.find(x => x.id === p.team); if (!t) continue;
          add({ key: `loan:${m.id}:${id}`, type: "gauge", teamId: t.id,
            title: `${t.name} · 임대 정산`,
            detail: `${p.date || m.date || ""} ${p.name} 임대 출전 → 벤/리로드 게이지 +1`,
            effect: { gauge: 1 } });
        }

    /* ② 승격 보상 — 최초 배치 티어보다 올라간 선수, 선수당 평생 1회 적립 (기획안 4-2) */
    for (const p of L.players) {
      if (p.active === false || !p.tier || !p.initialTier || p.promoCredited || p.team == null) continue;
      if (TIER_ORDER.indexOf(p.tier) >= TIER_ORDER.indexOf(p.initialTier)) continue;
      const t = L.teams.find(x => x.id === p.team); if (!t) continue;
      const n = (t.promoCount || 0) + 1;
      add({ key: `promo:${p.id}`, type: "promo", teamId: t.id, playerId: p.id,
        title: `${t.name} · 승격 적립`,
        detail: `${p.name} ${p.initialTier} → ${p.tier} 승격 · ${t.name} ${n}번째 적립` +
          (n % 2 === 0 ? ` → 2명 채움, 급여 상한 +5` : ` (2명 채우면 +5)`),
        effect: { promo: 1 } });
    }

    /* ③ 주간 순위 보상 — 끝난 주차마다 통합 순위로 게이지 (기획안 5-1: 1위 1개 ~ 4위 4개) */
    const weeks = [...new Set(L.matches.filter(m => m.type === "리그").map(m => m.week || 1))].sort((a, b) => a - b);
    const lastWeek = weeks[weeks.length - 1];
    for (const w of weeks) {
      if (w >= lastWeek) continue;                 // 진행 중인 마지막 주차는 아직 끝나지 않은 것으로 본다
      standings(L, null, w).forEach((row, i) => {
        add({ key: `weekly:${w}:${row.t.id}`, type: "gauge", teamId: row.t.id,
          title: `${row.t.name} · ${w}주차 순위 보상`,
          detail: `${w}주차까지 통합 ${i + 1}위 (승점 ${row.pts}) → 게이지 +${i + 1}`,
          effect: { gauge: i + 1 } });
      });
    }

    /* ④ 휴면 강등 — 구간 내 출전 0회면 -200p (기획안 4-2)
     * 판정 시점: 1~3주차분은 4주차 경기가 생긴 뒤, 4~5주차분은 5주차를 넘어선 뒤 */
    const played = {};   // playerId → Set(week)
    for (const m of L.matches)
      for (const s of ["red", "blue"])
        for (const id of m[s].players) (played[id] = played[id] || new Set()).add(m.week || 1);
    for (const [label, ws, after] of [["1~3주차", [1, 2, 3], 4], ["4~5주차", [4, 5], 6]]) {
      if (!lastWeek || lastWeek < after) continue;
      for (const p of L.players) {
        if (p.active === false || !p.tier) continue;
        const seen = played[p.id];
        if (seen && ws.some(w => seen.has(w))) continue;              // 한 번이라도 나왔으면 면제
        if (p.joinWeek && p.joinWeek > ws[0]) continue;               // 중간 등록자는 이전 구간 면제
        add({ key: `dormant:${p.id}:${label}`, type: "mmr", playerId: p.id,
          title: `${p.name} · 휴면 강등`,
          detail: `${label} 출전 0회 → MMR ${-(c.dormancyPenalty || 200)}p`,
          effect: { mmr: -(c.dormancyPenalty || 200) } });
      }
    }
    return out;
  }

  return {
    TIER_ORDER, TIER_DEFAULT, HI_TIERS, PRO_TIERS, AMA_TIERS, groupOf, capOfTeam, proposals,
    SKILL_MASTER, SKILL_ICON, SKILL_TIER_DEFAULT,
    FEATURE_DEFS, featOn,
    CONFIG_DEFAULT, newLeague,
    weekOf, recalc, rankings, standings,
  };
});
