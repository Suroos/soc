/* JSON 파일 스토어 — 원자적 쓰기(tmp→rename) + 자동 스냅샷
 *   data/system.json      관리자 계정 + 전역 유저 풀
 *   data/league-<id>.json 리그 하나의 전체 상태
 *   data/backups/         저장 직전 파일 스냅샷 (파일당 최근 20개, 60초 스로틀) */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const Engine = require("../public/engine.js");

const DATA_DIR = path.join(__dirname, "..", "data");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const KEEP_SNAPSHOTS = 20;
const SNAPSHOT_THROTTLE_MS = 60_000;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const lastSnapshotAt = new Map();   // 파일명 → 마지막 스냅샷 시각

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;   // 파싱 실패 = 파일 손상 — 덮어쓰지 말고 즉시 알아야 함
  }
}

/* 저장 직전의 "현재 파일"을 백업해 두고, 임시 파일에 쓴 뒤 rename으로 교체 */
function writeAtomic(file, obj) {
  snapshot(file);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), "utf8");
  fs.renameSync(tmp, file);   // Windows에서도 기존 파일 원자적 교체
}

function snapshot(file) {
  if (!fs.existsSync(file)) return;
  const now = Date.now();
  if (now - (lastSnapshotAt.get(file) || 0) < SNAPSHOT_THROTTLE_MS) return;
  lastSnapshotAt.set(file, now);
  const base = path.basename(file, ".json");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(file, path.join(BACKUP_DIR, `${base}.${stamp}.json`));
  // 오래된 스냅샷 정리 (파일별 최근 KEEP_SNAPSHOTS개)
  const olds = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith(base + "."))
    .sort();
  for (const f of olds.slice(0, Math.max(0, olds.length - KEEP_SNAPSHOTS)))
    fs.unlinkSync(path.join(BACKUP_DIR, f));
}

/* ── system.json ── */
const SYSTEM_FILE = path.join(DATA_DIR, "system.json");

function loadSystem() {
  return readJSON(SYSTEM_FILE, {
    rev: 1,
    adminHash: null,       // 최초 설정 전
    adminSalt: null,
    users: [],             // 전역 유저 풀 {id, name, createdAt}
    seq: { user: 1, league: 1 },
  });
}
function saveSystem(sys) {
  sys.rev = (sys.rev || 0) + 1;
  writeAtomic(SYSTEM_FILE, sys);
}

/* ── league-<id>.json ── */
const leagueFile = id => path.join(DATA_DIR, `league-${id}.json`);

function listLeagues() {
  return fs.readdirSync(DATA_DIR)
    .filter(f => /^league-\d+\.json$/.test(f))
    .map(f => readJSON(path.join(DATA_DIR, f), null))
    .filter(Boolean)
    .map(l => ({ id: l.id, name: l.name, start: l.start, end: l.end, status: l.status, createdAt: l.createdAt }))
    .sort((a, b) => b.id - a.id);
}
function loadLeague(id) {
  return readJSON(leagueFile(id), null);
}
function saveLeague(league) {
  writeAtomic(leagueFile(league.id), league);
}
function deleteLeague(id) {
  const file = leagueFile(id);
  if (!fs.existsSync(file)) return false;
  lastSnapshotAt.delete(file);   // 스로틀 무시 — 삭제 직전 상태를 반드시 남긴다
  snapshot(file);
  fs.unlinkSync(file);
  return true;
}
function createLeague(sys, name, start, end) {
  const id = sys.seq.league++;
  const league = Engine.newLeague(id, name, start, end);
  saveLeague(league);
  saveSystem(sys);
  return league;
}

module.exports = {
  DATA_DIR, BACKUP_DIR,
  loadSystem, saveSystem,
  listLeagues, loadLeague, saveLeague, createLeague, deleteLeague,
};
