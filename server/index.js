/* 초축 리그 MMR 시스템 — HTTP 서버 (외부 패키지 0개: node:http + node:crypto + JSON 스토어)
 * 실행: node server/index.js  (기본 포트 3300, 환경변수 PORT로 변경)
 * 이전 SQLite 버전은 legacy/server/ 에 보관 */
"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const store = require("./store.js");

const PORT = Number(process.env.PORT) || 3300;
/* 기본은 루프백만 — 외부 공개는 cloudflared 터널을 통해서만 (LAN 평문 접속 차단).
   굳이 LAN에 열려면 HOST=0.0.0.0 으로 실행 (이 경우 프록시 헤더는 신뢰하지 않음) */
const HOST = process.env.HOST || "127.0.0.1";
const TRUST_PROXY = ["127.0.0.1", "::1", "localhost"].includes(HOST);
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PUBLIC_ROOT = PUBLIC_DIR + path.sep;   // 형제 폴더(public.bak 등) 오탐 방지
const MAX_BODY = 5 * 1024 * 1024;           // 리그 상태 전체 PUT 대비 5MB
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12시간

/* ── 비밀번호 (scrypt) ── */
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString("hex");
function verifyPw(sys, pw) {
  if (!sys.adminHash) return false;
  const h = Buffer.from(hashPw(pw, sys.adminSalt), "hex");
  const s = Buffer.from(sys.adminHash, "hex");
  return h.length === s.length && crypto.timingSafeEqual(h, s);
}

/* ── 세션 (메모리 — 재시작 시 재로그인) ── */
const sessions = new Map();   // sid → 만료 시각
function newSession() {
  const sid = crypto.randomBytes(24).toString("hex");
  sessions.set(sid, Date.now() + SESSION_TTL_MS);
  return sid;
}
function getSid(req) {
  return (req.headers.cookie || "").split(";")
    .map(s => s.trim()).find(s => s.startsWith("sid="))?.slice(4);
}
function isAuthed(req) {
  const sid = getSid(req);
  if (!sid) return false;
  const exp = sessions.get(sid);
  if (!exp || exp < Date.now()) { sessions.delete(sid); return false; }
  sessions.set(sid, Date.now() + SESSION_TTL_MS);   // 사용 시 연장
  return true;
}

/* ── 세션 쿠키 ──
   터널(HTTPS) 경유일 때만 Secure — http://localhost 직접 접속에서도 로그인이 되도록 */
function setSessionCookie(req, sid) {
  const proto = TRUST_PROXY
    ? String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim()
    : "";
  const secure = proto === "https" ? "; Secure" : "";
  return { "Set-Cookie": `sid=${sid}; HttpOnly; Path=/; SameSite=Strict${secure}` };
}

/* ── 클라이언트 IP ──
   루프백 바인딩이면 원격 요청은 전부 cloudflared 경유이고, Cloudflare가 엣지에서
   CF-Connecting-IP를 덮어쓰므로 신뢰 가능. HOST를 직접 연 경우엔 소켓 IP만 사용 */
function clientIp(req) {
  if (TRUST_PROXY) {
    const cf = req.headers["cf-connecting-ip"];
    if (cf) return String(cf).trim();
    const xff = req.headers["x-forwarded-for"];
    if (xff) return String(xff).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "?";
}

/* ── 로그인 레이트리밋 (IP당 1분에 5회) ── */
const loginHits = new Map();
function loginAllowed(ip) {
  const now = Date.now();
  for (const [k, v] of loginHits)                       // 만료된 IP 정리 (무한 증가 방지)
    if (!v.length || now - v[v.length - 1] >= 60_000) loginHits.delete(k);
  const hits = (loginHits.get(ip) || []).filter(t => now - t < 60_000);
  hits.push(now);
  loginHits.set(ip, hits);
  return hits.length <= 5;
}

/* ── 응답 헬퍼 ── */
function json(res, code, obj, headers = {}) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}

/* ── 정적 파일 ── */
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
};
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/") rel = "/index.html";
  if (rel === "/admin") rel = "/admin.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_ROOT)) return json(res, 403, { error: "forbidden" });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: "not found" });
    const ext = path.extname(file).toLowerCase();
    /* 앱 코드(html/js/css)는 매번 재검증 — 안 그러면 CDN(Cloudflare)이 몇 시간씩 옛 버전을 서빙해
       admin.html만 갱신되고 engine.js는 옛것인 상태가 생긴다. 이미지·폰트는 길게 캐싱한다. */
    const code = [".html", ".js", ".css", ".json"].includes(ext);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": code ? "no-cache, must-revalidate" : "public, max-age=604800",
    });
    res.end(buf);
  });
}

/* ── API 라우팅 ── */
async function handleApi(req, res, pathname) {
  const sys = store.loadSystem();
  const authed = isAuthed(req);
  const ip = clientIp(req);
  const mLeague = pathname.match(/^\/api\/league\/(\d+)$/);

  // ---- 인증 불필요 ----
  if (req.method === "GET" && pathname === "/api/system") {
    return json(res, 200, {
      needsSetup: !sys.adminHash,
      authed,
      users: sys.users,
      leagues: store.listLeagues(),
    });
  }
  if (req.method === "POST" && pathname === "/api/setup") {
    if (sys.adminHash) return json(res, 409, { error: "이미 설정됨" });
    const { password } = await readBody(req);
    if (!password || password.length < 6) return json(res, 400, { error: "비밀번호는 6자 이상" });
    sys.adminSalt = crypto.randomBytes(16).toString("hex");
    sys.adminHash = hashPw(password, sys.adminSalt);
    store.saveSystem(sys);
    return json(res, 200, { ok: true }, setSessionCookie(req, newSession()));
  }
  if (req.method === "POST" && pathname === "/api/login") {
    if (!loginAllowed(ip)) return json(res, 429, { error: "시도 횟수 초과 — 1분 후 다시" });
    const { password } = await readBody(req);
    if (!verifyPw(sys, password || "")) return json(res, 401, { error: "비밀번호가 다릅니다" });
    return json(res, 200, { ok: true }, setSessionCookie(req, newSession()));
  }
  if (req.method === "POST" && pathname === "/api/logout") {
    const sid = getSid(req);
    if (sid) sessions.delete(sid);          // 쿠키만 지우면 서버 세션이 살아남는다
    return json(res, 200, { ok: true }, { "Set-Cookie": "sid=; HttpOnly; Path=/; Max-Age=0" });
  }
  // 리그 조회는 공개 (조회 전용 페이지가 사용)
  if (req.method === "GET" && mLeague) {
    const league = store.loadLeague(Number(mLeague[1]));
    return league ? json(res, 200, league) : json(res, 404, { error: "리그 없음" });
  }

  // ---- 이하 관리자 전용 ----
  if (!authed) return json(res, 401, { error: "로그인 필요" });

  if (req.method === "POST" && pathname === "/api/password") {
    const { oldPassword, newPassword } = await readBody(req);
    if (!verifyPw(sys, oldPassword || "")) return json(res, 401, { error: "기존 비밀번호가 다릅니다" });
    if (!newPassword || newPassword.length < 6) return json(res, 400, { error: "비밀번호는 6자 이상" });
    sys.adminSalt = crypto.randomBytes(16).toString("hex");
    sys.adminHash = hashPw(newPassword, sys.adminSalt);
    store.saveSystem(sys);
    sessions.clear();                       // 비번을 바꾸면 다른 기기·탈취된 세션도 전부 끊는다
    return json(res, 200, { ok: true }, setSessionCookie(req, newSession()));  // 지금 이 브라우저만 재발급
  }
  if (req.method === "POST" && pathname === "/api/users") {
    const { name } = await readBody(req);
    const clean = (name || "").trim();
    if (!clean) return json(res, 400, { error: "이름을 입력하세요" });
    if (sys.users.some(u => u.name === clean))
      return json(res, 409, { error: "이미 있는 이름 — 동명이인은 구분자를 붙여주세요" });
    const user = { id: sys.seq.user++, name: clean, createdAt: new Date().toISOString() };
    sys.users.push(user);
    store.saveSystem(sys);
    return json(res, 200, user);
  }
  const mUser = pathname.match(/^\/api\/users\/(\d+)$/);
  if (req.method === "DELETE" && mUser) {
    const id = Number(mUser[1]);
    const idx = sys.users.findIndex(u => u.id === id);
    if (idx < 0) return json(res, 404, { error: "유저 없음" });
    const usedIn = store.listLeagues()
      .map(l => store.loadLeague(l.id))
      .filter(l => l && l.players.some(p => p.userId === id))
      .map(l => l.name);
    if (usedIn.length)
      return json(res, 409, { error: `리그에 등록된 유저입니다 (${usedIn.join(", ")}) — 참가 해제 후 삭제하세요` });
    sys.users.splice(idx, 1);
    store.saveSystem(sys);
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && pathname === "/api/leagues") {
    const { name, start, end } = await readBody(req);
    if (!name || !name.trim()) return json(res, 400, { error: "리그 이름을 입력하세요" });
    return json(res, 200, store.createLeague(sys, name.trim(), start || "", end || ""));
  }
  if (req.method === "PUT" && mLeague) {
    const id = Number(mLeague[1]);
    const current = store.loadLeague(id);
    if (!current) return json(res, 404, { error: "리그 없음" });
    const body = await readBody(req);
    // 낙관적 잠금: 클라이언트가 들고 있던 rev와 저장된 rev가 다르면 충돌 (409 → 클라이언트가 다시 로드)
    if (body.rev !== current.rev) return json(res, 409, { error: "다른 곳에서 먼저 저장됨", rev: current.rev });
    body.id = id;                 // id는 URL이 진실
    body.rev = current.rev + 1;
    store.saveLeague(body);
    return json(res, 200, { ok: true, rev: body.rev });
  }
  if (req.method === "DELETE" && mLeague) {
    const id = Number(mLeague[1]);
    if (!store.deleteLeague(id)) return json(res, 404, { error: "리그 없음" });
    return json(res, 200, { ok: true });
  }
  const mMeta = pathname.match(/^\/api\/league\/(\d+)\/meta$/);
  if (req.method === "PATCH" && mMeta) {
    const league = store.loadLeague(Number(mMeta[1]));
    if (!league) return json(res, 404, { error: "리그 없음" });
    const { name, start, end, status } = await readBody(req);
    if (name !== undefined) league.name = String(name).trim() || league.name;
    if (start !== undefined) league.start = start;
    if (end !== undefined) league.end = end;
    if (status !== undefined && ["active", "archived"].includes(status)) league.status = status;
    league.rev += 1;
    store.saveLeague(league);
    return json(res, 200, { ok: true, rev: league.rev });
  }
  return json(res, 404, { error: "no route" });
}

/* ── 서버 ── */
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://x").pathname;
  try {
    if (pathname.startsWith("/api/")) await handleApi(req, res, pathname);
    else serveStatic(req, res, pathname);
  } catch (e) {
    json(res, 500, { error: e.message || "server error" });
  }
});
server.listen(PORT, HOST, () =>
  console.log(`초축 리그 서버 가동 — http://localhost:${PORT} (바인딩: ${HOST}, 데이터: ${store.DATA_DIR})`));
