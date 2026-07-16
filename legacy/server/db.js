// 초축 리그 MMR 시스템 — DB 초기화·시드 (node:sqlite, 의존성 없음)
'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.CHOCHUK_DB || path.join(DATA_DIR, 'league.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tier (
  code TEXT PRIMARY KEY,          -- S, A+, A, A-, B+, B, B-, C+, C, C-
  ord INTEGER NOT NULL,           -- 1(S) ~ 10(C-)
  mmr_initial INTEGER NOT NULL,
  salary INTEGER NOT NULL,
  threshold INTEGER NOT NULL,     -- 이상 승급/미만 강등 기준값 (S는 유지선)
  capacity INTEGER                -- NULL = 정원 없음
);
CREATE TABLE IF NOT EXISTS team (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  manager TEXT,                           -- 감독
  coach TEXT,                             -- 코치
  cap_bonus INTEGER NOT NULL DEFAULT 0,   -- 승격 보상 누적 (0~15)
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS player (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  team_id INTEGER REFERENCES team(id),
  tier TEXT NOT NULL REFERENCES tier(code),
  initial_tier TEXT NOT NULL REFERENCES tier(code),
  mmr_live INTEGER NOT NULL,      -- 재계산 파생값
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS match (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'league',    -- league | amateur | pro
  week INTEGER NOT NULL DEFAULT 1,
  played_at TEXT NOT NULL,                -- YYYY-MM-DD
  day_seq INTEGER NOT NULL DEFAULT 1,     -- 당일 경기 순번
  red_team_id INTEGER REFERENCES team(id),
  blue_team_id INTEGER REFERENCES team(id),
  red_name TEXT,                          -- 아마추어/프로 등 임시 팀명
  blue_name TEXT,
  red_score INTEGER NOT NULL,
  blue_score INTEGER NOT NULL,
  result TEXT NOT NULL,                   -- red | blue | draw (파생)
  underdog_side TEXT,                     -- red | blue | NULL (파생)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS match_player (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES player(id),
  side TEXT NOT NULL,             -- red | blue
  goal INTEGER NOT NULL DEFAULT 0,
  assist INTEGER NOT NULL DEFAULT 0,
  touch INTEGER NOT NULL DEFAULT 0,
  pass INTEGER NOT NULL DEFAULT 0,
  defense INTEGER NOT NULL DEFAULT 0,
  duel INTEGER NOT NULL DEFAULT 0,
  turnover INTEGER NOT NULL DEFAULT 0,
  activity INTEGER NOT NULL DEFAULT 0,
  is_mom INTEGER NOT NULL DEFAULT 0,
  is_defense_king INTEGER NOT NULL DEFAULT 0,  -- 파생
  mmr_before INTEGER NOT NULL DEFAULT 0,       -- 파생
  mmr_delta INTEGER NOT NULL DEFAULT 0,        -- 파생
  mmr_after INTEGER NOT NULL DEFAULT 0,        -- 파생
  UNIQUE(match_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_mp_match ON match_player(match_id);
CREATE INDEX IF NOT EXISTS idx_mp_player ON match_player(player_id);
`;

// 티어: 코드, 순서, 초기 MMR, 급여, 승강 기준값, 정원 (PRD 4.2/4.4)
const TIERS = [
  ['S',  1, 3300, 30, 3200, 8],
  ['A+', 2, 3100, 25, 3000, null],
  ['A',  3, 3000, 25, 2900, null],
  ['A-', 4, 2900, 25, 2800, null],
  ['B+', 5, 2700, 20, 2600, 6],
  ['B',  6, 2600, 20, 2500, 6],
  ['B-', 7, 2500, 20, 2400, 6],
  ['C+', 8, 2300, 15, 2200, 6],
  ['C',  9, 2200, 15, 2100, 6],
  ['C-', 10, 2100, 15, 2000, 6],
];

// 초기 배치 45명 (PRD 부록 A)
const PLAYERS = {
  'S':  ['릴리', '쿼스크', '말환', '갈비', '버질', '햄식', '올피', '소금빵'],
  'A+': ['피를로', '아지', '창모', '플메'],
  'A':  ['정이', '도렌누', '조율'],
  'A-': ['스노윙'],
  'B+': ['수아', '다홍매', '라이브', '엑고', '흐뭄', '팡질'],
  'B':  ['치킨', '바운드', '응깃', '배드윌', '티벗', '쥬지'],
  'B-': ['한동숙', '삼식', '느타리', '민수'],
  'C+': ['쵸비', '던파', '킬비', '광어', '캬아아', '오메가'],
  'C':  ['노', '일섹', '고래'],
  'C-': ['민물고기', '구드론', '다스', '시아'],
};

// 규칙 상수 — 전부 설정값 (PRD 원칙)
const CONFIG = {
  win_pts: '30',
  lose_pts: '30',
  draw_pts: '0',
  underdog_gap: '500',
  underdog_win: '40',      // 약팀 승리
  underdog_lose: '20',     // 약팀 패배
  favorite_win: '20',      // 강팀 승리
  favorite_lose: '40',     // 강팀 패배
  salary_cap: '90',
  salary_penalty_step: '5',   // 초과 5점당
  salary_penalty_goals: '5',  // -5골
  season_name: '2026 썸머리그',
};

function open() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  seed(db);
  return db;
}

// 기존 DB에 새 컬럼 반영 (파일 삭제 없이 업그레이드)
function migrate(db) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('team')").all().map(r => r.name);
  if (!cols.includes('manager')) db.exec('ALTER TABLE team ADD COLUMN manager TEXT');
  if (!cols.includes('coach')) db.exec('ALTER TABLE team ADD COLUMN coach TEXT');
}

function seed(db) {
  const nTiers = db.prepare('SELECT COUNT(*) c FROM tier').get().c;
  if (nTiers === 0) {
    const ins = db.prepare('INSERT INTO tier(code, ord, mmr_initial, salary, threshold, capacity) VALUES(?,?,?,?,?,?)');
    for (const t of TIERS) ins.run(...t);
  }
  const nPlayers = db.prepare('SELECT COUNT(*) c FROM player').get().c;
  if (nPlayers === 0) {
    const mmr = {};
    for (const [code, , m] of TIERS) mmr[code] = m;
    const ins = db.prepare('INSERT INTO player(name, tier, initial_tier, mmr_live) VALUES(?,?,?,?)');
    for (const [tier, names] of Object.entries(PLAYERS))
      for (const name of names) ins.run(name, tier, tier, mmr[tier]);
  }
  const get = db.prepare('SELECT value FROM config WHERE key = ?');
  const ins = db.prepare('INSERT INTO config(key, value) VALUES(?,?)');
  for (const [k, v] of Object.entries(CONFIG))
    if (!get.get(k)) ins.run(k, v);
}

function getConfig(db) {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const cfg = {};
  for (const r of rows) cfg[r.key] = isNaN(Number(r.value)) ? r.value : Number(r.value);
  return cfg;
}

module.exports = { open, getConfig, DB_PATH };
