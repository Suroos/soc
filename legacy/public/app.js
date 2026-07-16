/* 초축 리그 SPA — 의존성 없는 바닐라 JS */
'use strict';
const $app = document.getElementById('app');
let BOOT = null;           // /api/bootstrap 캐시
let TOKEN = localStorage.getItem('chochuk_token') || null;

/* ── 유틸 ─────────────────────────────────────── */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(path, opt = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  const res = await fetch(path, { ...opt, headers, body: opt.body ? JSON.stringify(opt.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { TOKEN = null; localStorage.removeItem('chochuk_token'); }
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}
const tierClass = t => 't-' + t[0].toLowerCase();
const badge = t => `<span class="tb ${tierClass(t)}">${esc(t)}</span>`;
const delta = d => d > 0 ? `<span class="d-up num">▲${d}</span>` : d < 0 ? `<span class="d-dn num">▼${-d}</span>` : `<span class="d-zero">—</span>`;
const sideName = (m, s) => s === 'red' ? (m.red_team || m.red_name || '레드') : (m.blue_team || m.blue_name || '블루');
const typeKo = { league: '리그', amateur: '아마추어', pro: '프로' };
const playerById = id => BOOT.players.find(p => p.id === id);

/* ── SVG 차트 ─────────────────────────────────── */
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (t, a) => { const n = document.createElementNS(NS, t); for (const k in a) n.setAttribute(k, a[k]); return n; };

function drawRadar(svg, norm) {
  svg.innerHTML = '';
  const axes = [['공포', 'attack'], ['효율성', 'efficiency'], ['볼경합', 'duel'], ['터치', 'touch'], ['수비', 'defense'], ['턴오버', 'turnover_rate']];
  const cx = 150, cy = 128, R = 88;
  const pt = (i, r) => { const a = -Math.PI / 2 + i * Math.PI / 3; return [cx + Math.cos(a) * r * R, cy + Math.sin(a) * r * R]; };
  const poly = v => v.map((r, i) => pt(i, r).map(x => x.toFixed(1)).join(',')).join(' ');
  for (const g of [.25, .5, .75, 1])
    svg.appendChild(svgEl('polygon', { points: poly(axes.map(() => g)), fill: 'none', stroke: '#263050', 'stroke-width': g === 1 ? 1.2 : .8 }));
  axes.forEach(([name], i) => {
    const [x, y] = pt(i, 1);
    svg.appendChild(svgEl('line', { x1: cx, y1: cy, x2: x, y2: y, stroke: '#263050', 'stroke-width': .8 }));
    const [lx, ly] = pt(i, 1.19);
    const t = svgEl('text', { x: lx, y: ly + 4, 'text-anchor': 'middle', fill: '#8C96AE', 'font-size': '11.5', 'font-weight': '700' });
    t.textContent = name; svg.appendChild(t);
  });
  const vals = axes.map(([, k]) => Math.max(0.02, norm[k] ?? 0));
  svg.appendChild(svgEl('polygon', { points: poly(vals), fill: 'rgba(57,135,229,.20)', stroke: '#3987e5', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
  vals.forEach((r, i) => {
    const [x, y] = pt(i, r);
    const c = svgEl('circle', { cx: x, cy: y, r: 3.5, fill: '#3987e5', stroke: '#141B2D', 'stroke-width': 2 });
    const tip = svgEl('title', {}); tip.textContent = `${axes[i][0]} ${(vals[i] * 100) | 0}`;
    c.appendChild(tip); svg.appendChild(c);
  });
}

function drawLine(svg, values, labels) {
  svg.innerHTML = '';
  if (values.length < 2) { const t = svgEl('text', { x: 10, y: 30, fill: '#5C6680', 'font-size': 12 }); t.textContent = '경기 기록이 쌓이면 표시됩니다'; svg.appendChild(t); return; }
  const W = 320, H = 90, P = 8;
  const min = Math.min(...values) - 20, max = Math.max(...values) + 20;
  const X = i => P + i * (W - 2 * P) / (values.length - 1);
  const Y = v => H - P - (v - min) / (max - min) * (H - 2 * P);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  svg.appendChild(svgEl('path', { d: `${d}L${X(values.length - 1)},${H}L${X(0)},${H}Z`, fill: 'rgba(57,135,229,.12)' }));
  svg.appendChild(svgEl('path', { d, fill: 'none', stroke: '#3987e5', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  values.forEach((v, i) => {
    const last = i === values.length - 1;
    const c = svgEl('circle', { cx: X(i), cy: Y(v), r: last ? 4 : 2.5, fill: last ? '#E9EDF7' : '#3987e5', stroke: last ? '#3987e5' : '#141B2D', 'stroke-width': last ? 2.5 : 1.5 });
    const tip = svgEl('title', {}); tip.textContent = `${labels[i]} · ${v}`;
    c.appendChild(tip); svg.appendChild(c);
  });
}

/* ── 라우터 ───────────────────────────────────── */
async function route() {
  if (!BOOT) BOOT = await api('/api/bootstrap');
  const h = location.hash || '#/';
  const seg = h.slice(2).split('/');
  document.querySelectorAll('#nav-links a').forEach(a => a.classList.remove('on'));
  const mark = r => document.querySelector(`[data-r="${r}"]`)?.classList.add('on');
  try {
    if (h === '#/' || h === '') { mark('rankings'); await vRankings(); }
    else if (seg[0] === 'teams') { mark('teams'); await vTeams(); }
    else if (seg[0] === 'matches') { mark('matches'); await vMatches(seg[1]); }
    else if (seg[0] === 'match') { mark('matches'); await vMatch(Number(seg[1])); }
    else if (seg[0] === 'player') await vPlayer(Number(seg[1]));
    else if (seg[0] === 'admin') await vAdmin(seg[1]);
    else { mark('rankings'); await vRankings(); }
  } catch (e) {
    $app.innerHTML = `<div class="err-box" style="margin:20px 0">${esc(e.message)}</div>`;
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

function seasonHeader() {
  return `<div class="season"><h1>${esc(BOOT.season)}</h1>
    <span class="meta">${BOOT.week}주차</span>
    <span class="live">공식 갱신 · 매주 월요일</span></div>`;
}

/* ── 랭킹 ─────────────────────────────────────── */
async function vRankings() {
  const rows = await api('/api/rankings');
  const sCap = BOOT.tiers.find(t => t.code === 'S')?.capacity || 8;
  let body = '';
  rows.forEach(r => {
    body += `<tr>
      <td class="rank num">${r.rank}</td>
      <td>${badge(r.tier)}</td>
      <td><a class="name" href="#/player/${r.id}">${esc(r.name)}</a></td>
      <td class="dim hide-m">${esc(r.team || '미배정')}</td>
      <td class="mmr num r">${r.mmr_live}</td>
      <td class="r num">${delta(r.week_delta)}</td>
      <td class="dim r num hide-m">${r.games ? `${r.wins}–${r.losses}${r.draws ? '–' + r.draws : ''}` : '—'}</td>
    </tr>`;
    if (r.rank === sCap && rows.length > sCap)
      body += `<tr class="cut"><td colspan="7"><span class="cutline">S 유지선 · MMR 3200 + TOP RATE ${sCap}위</span></td></tr>`;
  });
  $app.innerHTML = seasonHeader() + `
  <section class="card">
    <div class="card-h"><span class="eyebrow">Top Rate</span><h2>MMR 랭킹</h2>
      <span class="sub">주간 = ${BOOT.week}주차 변동</span></div>
    <div class="scroll-x"><table class="tbl">
      <thead><tr><th>#</th><th>티어</th><th>선수</th><th class="hide-m">팀</th>
        <th class="r">MMR</th><th class="r">주간</th><th class="r hide-m">전적</th></tr></thead>
      <tbody>${body}</tbody></table></div>
  </section>`;
}

/* ── 팀 순위 ──────────────────────────────────── */
async function vTeams() {
  const rows = await api('/api/teams');
  const body = rows.map(r => `<tr>
    <td class="rank num">${r.rank}</td>
    <td class="name">${esc(r.name)}</td>
    <td class="dim hide-m">${esc(r.manager || '—')}${r.coach ? ` · ${esc(r.coach)}` : ''}</td>
    <td class="r num">${r.games}</td>
    <td class="r num">${r.w}</td><td class="r num">${r.d}</td><td class="r num">${r.l}</td>
    <td class="r num mmr">${r.pts}</td>
    <td class="r num hide-m">${r.gf}</td><td class="r num hide-m">${r.ga}</td>
    <td class="r num">${r.gd > 0 ? '+' : ''}${r.gd}</td>
  </tr>`).join('');
  $app.innerHTML = seasonHeader() + `
  <section class="card">
    <div class="card-h"><span class="eyebrow">Standings</span><h2>팀 순위표</h2>
      <span class="sub">승점 = 승×3 + 무 · 리그 경기만</span></div>
    <div class="scroll-x"><table class="tbl">
      <thead><tr><th>#</th><th>팀</th><th class="hide-m">감독 · 코치</th><th class="r">경기</th><th class="r">승</th><th class="r">무</th><th class="r">패</th>
        <th class="r">승점</th><th class="r hide-m">득점</th><th class="r hide-m">실점</th><th class="r">득실</th></tr></thead>
      <tbody>${body || `<tr><td colspan="11" class="empty">등록된 팀이 없습니다 — 관리자에서 팀을 만들어주세요</td></tr>`}</tbody></table></div>
  </section>`;
}

/* ── 경기 로그 ────────────────────────────────── */
function matchRow(m) {
  const winner = m.result === 'draw' ? null : m.result;
  const rn = sideName(m, 'red'), bn = sideName(m, 'blue');
  const chips = [];
  if (m.underdog_side) chips.push(`<span class="chip ud">언더독 ${m.underdog_side === m.result ? '승리' : ''}</span>`);
  const rd = m.red_delta ?? 0, bd = m.blue_delta ?? 0;
  return `<a class="mrow" href="#/match/${m.id}">
    <div class="mmeta"><b>${typeKo[m.type] || m.type} · ${m.week}주차</b>${esc(m.played_at)} · ${m.day_seq}경기</div>
    <div class="mscore">
      <span class="${winner === 'blue' ? 'lose' : ''}">${esc(rn)}</span>
      <span class="sc num">${m.red_score} : ${m.blue_score}</span>
      <span class="${winner === 'red' ? 'lose' : ''}">${esc(bn)}</span>
      ${chips.join('')}
    </div>
    <div class="mpts num">
      <span class="${rd >= 0 ? 'd-up' : 'd-dn'}">${esc(rn)} ${rd >= 0 ? '+' : ''}${rd}</span>
      <span class="${bd >= 0 ? 'd-up' : 'd-dn'}">${esc(bn)} ${bd >= 0 ? '+' : ''}${bd}</span>
    </div>
  </a>`;
}

async function vMatches(type) {
  const q = type && type !== 'all' ? '?type=' + type : '';
  const rows = await api('/api/matches' + q);
  const tabs = [['all', '전체'], ['league', '리그'], ['amateur', '아마추어'], ['pro', '프로']]
    .map(([k, l]) => `<button class="${(type || 'all') === k ? 'on' : ''}" onclick="location.hash='#/matches/${k}'">${l}</button>`).join('');
  $app.innerHTML = seasonHeader() + `
  <section class="card">
    <div class="tabs">${tabs}</div>
    <div class="card-h"><span class="eyebrow">Matches</span><h2>경기 로그</h2><span class="sub">${rows.length}경기</span></div>
    ${rows.map(matchRow).join('') || `<div class="empty">아직 경기가 없습니다</div>`}
  </section>`;
}

async function vMatch(id) {
  const m = await api('/api/matches/' + id);
  const rn = sideName(m, 'red'), bn = sideName(m, 'blue');
  const sideTbl = side => {
    const rows = m.players.filter(p => p.side === side);
    return `<div class="card-h"><span class="eyebrow">${side}</span><h2>${esc(sideName(m, side))}</h2>
      ${m.underdog_side === side ? '<span class="chip ud">언더독</span>' : ''}
      <span class="sub num">합산 MMR ${rows.reduce((s, r) => s + r.mmr_before, 0)}</span></div>
    <div class="scroll-x"><table class="tbl"><thead><tr>
      <th>선수</th><th class="r">골</th><th class="r">어시</th><th class="r">터치</th><th class="r">패스</th>
      <th class="r">수비</th><th class="r">볼경합</th><th class="r">턴오버</th><th class="r">활동량</th><th class="r">MMR</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td><a class="name" href="#/player/${r.player_id}">${badge(r.tier)} ${esc(r.name)}</a>
        ${r.is_mom ? '<span class="chip ud">MoM</span>' : ''}${r.is_defense_king ? '<span class="chip type">수비왕</span>' : ''}</td>
      <td class="r num">${r.goal}</td><td class="r num">${r.assist}</td><td class="r num">${r.touch}</td><td class="r num">${r.pass}</td>
      <td class="r num">${r.defense}</td><td class="r num">${r.duel}</td><td class="r num">${r.turnover}</td><td class="r num">${r.activity}</td>
      <td class="r num">${delta(r.mmr_delta)} <span class="dim">${r.mmr_after}</span></td>
    </tr>`).join('')}</tbody></table></div>`;
  };
  $app.innerHTML = `
  <div class="season"><h1 class="num">${esc(rn)} ${m.red_score} : ${m.blue_score} ${esc(bn)}</h1>
    <span class="meta">${typeKo[m.type]} · ${m.week}주차 · ${esc(m.played_at)} ${m.day_seq}경기</span>
    ${m.underdog_side ? `<span class="live">언더독 적용 (${esc(sideName(m, m.underdog_side))})</span>` : ''}</div>
  <section class="card">${sideTbl('red')}</section>
  <section class="card">${sideTbl('blue')}</section>
  <a class="btn ghost" href="#/matches">← 경기 목록</a>`;
}

/* ── 선수 페이지 ──────────────────────────────── */
async function vPlayer(id) {
  const p = await api('/api/players/' + id);
  const winRate = p.record.games ? Math.round(p.record.wins / p.record.games * 100) : 0;
  const initMmr = BOOT.tiers.find(t => t.code === p.initial_tier)?.mmr_initial ?? 0;
  const hist = [initMmr, ...p.history.map(h => h.mmr_after)];
  const labels = ['배치', ...p.history.map(h => h.played_at)];
  $app.innerHTML = `
  <div class="grid2">
    <div>
      <section class="card">
        <div class="pc-top">
          <div class="pc-ava">${esc(p.name[0])}</div>
          <div><div class="pc-name">${esc(p.name)} ${badge(p.tier)}</div>
          <div class="pc-team">${esc(p.team || '미배정')} · 급여 ${p.salary} · 시즌 ${p.record.games}경기</div></div>
        </div>
        <div class="stat-grid">
          <div class="stat-cell"><div class="k">MMR</div><div class="v num">${p.mmr_live}</div></div>
          <div class="stat-cell"><div class="k">승률</div><div class="v num">${winRate}<small>%</small></div></div>
          <div class="stat-cell"><div class="k">전적</div><div class="v num">${p.record.wins}–${p.record.losses}${p.record.draws ? '–' + p.record.draws : ''}</div></div>
          <div class="stat-cell"><div class="k">골</div><div class="v num">${p.totals.goal}</div></div>
          <div class="stat-cell"><div class="k">어시</div><div class="v num">${p.totals.assist}</div></div>
          <div class="stat-cell"><div class="k">MoM</div><div class="v num">${p.mom}</div></div>
          <div class="stat-cell"><div class="k">수비왕</div><div class="v num">${p.defense_king}</div></div>
        </div>
        <div class="chart-pad"><div class="k">MMR 추이</div>
          <svg id="mmr-chart" width="100%" height="90" viewBox="0 0 320 90" preserveAspectRatio="none" role="img" aria-label="MMR 추이"></svg></div>
      </section>
      <section class="card">
        <div class="card-h"><span class="eyebrow">Recent</span><h2>최근 경기</h2></div>
        ${p.history.slice(-10).reverse().map(h => {
          const won = h.result !== 'draw' && h.result === h.side;
          return `<a class="mrow" href="#/match/${h.match_id}">
          <div class="mmeta"><b>${typeKo[h.type]} · ${h.week}주차</b>${esc(h.played_at)}</div>
          <div class="mscore"><span class="${won ? 'd-up' : h.result === 'draw' ? 'd-zero' : 'd-dn'}">${won ? '승' : h.result === 'draw' ? '무' : '패'}</span>
            <span class="sc num">${h.red_score} : ${h.blue_score}</span>
            <span class="dim">골 ${h.goal} · 어시 ${h.assist}</span>
            ${h.is_mom ? '<span class="chip ud">MoM</span>' : ''}</div>
          <div class="mpts num"><span class="${h.mmr_delta >= 0 ? 'd-up' : 'd-dn'}">${h.mmr_delta >= 0 ? '+' : ''}${h.mmr_delta}</span>
            <span class="dim">${h.mmr_after}</span></div></a>`;
        }).join('') || '<div class="empty">경기 기록이 없습니다</div>'}
      </section>
    </div>
    <aside class="card">
      <div class="card-h"><span class="eyebrow">Hexagon</span><h2>육각형 스텟</h2><span class="sub">전체 선수 대비</span></div>
      <div class="radar-wrap"><svg id="radar" width="300" height="248" viewBox="0 0 300 248" role="img" aria-label="육각형 스텟"></svg></div>
      ${p.radar ? `<div class="chart-pad"><div class="k">경기당 평균</div>
        <table class="tbl"><tbody>
          <tr><td>공포 (골+어시)</td><td class="r num">${p.radar.raw.attack.toFixed(2)}</td></tr>
          <tr><td>효율성</td><td class="r num">${p.radar.raw.efficiency.toFixed(2)}</td></tr>
          <tr><td>볼경합</td><td class="r num">${p.radar.raw.duel.toFixed(1)}</td></tr>
          <tr><td>터치</td><td class="r num">${p.radar.raw.touch.toFixed(1)}</td></tr>
          <tr><td>수비</td><td class="r num">${p.radar.raw.defense.toFixed(1)}</td></tr>
          <tr><td>턴오버 비율</td><td class="r num">${(p.radar.raw.turnover_rate * 100).toFixed(1)}%</td></tr>
        </tbody></table></div>` : '<div class="empty">경기 기록이 쌓이면 표시됩니다</div>'}
    </aside>
  </div>`;
  drawLine(document.getElementById('mmr-chart'), hist, labels);
  if (p.radar) drawRadar(document.getElementById('radar'), p.radar.norm);
}

/* ── 관리자 ───────────────────────────────────── */
let MF = null; // 경기 입력 폼 상태
function newMF() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: null, type: 'league', week: BOOT.week, played_at: today, day_seq: 1,
    red_team_id: '', blue_team_id: '', red_name: '', blue_name: '',
    red_score: 0, blue_score: 0, confirmed: false, warnings: null,
    players: { red: [{}, {}, {}, {}].map(() => blankRow()), blue: [{}, {}, {}, {}].map(() => blankRow()) },
  };
}
const blankRow = () => ({ player_id: '', goal: '', assist: '', touch: '', pass: '', defense: '', duel: '', turnover: '', activity: '', is_mom: false });

async function vAdmin(tab) {
  if (!TOKEN) return vLogin();
  tab = tab || 'match';
  const tabs = [['match', '경기 입력'], ['list', '경기 목록'], ['players', '선수 관리'], ['roster', '팀 · 로스터']]
    .map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" onclick="location.hash='#/admin/${k}'">${l}</button>`).join('');
  $app.innerHTML = `<div class="season"><h1>관리</h1>
      <span class="meta">쓰기 작업은 즉시 MMR 전체 재계산에 반영됩니다</span>
      <button class="btn ghost sm" style="margin-left:auto" onclick="logout()">로그아웃</button></div>
    <div class="tabs">${tabs}</div><div id="admin-body"></div>`;
  const body = document.getElementById('admin-body');
  if (tab === 'match') renderMatchForm(body);
  else if (tab === 'list') await renderMatchList(body);
  else if (tab === 'players') await renderPlayers(body);
  else if (tab === 'roster') await renderRoster(body);
}

function vLogin() {
  $app.innerHTML = `<div class="season"><h1>관리자 로그인</h1></div>
  <section class="card" style="max-width:420px">
    <div class="form-grid"><div class="field"><label>비밀번호</label>
      <input type="password" id="pw" autocomplete="current-password"></div></div>
    <div id="login-err"></div>
    <div class="bar"><button class="btn" id="login-btn">로그인</button></div>
  </section>`;
  const go = async () => {
    try {
      const r = await api('/api/login', { method: 'POST', body: { password: document.getElementById('pw').value } });
      TOKEN = r.token; localStorage.setItem('chochuk_token', TOKEN);
      location.hash = '#/admin'; route();
    } catch (e) {
      document.getElementById('login-err').innerHTML = `<div class="err-box">${esc(e.message)}</div>`;
    }
  };
  document.getElementById('login-btn').onclick = go;
  document.getElementById('pw').onkeydown = e => { if (e.key === 'Enter') go(); };
}
window.logout = () => { TOKEN = null; localStorage.removeItem('chochuk_token'); location.hash = '#/'; };

/* ── 경기 입력 폼 ─────────────────────────────── */
function renderMatchForm(el) {
  if (!MF) MF = newMF();
  const teamOpts = sel => `<option value="">— 팀 선택 —</option>` +
    BOOT.teams.map(t => `<option value="${t.id}" ${String(sel) === String(t.id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  const playerOpts = sel => `<option value="">— 선수 —</option>` +
    BOOT.players.map(p => `<option value="${p.id}" ${String(sel) === String(p.id) ? 'selected' : ''}>[${p.tier}] ${esc(p.name)}</option>`).join('');

  const sidePanel = side => {
    const label = side === 'red' ? '레드' : '블루';
    const ids = MF.players[side].map(r => Number(r.player_id)).filter(Boolean);
    const cap = BOOT.salary_cap || 90;
    const sal = ids.reduce((s, id) => s + (playerById(id)?.salary || 0), 0);
    const over = sal > cap;
    return `<div class="side-panel">
      <h3>${label}
        <select data-f="${side}_team_id" style="min-width:130px">${teamOpts(MF[side + '_team_id'])}</select>
        <input data-f="${side}_score" type="number" min="0" value="${MF[side + '_score']}" style="width:64px" aria-label="${label} 득점">
        <span class="sal ${over ? 'over' : ''}">급여 ${sal}/${cap}${over ? ` · 초과 −${Math.ceil((sal - cap) / 5) * 5}골` : ''}</span>
      </h3>
      <div class="scroll-x">
      <div class="prow"><span class="prow-head">선수</span>${['골', '어시', '터치', '패스', '수비', '볼경합', '턴오버', '활동량'].map(s => `<span class="prow-head">${s}</span>`).join('')}<span class="prow-head">MoM</span></div>
      ${MF.players[side].map((r, i) => `<div class="prow">
        <select data-p="${side}.${i}.player_id">${playerOpts(r.player_id)}</select>
        ${['goal', 'assist', 'touch', 'pass', 'defense', 'duel', 'turnover', 'activity'].map(f =>
          `<input data-p="${side}.${i}.${f}" type="number" min="0" value="${r[f]}" placeholder="0">`).join('')}
        <input data-p="${side}.${i}.is_mom" type="checkbox" ${r.is_mom ? 'checked' : ''} style="justify-self:center">
      </div>`).join('')}
      </div></div>`;
  };

  el.innerHTML = `<section class="card">
    <div class="card-h"><span class="eyebrow">Match Entry</span><h2>${MF.id ? `경기 #${MF.id} 수정` : '경기 입력'}</h2>
      ${MF.id ? '<button class="btn ghost sm" onclick="resetMF()">새 경기로</button>' : ''}</div>
    <div class="form-grid">
      <div class="field"><label>유형</label><select data-f="type">
        ${Object.entries(typeKo).map(([k, l]) => `<option value="${k}" ${MF.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>날짜</label><input data-f="played_at" type="date" value="${MF.played_at}"></div>
      <div class="field"><label>주차</label><input data-f="week" type="number" min="1" value="${MF.week}"></div>
      <div class="field"><label>당일 순번</label><input data-f="day_seq" type="number" min="1" value="${MF.day_seq}"></div>
    </div>
    ${sidePanel('red')}${sidePanel('blue')}
    <div id="mf-msg">${MF.warnings ? `<div class="warn-box"><b>경고 — 확인 후 저장하세요</b><br>${MF.warnings.map(esc).join('<br>')}</div>` : ''}</div>
    <div class="bar">
      <button class="btn" id="mf-save">${MF.warnings ? '경고 확인했음 — 저장' : (MF.id ? '수정 저장' : '저장')}</button>
      <span class="sub" style="color:var(--faint);font-size:12.5px">저장 즉시 MMR·수비왕·언더독 자동 계산</span>
    </div>
  </section>`;

  el.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () => {
    MF[inp.dataset.f] = inp.type === 'number' ? Number(inp.value) : inp.value;
    MF.warnings = null; renderMatchForm(el);
  });
  el.querySelectorAll('[data-p]').forEach(inp => inp.onchange = () => {
    const [side, i, f] = inp.dataset.p.split('.');
    MF.players[side][i][f] = inp.type === 'checkbox' ? inp.checked : inp.value;
    if (f === 'player_id') { MF.warnings = null; renderMatchForm(el); }
  });
  document.getElementById('mf-save').onclick = () => saveMF(el);
}
window.resetMF = () => { MF = newMF(); route(); };

function mfBody() {
  const players = [];
  for (const side of ['red', 'blue'])
    for (const r of MF.players[side])
      if (r.player_id) players.push({ ...r, player_id: Number(r.player_id), side });
  return {
    type: MF.type, week: Number(MF.week), played_at: MF.played_at, day_seq: Number(MF.day_seq),
    red_team_id: MF.red_team_id ? Number(MF.red_team_id) : null,
    blue_team_id: MF.blue_team_id ? Number(MF.blue_team_id) : null,
    red_score: Number(MF.red_score), blue_score: Number(MF.blue_score), players,
  };
}

async function saveMF(el) {
  const body = mfBody();
  const msg = document.getElementById('mf-msg');
  try {
    if (!MF.warnings) { // 1차: 검증
      const pv = await api('/api/matches/preview', { method: 'POST', body });
      if (pv.warnings.length) { MF.warnings = pv.warnings; return renderMatchForm(el); }
    }
    if (MF.id) await api('/api/matches/' + MF.id, { method: 'PUT', body });
    else await api('/api/matches', { method: 'POST', body });
    BOOT = await api('/api/bootstrap');
    MF = newMF();
    renderMatchForm(el);
    document.getElementById('mf-msg').innerHTML = `<div class="ok-box">저장 완료 — MMR이 재계산됐습니다</div>`;
  } catch (e) {
    msg.innerHTML = `<div class="err-box">${esc(e.message)}</div>`;
  }
}

/* ── 경기 목록 (수정/삭제) ────────────────────── */
async function renderMatchList(el) {
  const rows = await api('/api/matches');
  el.innerHTML = `<section class="card">
    <div class="card-h"><span class="eyebrow">Matches</span><h2>경기 목록</h2><span class="sub">${rows.length}경기</span></div>
    ${rows.map(m => `<div class="mrow">
      <div class="mmeta"><b>${typeKo[m.type]} · ${m.week}주차</b>${esc(m.played_at)} · ${m.day_seq}경기</div>
      <div class="mscore">${esc(sideName(m, 'red'))} <span class="sc num">${m.red_score} : ${m.blue_score}</span> ${esc(sideName(m, 'blue'))}
        ${m.underdog_side ? '<span class="chip ud">언더독</span>' : ''}</div>
      <div style="display:flex;gap:8px">
        <button class="btn ghost sm" onclick="editMatch(${m.id})">수정</button>
        <button class="btn danger sm" onclick="delMatch(${m.id})">삭제</button></div>
    </div>`).join('') || '<div class="empty">경기가 없습니다</div>'}
  </section>`;
}
window.editMatch = async id => {
  const m = await api('/api/matches/' + id);
  MF = newMF();
  Object.assign(MF, {
    id, type: m.type, week: m.week, played_at: m.played_at, day_seq: m.day_seq,
    red_team_id: m.red_team_id || '', blue_team_id: m.blue_team_id || '',
    red_score: m.red_score, blue_score: m.blue_score,
  });
  for (const side of ['red', 'blue']) {
    const rows = m.players.filter(p => p.side === side);
    MF.players[side] = [0, 1, 2, 3].map(i => rows[i] ? {
      player_id: rows[i].player_id, goal: rows[i].goal, assist: rows[i].assist, touch: rows[i].touch,
      pass: rows[i].pass, defense: rows[i].defense, duel: rows[i].duel,
      turnover: rows[i].turnover, activity: rows[i].activity, is_mom: !!rows[i].is_mom,
    } : blankRow());
  }
  location.hash = '#/admin/match'; route();
};
window.delMatch = async id => {
  if (!confirm(`경기 #${id}를 삭제할까요? 삭제 후 전체 MMR이 재계산됩니다.`)) return;
  await api('/api/matches/' + id, { method: 'DELETE' });
  BOOT = await api('/api/bootstrap');
  route();
};

/* ── 선수 관리 ────────────────────────────────── */
async function renderPlayers(el) {
  const tiers = BOOT.tiers.map(t => t.code);
  const tierOpts = sel => tiers.map(c => `<option ${c === sel ? 'selected' : ''}>${c}</option>`).join('');
  const teamOpts = sel => `<option value="">미배정</option>` +
    BOOT.teams.map(t => `<option value="${t.id}" ${String(sel) === String(t.id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  el.innerHTML = `<section class="card">
    <div class="card-h"><span class="eyebrow">Players</span><h2>선수 관리</h2>
      <span class="sub">티어 변경 시 초기 배치 티어 기준으로 MMR이 재계산됩니다</span></div>
    <div class="scroll-x"><table class="tbl"><thead><tr>
      <th>선수</th><th>현재 티어</th><th>배치 티어</th><th>팀</th><th class="r">MMR</th><th></th></tr></thead>
    <tbody id="pl-rows"></tbody></table></div>
    <div class="bar">
      <input id="np-name" placeholder="새 선수 이름" style="width:140px">
      <select id="np-tier">${tierOpts('C-')}</select>
      <button class="btn sm" id="np-add">선수 추가</button>
      <span id="pl-msg" style="font-size:12.5px;color:var(--muted)"></span>
    </div>
  </section>`;
  const tb = document.getElementById('pl-rows');
  const full = await api('/api/rankings');
  tb.innerHTML = full.sort((a, b) => a.tier_ord - b.tier_ord || a.name.localeCompare(b.name, 'ko')).map(p => `<tr data-id="${p.id}">
    <td class="name">${esc(p.name)}</td>
    <td><select data-e="tier">${tierOpts(p.tier)}</select></td>
    <td><select data-e="initial_tier">${tierOpts(BOOT.players.find(x => x.id === p.id) ? dbInit(p.id) : p.tier)}</select></td>
    <td><select data-e="team_id">${teamOpts(BOOT.players.find(x => x.id === p.id)?.team_id ?? '')}</select></td>
    <td class="r num mmr">${p.mmr_live}</td>
    <td class="r"><button class="btn ghost sm" data-e="save">저장</button></td>
  </tr>`).join('');
  // initial_tier는 rankings에 없어 상세에서 — 간단화: 현재 티어로 표시하고 저장 시 그대로 유지
  function dbInit(id) { return BOOT.players.find(x => x.id === id)?.initial_tier || BOOT.players.find(x => x.id === id)?.tier; }
  tb.querySelectorAll('[data-e="save"]').forEach(btn => btn.onclick = async () => {
    const tr = btn.closest('tr');
    const body = {
      tier: tr.querySelector('[data-e="tier"]').value,
      initial_tier: tr.querySelector('[data-e="initial_tier"]').value,
      team_id: tr.querySelector('[data-e="team_id"]').value ? Number(tr.querySelector('[data-e="team_id"]').value) : null,
    };
    await api('/api/players/' + tr.dataset.id, { method: 'PUT', body });
    BOOT = await api('/api/bootstrap');
    document.getElementById('pl-msg').textContent = '저장됨 · MMR 재계산 완료';
    renderPlayers(el);
  });
  document.getElementById('np-add').onclick = async () => {
    const name = document.getElementById('np-name').value.trim();
    if (!name) return;
    await api('/api/players', { method: 'POST', body: { name, tier: document.getElementById('np-tier').value } });
    BOOT = await api('/api/bootstrap');
    renderPlayers(el);
  };
}

/* ── 팀 · 로스터 ──────────────────────────────── */
async function renderRoster(el) {
  const players = BOOT.players;
  const groups = new Map(BOOT.teams.map(t => [t.id, []]));
  const un = [];
  for (const p of players) (groups.has(p.team_id) ? groups.get(p.team_id) : un).push(p);
  const ordOf = t => BOOT.tiers.find(x => x.code === t).ord;
  const teamOpts = sel => `<option value="">미배정</option>` +
    BOOT.teams.map(t => `<option value="${t.id}" ${String(sel) === String(t.id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('');

  const teamBox = (title, list, team) => {
    const tid = team ? team.id : null;
    const hi = list.filter(p => ordOf(p.tier) <= 4).length;   // S~A-
    const lo = list.filter(p => ordOf(p.tier) >= 5).length;   // B+~C-
    const bad = tid !== null && (list.length > 9 || hi > 4 || lo > 7);
    const cnt = tid === null ? `${list.length}명` : `${list.length}/9 · 상위 ${hi}/4 · 하위 ${lo}/7`;
    const staff = team ? `<div class="rstaff">
        <input data-tf="name" data-tid="${team.id}" value="${esc(team.name)}" title="팀 이름">
        <input data-tf="manager" data-tid="${team.id}" placeholder="감독" value="${esc(team.manager || '')}">
        <input data-tf="coach" data-tid="${team.id}" placeholder="코치" value="${esc(team.coach || '')}">
        <button class="btn sm danger" data-td="${team.id}" data-tn="${esc(team.name)}">팀 삭제</button>
      </div>` : '';
    return `<div class="rteam"><h3>${esc(title)}<span class="cnt ${bad ? 'bad' : ''}">${cnt}</span></h3>
      ${team && (team.manager || team.coach) ? `<div class="rmeta">${team.manager ? '감독 ' + esc(team.manager) : ''}${team.manager && team.coach ? ' · ' : ''}${team.coach ? '코치 ' + esc(team.coach) : ''}</div>` : ''}
      <ul>${list.sort((a, b) => ordOf(a.tier) - ordOf(b.tier)).map(p => `<li>
        ${badge(p.tier)}<span class="nm">${esc(p.name)}</span>
        <select data-rp="${p.id}">${teamOpts(p.team_id ?? '')}</select>
      </li>`).join('') || '<li class="dim" style="color:var(--faint)">비어 있음</li>'}</ul>
      ${staff}</div>`;
  };

  el.innerHTML = `<section class="card">
    <div class="card-h"><span class="eyebrow">Roster</span><h2>팀 · 로스터</h2>
      <span class="sub">스쿼드 제한: 총 9명 · S~A- 최대 4 · B+~C- 최대 7 (위반 시 붉게 표시)</span></div>
    <div class="roster">
      ${BOOT.teams.map(t => teamBox(t.name, groups.get(t.id), t)).join('')}
      ${teamBox('미배정', un, null)}
    </div>
    <div class="bar">
      <input id="nt-name" placeholder="새 팀 이름" style="width:130px">
      <input id="nt-manager" placeholder="감독 (선택)" style="width:110px">
      <input id="nt-coach" placeholder="코치 (선택)" style="width:110px">
      <button class="btn sm" id="nt-add">팀 만들기</button>
    </div>
  </section>`;
  el.querySelectorAll('[data-rp]').forEach(sel => sel.onchange = async () => {
    await api('/api/players/' + sel.dataset.rp, {
      method: 'PUT', body: { team_id: sel.value ? Number(sel.value) : null },
    });
    BOOT = await api('/api/bootstrap');
    renderRoster(el);
  });
  el.querySelectorAll('[data-tf]').forEach(inp => inp.onchange = async () => {
    const v = inp.value.trim();
    if (inp.dataset.tf === 'name' && !v) { inp.value = BOOT.teams.find(t => String(t.id) === inp.dataset.tid).name; return; }
    await api('/api/teams/' + inp.dataset.tid, { method: 'PUT', body: { [inp.dataset.tf]: v } });
    BOOT = await api('/api/bootstrap');
    renderRoster(el);
  });
  el.querySelectorAll('[data-td]').forEach(btn => btn.onclick = async () => {
    if (!confirm(`'${btn.dataset.tn}' 팀을 삭제할까요? 소속 선수는 미배정으로 돌아갑니다.`)) return;
    try {
      await api('/api/teams/' + btn.dataset.td, { method: 'DELETE' });
    } catch (e) { alert(e.message); return; }
    BOOT = await api('/api/bootstrap');
    renderRoster(el);
  });
  document.getElementById('nt-add').onclick = async () => {
    const name = document.getElementById('nt-name').value.trim();
    if (!name) return;
    await api('/api/teams', { method: 'POST', body: {
      name,
      manager: document.getElementById('nt-manager').value.trim(),
      coach: document.getElementById('nt-coach').value.trim(),
    } });
    BOOT = await api('/api/bootstrap');
    renderRoster(el);
  };
}

route();
