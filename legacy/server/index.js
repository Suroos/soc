// 초축 리그 MMR 시스템 — 서버 (node:http, 의존성 없음)
// 실행: node server/index.js  (기본 포트 3300, PORT 환경변수로 변경)
'use strict';
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { open, getConfig } = require('./db');
const { recalcAll, salaryPenalty } = require('./mmr');

const db = open();
const PORT = Number(process.env.PORT) || 3300;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ── 관리자 인증 ─────────────────────────────────────────────
// 비밀번호: config 테이블 admin_password (기본 admin1234 — 반드시 변경)
if (!db.prepare("SELECT 1 FROM config WHERE key='admin_password'").get())
  db.prepare("INSERT INTO config(key, value) VALUES('admin_password', 'admin1234')").run();

const sessions = new Map(); // token → expiry(ms)
function isAuthed(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const exp = sessions.get(m[1]);
  if (!exp || exp < Date.now()) { sessions.delete(m[1]); return false; }
  return true;
}

// ── 유틸 ────────────────────────────────────────────────────
function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

// ── 조회 쿼리 ───────────────────────────────────────────────
function currentWeek() {
  const r = db.prepare('SELECT MAX(week) w FROM match').get();
  return r.w || 1;
}

function rankings() {
  const week = currentWeek();
  return db.prepare(`
    SELECT p.id, p.name, p.tier, p.mmr_live, p.active, tm.name AS team,
      t.ord AS tier_ord, t.salary,
      (SELECT COUNT(*) FROM match_player mp JOIN match m ON m.id=mp.match_id
        WHERE mp.player_id=p.id) AS games,
      (SELECT COUNT(*) FROM match_player mp JOIN match m ON m.id=mp.match_id
        WHERE mp.player_id=p.id AND m.result=mp.side) AS wins,
      (SELECT COUNT(*) FROM match_player mp JOIN match m ON m.id=mp.match_id
        WHERE mp.player_id=p.id AND m.result='draw') AS draws,
      COALESCE((SELECT SUM(mp.mmr_delta) FROM match_player mp JOIN match m ON m.id=mp.match_id
        WHERE mp.player_id=p.id AND m.week=?), 0) AS week_delta
    FROM player p
    JOIN tier t ON t.code = p.tier
    LEFT JOIN team tm ON tm.id = p.team_id
    WHERE p.active = 1
    ORDER BY p.mmr_live DESC, t.ord ASC, p.name ASC`).all(week)
    .map((r, i) => ({ ...r, rank: i + 1, losses: r.games - r.wins - r.draws }));
}

function teamStandings() {
  const teams = db.prepare('SELECT * FROM team WHERE active=1').all();
  const rows = db.prepare(`SELECT * FROM match WHERE type='league'`).all();
  const S = new Map(teams.map(t => [t.id, { id: t.id, name: t.name, manager: t.manager, coach: t.coach, games: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 }]));
  for (const m of rows) {
    for (const side of ['red', 'blue']) {
      const tid = side === 'red' ? m.red_team_id : m.blue_team_id;
      const st = S.get(tid);
      if (!st) continue;
      const gf = side === 'red' ? m.red_score : m.blue_score;
      const ga = side === 'red' ? m.blue_score : m.red_score;
      st.games++; st.gf += gf; st.ga += ga;
      if (m.result === 'draw') st.d++;
      else if (m.result === side) st.w++;
      else st.l++;
    }
  }
  return [...S.values()]
    .map(s => ({ ...s, pts: s.w * 3 + s.d, gd: s.gf - s.ga }))
    .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.name.localeCompare(b.name, 'ko'))
    .map((s, i) => ({ ...s, rank: i + 1 }));
}

function matchList(q) {
  let sql = `
    SELECT m.*, tr.name AS red_team, tb.name AS blue_team,
      (SELECT COALESCE(SUM(mp.mmr_delta),0) FROM match_player mp WHERE mp.match_id=m.id AND mp.side='red') AS red_delta_sum,
      (SELECT mp.mmr_delta FROM match_player mp WHERE mp.match_id=m.id AND mp.side='red' LIMIT 1) AS red_delta,
      (SELECT mp.mmr_delta FROM match_player mp WHERE mp.match_id=m.id AND mp.side='blue' LIMIT 1) AS blue_delta
    FROM match m
    LEFT JOIN team tr ON tr.id = m.red_team_id
    LEFT JOIN team tb ON tb.id = m.blue_team_id`;
  const cond = [], args = [];
  if (q.type) { cond.push('m.type=?'); args.push(q.type); }
  if (q.week) { cond.push('m.week=?'); args.push(Number(q.week)); }
  if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
  sql += ' ORDER BY m.played_at DESC, m.day_seq DESC, m.id DESC LIMIT 200';
  return db.prepare(sql).all(...args);
}

function matchDetail(id) {
  const m = db.prepare(`
    SELECT m.*, tr.name AS red_team, tb.name AS blue_team FROM match m
    LEFT JOIN team tr ON tr.id=m.red_team_id LEFT JOIN team tb ON tb.id=m.blue_team_id
    WHERE m.id=?`).get(id);
  if (!m) return null;
  m.players = db.prepare(`
    SELECT mp.*, p.name, p.tier FROM match_player mp
    JOIN player p ON p.id = mp.player_id WHERE mp.match_id=? ORDER BY mp.side, mp.id`).all(id);
  return m;
}

const STATS = ['goal', 'assist', 'touch', 'pass', 'defense', 'duel', 'turnover', 'activity'];

function playerDetail(id) {
  const p = db.prepare(`
    SELECT p.*, t.salary, tm.name AS team FROM player p
    JOIN tier t ON t.code=p.tier LEFT JOIN team tm ON tm.id=p.team_id WHERE p.id=?`).get(id);
  if (!p) return null;

  const rows = db.prepare(`
    SELECT mp.*, m.played_at, m.day_seq, m.week, m.type, m.result, m.underdog_side,
      m.red_score, m.blue_score,
      tr.name AS red_team, tb.name AS blue_team
    FROM match_player mp JOIN match m ON m.id=mp.match_id
    LEFT JOIN team tr ON tr.id=m.red_team_id LEFT JOIN team tb ON tb.id=m.blue_team_id
    WHERE mp.player_id=? ORDER BY m.played_at, m.day_seq, m.id`).all(id);

  const rec = { games: rows.length, wins: 0, draws: 0, losses: 0 };
  const tot = Object.fromEntries(STATS.map(s => [s, 0]));
  let mom = 0, king = 0;
  for (const r of rows) {
    if (r.result === 'draw') rec.draws++;
    else if (r.result === r.side) rec.wins++;
    else rec.losses++;
    for (const s of STATS) tot[s] += r[s];
    mom += r.is_mom; king += r.is_defense_king;
  }
  const avg = Object.fromEntries(STATS.map(s => [s, rec.games ? tot[s] / rec.games : 0]));

  // 육각형 스텟 (PRD 4.5 — 엑셀 '그래프' 시트 방식): 경기 1회 이상 선수 집단 내 min-max
  const radar = hexStats(id);

  return {
    ...p, record: rec, totals: tot, averages: avg, mom, defense_king: king,
    radar,
    history: rows.map(r => ({
      match_id: r.match_id, played_at: r.played_at, week: r.week, type: r.type,
      side: r.side, result: r.result, underdog_side: r.underdog_side,
      red_team: r.red_team, blue_team: r.blue_team,
      red_score: r.red_score, blue_score: r.blue_score,
      goal: r.goal, assist: r.assist, is_mom: r.is_mom, is_defense_king: r.is_defense_king,
      mmr_before: r.mmr_before, mmr_delta: r.mmr_delta, mmr_after: r.mmr_after,
    })),
  };
}

function hexStats(playerId) {
  // 축: 공포(골+어시) / 효율성((골×7+어시+패스)÷터치) / 볼경합 / 터치 / 수비 / 턴오버비율(역산)
  const all = db.prepare(`
    SELECT mp.player_id,
      COUNT(*) g,
      AVG(mp.goal) ag, AVG(mp.assist) aa, AVG(mp.pass) ap, AVG(mp.touch) atch,
      AVG(mp.defense) ad, AVG(mp.duel) adu, AVG(mp.turnover) ato
    FROM match_player mp GROUP BY mp.player_id`).all();
  if (!all.length) return null;
  const calc = r => ({
    attack: r.ag + r.aa,
    efficiency: r.atch > 0 ? (r.ag * 7 + r.aa + r.ap) / r.atch : 0,
    duel: r.adu,
    touch: r.atch,
    defense: r.ad,
    turnover_rate: r.atch > 0 ? r.ato / r.atch : 0,
  });
  const values = all.map(r => ({ id: r.player_id, v: calc(r) }));
  const me = values.find(v => v.id === playerId);
  if (!me) return null;
  const axes = ['attack', 'efficiency', 'duel', 'touch', 'defense', 'turnover_rate'];
  const norm = {};
  for (const a of axes) {
    const vs = values.map(x => x.v[a]);
    const mn = Math.min(...vs), mx = Math.max(...vs);
    let n = mx > mn ? (me.v[a] - mn) / (mx - mn) : 0.5;
    if (a === 'turnover_rate') n = 1 - n; // 역산: 낮을수록 넓게
    norm[a] = Math.round(n * 100) / 100;
  }
  return { raw: me.v, norm };
}

// ── 경기 저장 검증 (PRD 4.3) ─────────────────────────────────
function validateMatch(body) {
  const warnings = [];
  const cfg = getConfig(db);
  const sides = { red: [], blue: [] };
  for (const r of body.players || []) (sides[r.side] || []).push(r);

  for (const side of ['red', 'blue']) {
    const ids = sides[side].map(r => r.player_id);
    if (ids.length !== 4) warnings.push(`${side === 'red' ? '레드' : '블루'} 출전 선수가 ${ids.length}명입니다 (기본 4명)`);
    if (ids.length) {
      const pen = salaryPenalty(db, ids);
      if (pen.goals > 0)
        warnings.push(`${side === 'red' ? '레드' : '블루'} 급여 합 ${pen.total} > 상한 ${pen.cap} → 경기 시작 시 -${pen.goals}골 패널티`);
      // 경기 유형 자격 (아마추어 B~C- / 프로 S~B+)
      if (body.type === 'amateur' || body.type === 'pro') {
        const q = db.prepare(`SELECT p.name, t.ord FROM player p JOIN tier t ON t.code=p.tier
          WHERE p.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
        for (const row of q) {
          if (body.type === 'amateur' && row.ord < 6) warnings.push(`아마추어 자격 위반: ${row.name} (B~C-만 참여 가능)`);
          if (body.type === 'pro' && row.ord > 5) warnings.push(`프로 자격 위반: ${row.name} (S~B+만 참여 가능)`);
        }
      }
      const goalSum = sides[side].reduce((s, r) => s + (Number(r.goal) || 0), 0);
      const score = side === 'red' ? Number(body.red_score) : Number(body.blue_score);
      if (goalSum > score) warnings.push(`${side === 'red' ? '레드' : '블루'} 선수 골 합계(${goalSum})가 팀 득점(${score})보다 큽니다`);
    }
  }
  const dup = (body.players || []).map(r => r.player_id);
  if (new Set(dup).size !== dup.length) warnings.push('같은 선수가 중복 출전으로 입력됐습니다');
  return warnings;
}

function saveMatch(body, existingId) {
  const ins = db.prepare(`
    INSERT INTO match(type, week, played_at, day_seq, red_team_id, blue_team_id,
      red_name, blue_name, red_score, blue_score, result)
    VALUES(?,?,?,?,?,?,?,?,?,?, '')`);
  db.exec('BEGIN');
  try {
    if (existingId) {
      db.prepare('DELETE FROM match_player WHERE match_id=?').run(existingId);
      db.prepare(`UPDATE match SET type=?, week=?, played_at=?, day_seq=?, red_team_id=?, blue_team_id=?,
        red_name=?, blue_name=?, red_score=?, blue_score=? WHERE id=?`).run(
        body.type, body.week, body.played_at, body.day_seq || 1,
        body.red_team_id || null, body.blue_team_id || null,
        body.red_name || null, body.blue_name || null,
        body.red_score, body.blue_score, existingId);
    } else {
      ins.run(body.type || 'league', body.week || 1, body.played_at, body.day_seq || 1,
        body.red_team_id || null, body.blue_team_id || null,
        body.red_name || null, body.blue_name || null,
        body.red_score, body.blue_score);
    }
    const mid = existingId || db.prepare('SELECT last_insert_rowid() id').get().id;
    const insMp = db.prepare(`
      INSERT INTO match_player(match_id, player_id, side, goal, assist, touch, pass,
        defense, duel, turnover, activity, is_mom)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const r of body.players || []) {
      insMp.run(mid, r.player_id, r.side,
        Number(r.goal) || 0, Number(r.assist) || 0, Number(r.touch) || 0, Number(r.pass) || 0,
        Number(r.defense) || 0, Number(r.duel) || 0, Number(r.turnover) || 0, Number(r.activity) || 0,
        r.is_mom ? 1 : 0);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  recalcAll(db);
  return existingId || db.prepare('SELECT MAX(id) id FROM match').get().id;
}

// ── 라우팅 ──────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) return await api(req, res, p, url);
    return serveStatic(req, res, p);
  } catch (e) {
    console.error(e);
    json(res, 500, { error: '서버 오류: ' + e.message });
  }
});

async function api(req, res, p, url) {
  const seg = p.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  // ── 공개 조회 ──
  if (method === 'GET' && p === '/api/bootstrap') {
    return json(res, 200, {
      season: getConfig(db).season_name,
      week: currentWeek(),
      tiers: db.prepare('SELECT * FROM tier ORDER BY ord').all(),
      teams: db.prepare('SELECT * FROM team WHERE active=1 ORDER BY name').all(),
      players: db.prepare(`SELECT p.id, p.name, p.tier, p.initial_tier, p.team_id, p.mmr_live, t.salary
        FROM player p JOIN tier t ON t.code=p.tier WHERE p.active=1 ORDER BY t.ord, p.name`).all(),
      salary_cap: getConfig(db).salary_cap,
    });
  }
  if (method === 'GET' && p === '/api/rankings') return json(res, 200, rankings());
  if (method === 'GET' && p === '/api/teams') return json(res, 200, teamStandings());
  if (method === 'GET' && p === '/api/matches')
    return json(res, 200, matchList({ type: url.searchParams.get('type'), week: url.searchParams.get('week') }));
  if (method === 'GET' && seg[1] === 'matches' && seg[2]) {
    const m = matchDetail(Number(seg[2]));
    return m ? json(res, 200, m) : json(res, 404, { error: '경기를 찾을 수 없습니다' });
  }
  if (method === 'GET' && seg[1] === 'players' && seg[2]) {
    const d = playerDetail(Number(seg[2]));
    return d ? json(res, 200, d) : json(res, 404, { error: '선수를 찾을 수 없습니다' });
  }

  // ── 로그인 ──
  if (method === 'POST' && p === '/api/login') {
    const body = await readBody(req);
    const pw = db.prepare("SELECT value FROM config WHERE key='admin_password'").get().value;
    if (body.password !== pw) return json(res, 401, { error: '비밀번호가 다릅니다' });
    const token = crypto.randomUUID();
    sessions.set(token, Date.now() + 24 * 3600 * 1000);
    return json(res, 200, { token });
  }

  // ── 이하 관리자 전용 ──
  if (!isAuthed(req)) return json(res, 401, { error: '관리자 로그인이 필요합니다' });

  if (method === 'POST' && p === '/api/salary-check') {
    const body = await readBody(req);
    return json(res, 200, salaryPenalty(db, body.player_ids || []));
  }
  if (method === 'POST' && p === '/api/matches/preview') {
    const body = await readBody(req);
    return json(res, 200, { warnings: validateMatch(body) });
  }
  if (method === 'POST' && p === '/api/matches') {
    const body = await readBody(req);
    const id = saveMatch(body, null);
    return json(res, 200, { id, warnings: validateMatch(body) });
  }
  if (method === 'PUT' && seg[1] === 'matches' && seg[2]) {
    const body = await readBody(req);
    saveMatch(body, Number(seg[2]));
    return json(res, 200, { id: Number(seg[2]) });
  }
  if (method === 'DELETE' && seg[1] === 'matches' && seg[2]) {
    db.prepare('DELETE FROM match WHERE id=?').run(Number(seg[2]));
    recalcAll(db);
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && p === '/api/teams') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!name) return json(res, 400, { error: '팀 이름을 입력해주세요' });
    db.prepare('INSERT INTO team(name, manager, coach) VALUES(?,?,?)')
      .run(name, String(body.manager || '').trim() || null, String(body.coach || '').trim() || null);
    return json(res, 200, { ok: true });
  }
  if (method === 'PUT' && seg[1] === 'teams' && seg[2]) {
    const body = await readBody(req);
    if (body.name) db.prepare('UPDATE team SET name=? WHERE id=?').run(String(body.name).trim(), Number(seg[2]));
    if (body.manager !== undefined) db.prepare('UPDATE team SET manager=? WHERE id=?').run(String(body.manager).trim() || null, Number(seg[2]));
    if (body.coach !== undefined) db.prepare('UPDATE team SET coach=? WHERE id=?').run(String(body.coach).trim() || null, Number(seg[2]));
    if (body.active !== undefined) db.prepare('UPDATE team SET active=? WHERE id=?').run(body.active ? 1 : 0, Number(seg[2]));
    return json(res, 200, { ok: true });
  }
  if (method === 'DELETE' && seg[1] === 'teams' && seg[2]) {
    const id = Number(seg[2]);
    const used = db.prepare('SELECT COUNT(*) c FROM match WHERE red_team_id=? OR blue_team_id=?').get(id, id).c;
    if (used > 0) return json(res, 400, { error: `경기 기록 ${used}개가 있는 팀은 삭제할 수 없습니다 — 경기를 먼저 삭제해주세요` });
    db.prepare('UPDATE player SET team_id=NULL WHERE team_id=?').run(id);
    db.prepare('DELETE FROM team WHERE id=?').run(id);
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && p === '/api/players') {
    const body = await readBody(req);
    const tier = body.tier || 'C-';
    const init = db.prepare('SELECT mmr_initial FROM tier WHERE code=?').get(tier);
    if (!init) return json(res, 400, { error: '잘못된 티어' });
    db.prepare('INSERT INTO player(name, tier, initial_tier, team_id, mmr_live) VALUES(?,?,?,?,?)')
      .run(String(body.name || '').trim(), tier, tier, body.team_id || null, init.mmr_initial);
    recalcAll(db);
    return json(res, 200, { ok: true });
  }
  if (method === 'PUT' && seg[1] === 'players' && seg[2]) {
    const body = await readBody(req);
    const id = Number(seg[2]);
    const cur = db.prepare('SELECT * FROM player WHERE id=?').get(id);
    if (!cur) return json(res, 404, { error: '선수를 찾을 수 없습니다' });
    db.prepare('UPDATE player SET name=?, tier=?, initial_tier=?, team_id=?, active=? WHERE id=?').run(
      body.name ?? cur.name, body.tier ?? cur.tier, body.initial_tier ?? cur.initial_tier,
      body.team_id !== undefined ? body.team_id : cur.team_id,
      body.active !== undefined ? (body.active ? 1 : 0) : cur.active, id);
    recalcAll(db);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: '알 수 없는 API' });
}

function serveStatic(req, res, p) {
  let file = p === '/' ? '/index.html' : p;
  file = path.normalize(file).replace(/^([.][.][/\\])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    // SPA 라우팅: 알 수 없는 경로는 index.html
    const idx = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(idx).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': (MIME[path.extname(full)] || 'application/octet-stream') + '; charset=utf-8' });
  fs.createReadStream(full).pipe(res);
}

recalcAll(db);
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`포트 ${PORT}이(가) 이미 사용 중입니다. 서버가 이미 켜져 있는지 확인하세요 → http://localhost:${PORT}`);
    process.exit(1);
  }
  throw err;
});
server.listen(PORT, () => {
  console.log(`초축 리그 서버 실행 중 → http://localhost:${PORT}`);
  console.log(`관리자 기본 비밀번호: admin1234 (config 테이블에서 변경)`);
});
