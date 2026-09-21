// app.js — логика фронтенда
const API = {
  teams: '/api/teams',
  faceit: (nickname) => `/api/faceit?nickname=${encodeURIComponent(nickname)}`,
};

const CACHE_TTL = 10 * 60 * 1000; // 10 минут

const $ = (sel) => document.querySelector(sel);
const teamsEl = $('#teams');
const statusEl = $('#status');
const searchEl = $('#search');
const tooltip = $('#tooltip');
const modal = $('#modal');
const modalBody = $('#modal-body');
const modalTitle = $('#modal-title');
const modalAvg = $('#modal-avg');

let teamsData = [];
let currentModalTeam = null;

// ========== Кэш ==========
function lsGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.t > CACHE_TTL) { localStorage.removeItem(key); return null; }
    return obj.v;
  } catch { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value })); } catch {}
}

// ========== Загрузка команд ==========
async function loadTeams() {
  statusEl.textContent = 'Загрузка списка команд…';
  statusEl.classList.remove('error');
  try {
    const res = await fetch(API.teams);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    teamsData = data.teams || [];
    renderTeams(teamsData);
    statusEl.textContent = `Команд: ${teamsData.length} · игроков: ${teamsData.reduce((a,t)=>a+t.players.length,0)}`;
    preloadAllPlayers();
  } catch (e) {
    statusEl.textContent = 'Ошибка загрузки команд: ' + e.message;
    statusEl.classList.add('error');
  }
}

// ========== Рендер компактной сетки команд ==========
function renderTeams(teams) {
  teamsEl.innerHTML = '';
  teams.forEach((team) => {
    const el = document.createElement('div');
    el.className = 'team';
    el.dataset.team = team.name;
    el.innerHTML = `
      <div class="team__title">
        <span class="team__name">${escapeHtml(team.name)}</span>
        <span class="team__avg hidden"></span>
      </div>
      <span class="team__arrow">→</span>
    `;
    el.addEventListener('click', () => openTeamModal(team, el));
    teamsEl.appendChild(el);
  });
}

// ========== Открытие модалки команды ==========
async function openTeamModal(team, teamEl) {
  currentModalTeam = team;
  modalTitle.textContent = team.name;
  modalAvg.classList.add('hidden');
  modalAvg.textContent = '';
  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');

  modalBody.innerHTML = team.players.map(p => `
    <div class="modal-player loading" data-nick="${escapeAttr(p.faceit)}" data-lenza="${escapeAttr(p.lenza)}">
      <div class="modal-player__left">
        <img class="modal-player__avatar" alt="" />
        <div class="modal-player__info">
          <div class="modal-player__nick">${escapeHtml(p.faceit)}</div>
          <div class="modal-player__lenza">${escapeHtml(p.lenza)}</div>
        </div>
      </div>
      <div class="modal-player__stats"><span>загрузка…</span></div>
    </div>
  `).join('');

  modalBody.querySelectorAll('.modal-player').forEach(playerEl => {
    playerEl.addEventListener('mouseenter', (e) => showTooltip(playerEl, e));
    playerEl.addEventListener('mousemove', moveTooltip);
    playerEl.addEventListener('mouseleave', hideTooltip);
    playerEl.addEventListener('click', () => {
      const url = playerEl.dataset.url
        || `https://www.faceit.com/ru/players/${encodeURIComponent(playerEl.dataset.nick)}`;
      window.open(url, '_blank', 'noopener');
    });
  });

  await Promise.all(team.players.map((p) => loadModalPlayer(p)));

  // Обновляем средний ELO в модалке и в карточке сетки
  const elos = Array.from(modalBody.querySelectorAll('.modal-player'))
    .map(p => p._data?.elo)
    .filter(v => typeof v === 'number' && !isNaN(v));
  if (elos.length) {
    const avg = Math.round(elos.reduce((a, b) => a + b, 0) / elos.length);
    modalAvg.textContent = '~ ' + avg + ' ELO';
    modalAvg.classList.remove('hidden');
    const badge = teamEl.querySelector('.team__avg');
    if (badge) { badge.textContent = '~ ' + avg + ' ELO'; badge.classList.remove('hidden'); }
  }
}

function closeModal() {
  modal.classList.add('hidden');
  document.body.classList.remove('modal-open');
  hideTooltip();
  currentModalTeam = null;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
});
$('#modal-close').addEventListener('click', closeModal);
$('#modal-overlay').addEventListener('click', closeModal);

// ========== Загрузка одного игрока в модалку ==========
async function loadModalPlayer(player) {
  const el = modalBody.querySelector(`.modal-player[data-nick="${cssEscape(player.faceit)}"]`);
  if (!el) return;
  const cacheKey = 'faceit:' + player.faceit.toLowerCase();
  let data = lsGet(cacheKey);
  try {
    if (!data) {
      const res = await fetch(API.faceit(player.faceit));
      data = await res.json();
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      lsSet(cacheKey, data);
    }
    el.classList.remove('loading');
    el.dataset.url = normalizeFaceitUrl(data.faceit_url, player.faceit);
    if (data.avatar) el.querySelector('.modal-player__avatar').src = data.avatar;
    el.querySelector('.modal-player__stats').innerHTML = `
      ${levelIconHtml(data.level, true)}
      <span class="elo">${data.elo ?? '—'}</span>
    `;
    attachLevelFallbacks(el);
    el._data = data;
  } catch (e) {
    el.classList.remove('loading');
    el.classList.add('error');
    el.querySelector('.modal-player__stats').innerHTML = `<span title="${escapeAttr(e.message)}">ошибка</span>`;
  }
}

// ========== Проактивная загрузка всех игроков (для среднего ELO) ==========
async function preloadAllPlayers() {
  const allPlayers = [];
  teamsData.forEach(team => team.players.forEach(p => allPlayers.push(p.faceit)));
  const unique = [...new Set(allPlayers.map(n => n.toLowerCase()))];

  const CONCURRENCY = 4;
  let idx = 0;
  const results = {};

  async function worker() {
    while (idx < unique.length) {
      const myIdx = idx++;
      const nick = unique[myIdx];
      const cacheKey = 'faceit:' + nick;
      let data = lsGet(cacheKey);
      try {
        if (!data) {
          const res = await fetch(API.faceit(nick));
          data = await res.json();
          if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
          lsSet(cacheKey, data);
        }
        if (typeof data.elo === 'number') results[nick] = data.elo;
      } catch (e) {}
      if (Object.keys(results).length % 5 === 0) updateAllTeamsAvg(results);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  updateAllTeamsAvg(results);
}

function updateAllTeamsAvg(eloMap) {
  document.querySelectorAll('.team').forEach(teamEl => {
    const teamName = teamEl.dataset.team;
    const team = teamsData.find(t => t.name === teamName);
    if (!team) return;
    const elos = team.players.map(p => eloMap[p.faceit.toLowerCase()]).filter(v => typeof v === 'number');
    if (!elos.length) return;
    const avg = Math.round(elos.reduce((a, b) => a + b, 0) / elos.length);
    const badge = teamEl.querySelector('.team__avg');
    if (badge) { badge.textContent = '~ ' + avg + ' ELO'; badge.classList.remove('hidden'); }
  });
}

// ========== Тултип ==========
let tooltipTimer = null;
function showTooltip(playerEl, evt) {
  const data = playerEl._data;
  if (!data) return;
  clearTimeout(tooltipTimer);
  tooltipTimer = setTimeout(() => {
    fillTooltip(data);
    tooltip.classList.remove('hidden');
    requestAnimationFrame(() => tooltip.classList.add('visible'));
    moveTooltip(evt);
  }, 150);
}
function hideTooltip() {
  clearTimeout(tooltipTimer);
  tooltip.classList.remove('visible');
  setTimeout(() => tooltip.classList.add('hidden'), 120);
}
function moveTooltip(evt) {
  const pad = 16;
  const w = tooltip.offsetWidth || 560;
  const h = tooltip.offsetHeight || 420;
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + w > window.innerWidth) x = evt.clientX - w - pad;
  if (y + h > window.innerHeight) y = evt.clientY - h - pad;
  tooltip.style.left = Math.max(8, x) + 'px';
  tooltip.style.top  = Math.max(8, y) + 'px';
}

function fillTooltip(d) {
  $('#tt-nick').textContent = d.nickname || '—';
  $('#tt-avatar').src = d.avatar || '';
  $('#tt-level').innerHTML = levelIconHtml(d.level, true);
  attachLevelFallbacks($('#tt-level'));
  $('#tt-elo').textContent = (d.elo ? d.elo + ' ELO' : '— ELO');

  const s = d.stats || {};
  $('#tt-matches').textContent = s.matches ?? '—';
  $('#tt-winrate').textContent = s.win_rate != null ? s.win_rate + '%' : '—';
  $('#tt-kd').textContent = s.kd ?? '—';
  $('#tt-kr').textContent = s.kr ?? '—';
  $('#tt-hs').textContent = s.hs != null ? s.hs + '%' : '—';
  $('#tt-adr').textContent = s.adr ?? '—';

  const recent = (d.recent || []).slice(0, 30);
  $('#tt-recent').innerHTML = renderRecentTable(recent);

  const eloPoints = recent.map(m => m.elo).filter(v => v != null).reverse();
  $('#tt-chart').innerHTML = renderEloChart(eloPoints);

  if (eloPoints.length >= 2) {
    const delta = eloPoints[eloPoints.length - 1] - eloPoints[0];
    const el = $('#tt-elo-delta');
    el.textContent = (delta >= 0 ? '+' : '') + delta + ' ELO за ' + eloPoints.length + ' матчей';
    el.classList.remove('plus', 'minus');
    el.classList.add(delta >= 0 ? 'plus' : 'minus');
  } else {
    $('#tt-elo-delta').textContent = '—';
  }

  const link = $('#tt-faceit');
  link.href = normalizeFaceitUrl(d.faceit_url, d.nickname);
}

// ========== SVG-график Elo ==========
function renderEloChart(points) {
  if (!points.length) return '<div style="color:var(--muted);font-size:11px;padding:8px">нет данных</div>';
  const W = 320, H = 70, pad = 6;
  const min = Math.min(...points), max = Math.max(...points);
  const range = max - min || 1;
  const stepX = (W - pad * 2) / Math.max(1, points.length - 1);
  const coords = points.map((v, i) => {
    const x = pad + i * stepX;
    const y = H - pad - ((v - min) / range) * (H - pad * 2);
    return [x, y];
  });
  const path = coords.map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`)).join(' ');
  const area = path + ` L${coords[coords.length-1][0]},${H} L${coords[0][0]},${H} Z`;
  const last = coords[coords.length - 1];

  return `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="eloFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ff5a1f" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="#ff5a1f" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#eloFill)"/>
      <path d="${path}" fill="none" stroke="#ff5a1f" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="${last[0]}" cy="${last[1]}" r="3" fill="#ff5a1f"/>
    </svg>
  `;
}

// ========== Таблица последних матчей ==========
function renderRecentTable(matches) {
  if (!matches.length) {
    return '<div style="color:var(--muted);font-size:11px;padding:6px">нет данных</div>';
  }
  const rows = matches.map((m) => {
    const isWin = m.winner === '1';
    const isLoss = m.winner === '0';
    const resultCls = isWin ? 'win' : isLoss ? 'loss' : '';
    const resultTxt = isWin ? 'W' : isLoss ? 'L' : '—';
    const date = m.finished_at
      ? new Date(m.finished_at * 1000).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
      : '—';
    return `
      <tr>
        <td class="rt__result ${resultCls}">${resultTxt}</td>
        <td class="rt__date">${date}</td>
        <td class="rt__map">${m.map || '—'}</td>
        <td class="rt__score">${m.score || '—'}</td>
        <td class="rt__num">${m.kills != null && m.deaths != null ? `${m.kills}/${m.deaths}/${m.assists ?? 0}` : '—'}</td>
        <td class="rt__num">${m.kd ?? '—'}</td>
        <td class="rt__num">${m.kr ?? '—'}</td>
        <td class="rt__num">${m.hs != null ? m.hs + '%' : '—'}</td>
        <td class="rt__num">${m.adr ?? '—'}</td>
      </tr>
    `;
  }).join('');

  return `
    <table class="rt">
      <thead>
        <tr>
          <th>Рез.</th><th>Дата</th><th>Карта</th><th>Счёт</th>
          <th>K/D/A</th><th>K/D</th><th>K/R</th><th>HS%</th><th>ADR</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ========== Поиск ==========
searchEl.addEventListener('input', () => {
  const q = searchEl.value.trim().toLowerCase();
  document.querySelectorAll('.team').forEach(el => {
    const name = el.dataset.team.toLowerCase();
    el.style.display = (!q || name.includes(q)) ? '' : 'none';
  });
});

// ========== Обновить ==========
$('#refreshAll').addEventListener('click', () => {
  Object.keys(localStorage).forEach(k => { if (k.startsWith('faceit:')) localStorage.removeItem(k); });
  document.querySelectorAll('.team__avg').forEach(b => { b.textContent = ''; b.classList.add('hidden'); });
  loadTeams();
});

// ========== Утилиты ==========
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

function normalizeFaceitUrl(url, nickname) {
  if (!url) return `https://www.faceit.com/ru/players/${encodeURIComponent(nickname)}`;
  let u = String(url).replace('{lang}', 'ru');
  if (!/^https?:\/\//i.test(u)) u = 'https://www.faceit.com' + (u.startsWith('/') ? '' : '/') + u;
  const match = u.match(/https?:\/\/www\.faceit\.com(https?:\/\/.+)$/i);
  if (match) u = match[1];
  return u;
}

function levelIconHtml(level, big = false) {
  const lvl = level ?? 1;
  const size = big ? 40 : 26;
  return `<img class="lvl-icon${big ? ' lvl-icon--big' : ''}"
    src="/assets/levels/${lvl}_lvl.png"
    alt="LVL ${level ?? '—'}"
    data-fallback="${escapeAttr(level ?? '—')}"
    style="width:${size}px;height:${size}px" />`;
}

function attachLevelFallbacks(root = document) {
  root.querySelectorAll('img.lvl-icon:not([data-bound])').forEach(img => {
    img.dataset.bound = '1';
    img.addEventListener('error', () => {
      const badge = document.createElement('span');
      badge.className = 'lvl';
      badge.textContent = img.dataset.fallback || '—';
      img.replaceWith(badge);
    });
  });
}

// ========== Старт ==========
loadTeams();
