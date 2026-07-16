// 초축 리그 MMR 엔진 — 전체 재계산 (PRD 4.4)
// 원본(스코어·출전·티어)에서 언제든 전체 재계산 가능해야 한다는 원칙에 따라,
// 경기 입력/수정/삭제 시마다 처음부터 전부 다시 돌린다. (포인트제 O(n), 수백 경기에 충분)
'use strict';
const { getConfig } = require('./db');

function recalcAll(db) {
  const cfg = getConfig(db);
  const tierInit = {};
  for (const t of db.prepare('SELECT code, mmr_initial FROM tier').all())
    tierInit[t.code] = t.mmr_initial;

  // 1) 전 선수 초기 배치 MMR로 리셋
  const players = db.prepare('SELECT id, initial_tier FROM player').all();
  const mmr = new Map();
  for (const p of players) mmr.set(p.id, tierInit[p.initial_tier]);

  // 2) 경기 시간순 리플레이
  const matches = db.prepare(
    'SELECT * FROM match ORDER BY played_at, day_seq, id').all();
  const rowsOf = db.prepare(
    'SELECT * FROM match_player WHERE match_id = ? ORDER BY side, id');
  const updMp = db.prepare(
    'UPDATE match_player SET mmr_before=?, mmr_delta=?, mmr_after=?, is_defense_king=? WHERE id=?');
  const updMatch = db.prepare(
    'UPDATE match SET result=?, underdog_side=? WHERE id=?');

  for (const m of matches) {
    const rows = rowsOf.all(m.id);
    const result = m.red_score > m.blue_score ? 'red'
                 : m.blue_score > m.red_score ? 'blue' : 'draw';

    const sum = { red: 0, blue: 0 };
    for (const r of rows) sum[r.side] += mmr.get(r.player_id);
    let underdog = null;
    if (rows.length && Math.abs(sum.red - sum.blue) >= cfg.underdog_gap)
      underdog = sum.red < sum.blue ? 'red' : 'blue';

    const maxDef = rows.length ? Math.max(...rows.map(r => r.defense)) : 0;

    for (const r of rows) {
      let delta;
      if (result === 'draw') {
        delta = cfg.draw_pts;
      } else {
        const won = r.side === result;
        if (underdog === null) delta = won ? cfg.win_pts : -cfg.lose_pts;
        else if (r.side === underdog) delta = won ? cfg.underdog_win : -cfg.underdog_lose;
        else delta = won ? cfg.favorite_win : -cfg.favorite_lose;
      }
      const before = mmr.get(r.player_id);
      const after = before + delta;
      mmr.set(r.player_id, after);
      const isKing = (r.defense > 0 && r.defense === maxDef) ? 1 : 0;
      updMp.run(before, delta, after, isKing, r.id);
    }
    updMatch.run(result, underdog, m.id);
  }

  // 3) 파생값 반영
  const updPlayer = db.prepare('UPDATE player SET mmr_live=? WHERE id=?');
  for (const [id, v] of mmr) updPlayer.run(v, id);
}

// 라인업 급여 검증 (PRD 4.6): 초과 5점당 -5골
function salaryPenalty(db, playerIds) {
  const cfg = getConfig(db);
  if (!playerIds.length) return { total: 0, cap: cfg.salary_cap, over: 0, goals: 0 };
  const q = db.prepare(`
    SELECT COALESCE(SUM(t.salary), 0) s FROM player p JOIN tier t ON t.code = p.tier
    WHERE p.id IN (${playerIds.map(() => '?').join(',')})`);
  const total = q.get(...playerIds).s;
  const over = Math.max(0, total - cfg.salary_cap);
  const goals = Math.ceil(over / cfg.salary_penalty_step) * cfg.salary_penalty_goals;
  return { total, cap: cfg.salary_cap, over, goals };
}

module.exports = { recalcAll, salaryPenalty };
