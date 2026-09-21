// app.js — логика фронтенда
const API = {
  teams: '/api/teams',
  faceit: (nickname) => `/api/faceit?nickname=${encodeURIComponent(nickname)}`,
};

const CACHE_TTL = 10 * 60 * 1000; // 10 минут на клиенте

const $ = (sel) => document.querySelector(sel);
const teamsEl = $('#teams');
const statusEl = $('#status');
const searchEl = $('#search');
const tooltip = $('#tooltip');

let teamsData = [];

// ========== Кэш в localStorage ==========
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

// ========== Загрузка списка команд ==========
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
  } catch (e) {
    statusEl.textContent = 'Ошибка загрузки команд: ' + e.message;
    statusEl.classList.add('error');
  }
}

// ========== Рендер сетки команд ==========
function renderTeams(teams) {
  teamsEl.innerHTML = '';
  teams.forEach((team) => {
    const el = document.createElement('div');
    el.className = 'team';
    el.dataset.team = team.name;

    el.innerHTML = `
      <div class="team__head">
        <div class="team__title">
          <span class="team__name">${escapeHtml(team.name)}</span>
          <span class="team__avg hidden"></span>
        </div>
        <div class="team__toggle">▶</div>
      </div>
      <div class="team__body"></div>
    `;

    el.querySelector('.team__head').addEventListener('click', () => toggleTeam(el, team));
    teamsEl.appendChild(el);
  });
}

async function toggleTeam(teamEl, team) {
  const isOpen = teamEl.classList.contains('open');
  if (isOpen) {
    teamEl.classList.remove('open');
    return;
  }
  teamEl.classList.add('open');

  const body = teamEl.querySelector('.team__body');
  if (teamEl.dataset.loaded === '1') return; // уже загружено

  body.innerHTML = team.players.map(p => `
    <div class="player loading" data-nick="${escapeAttr(p.faceit)}" data-lenza="${escapeAttr(p.lenza)}">
      <div class="player__left">
        <img class="player__avatar" alt="" />
        <div>
          <div class="player__nick">${escapeHtml(p.faceit)}</div>
          <div class="player__lenza">${escapeHtml(p.lenza)}</div>
        </div>
      </div>
      <div class="player__stats"><span>загрузка…</span></div>
    </div>
  `).join('');

  // обработчики
  body.querySelectorAll('.player').forEach(playerEl => {
    playerEl.addEventListener('mouseenter', (e) => showTooltip(playerEl, e));
    playerEl.addEventListener('mousemove', moveTooltip);
    playerEl.addEventListener('mouseleave', hideTooltip);
    playerEl.addEventListener('click', () => {
      const url = playerEl.dataset.url
        || `https://www.faceit.com/ru/players/${encodeURIComponent(playerEl.dataset.nick)}`;
      window.open(url, '_blank', 'noopener');
    });
  });

  // грузим данные по каждому игроку (параллельно)
  await Promise.all(team.players.map((p) => loadPlayer(body, p)));
  updateTeamAvgElo(teamEl, body);
  teamEl.dataset.loaded = '1';
}

async function loadPlayer(container, player) {
  const el = container.querySelector(`.player[data-nick="${cssEscape(player.faceit)}"]`);
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
    if (data.avatar) el.querySelector('.player__avatar').src = data.avatar;
    el.querySelector('.player__stats').innerHTML = `
      ${levelIconHtml(data.level)}
      <span class="elo">${data.elo ?? '—'}</span>
    `;
    el._data = data;
  } catch (e) {
    el.classList.remove('loading');
    el.classList.add('error');
    el.querySelector('.player__stats').innerHTML = `<span title="${escapeAttr(e.message)}">ошибка</span>`;
  }
}

// ========== Средний ELO команды ==========
function updateTeamAvgElo(teamEl, body) {
  const elos = Array.from(body.querySelectorAll('.player'))
    .map(p => p._data?.elo)
    .filter(v => typeof v === 'number' && !isNaN(v));
  const badge = teamEl.querySelector('.team__avg');
  if (!badge) return;
  if (!elos.length) {
    badge.classList.add('hidden');
    return;
  }
  const avg = Math.round(elos.reduce((a, b) => a + b, 0) / elos.length);
  badge.textContent = '~ ' + avg + ' ELO';
  badge.classList.remove('hidden');
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
  const w = tooltip.offsetWidth || 360;
  const h = tooltip.offsetHeight || 320;
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
  $('#tt-elo').textContent = (d.elo ? d.elo + ' ELO' : '— ELO');

  const s = d.stats || {};
  $('#tt-matches').textContent = s.matches ?? '—';
  $('#tt-winrate').textContent = s.win_rate != null ? s.win_rate + '%' : '—';
  $('#tt-kd').textContent = s.kd ?? '—';
  $('#tt-kr').textContent = s.kr ?? '—';
  $('#tt-hs').textContent = s.hs != null ? s.hs + '%' : '—';
  $('#tt-adr').textContent = s.adr ?? '—';

  // Полоска последних матчей
  const recent = (d.recent || []).slice().reverse();
  const dots = recent.map(m => {
    const cls = m.winner === '1' ? 'win' : m.winner === '0' ? 'loss' : 'unknown';
    return `<span class="recent__dot ${cls}" title="${m.score || ''}"></span>`;
  }).join('');
  $('#tt-recent').innerHTML = dots || '<span style="color:var(--muted);font-size:11px">нет данных</span>';

  // График Elo
  const eloPoints = recent.map(m => m.elo).filter(v => v != null);
  $('#tt-chart').innerHTML = renderEloChart(eloPoints);

  // Дельта Elo
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

// ========== Поиск ==========
searchEl.addEventListener('input', () => {
  const q = searchEl.value.trim().toLowerCase();
  document.querySelectorAll('.team').forEach(el => {
    const name = el.dataset.team.toLowerCase();
    const players = el.querySelectorAll('.player__nick');
    const matchTeam = name.includes(q);
    const matchPlayer = Array.from(players).some(p => p.textContent.toLowerCase().includes(q));
    el.style.display = (!q || matchTeam || matchPlayer) ? '' : 'none';
  });
});

// ========== Обновить ==========
$('#refreshAll').addEventListener('click', () => {
  Object.keys(localStorage).forEach(k => { if (k.startsWith('faceit:')) localStorage.removeItem(k); });
  document.querySelectorAll('.team').forEach(t => {
    t.dataset.loaded = '0';
    t.classList.remove('open');
    const avg = t.querySelector('.team__avg');
    if (avg) { avg.textContent = ''; avg.classList.add('hidden'); }
  });
  loadTeams();
});

// ========== Утилиты ==========
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

// Нормализует URL профиля Faceit: убирает {lang}, убирает дублирование домена
function normalizeFaceitUrl(url, nickname) {
  if (!url) {
    return `https://www.faceit.com/ru/players/${encodeURIComponent(nickname)}`;
  }
  let u = String(url).replace('{lang}', 'ru');
  // если вдруг пришло без протокола — добавим
  if (!/^https?:\/\//i.test(u)) u = 'https://www.faceit.com' + (u.startsWith('/') ? '' : '/') + u;
  // если пришло с двойным доменом — оставим только второй https://
  const match = u.match(/https?:\/\/www\.faceit\.com(https?:\/\/.+)$/i);
  if (match) u = match[1];
  return u;
}

// HTML иконки уровня: пробуем PNG, при ошибке — текстовый бейдж
function levelIconHtml(level, big = false) {
  const lvl = level ?? 1;
  const size = big ? 26 : 22;
  const fallback = `<span class="lvl">${level ?? '—'}</span>`;
  return `<img class="lvl-icon${big ? ' lvl-icon--big' : ''}"
    src="/assets/levels/${lvl}_lvl.png"
    alt="LVL ${level ?? '—'}"
    style="width:${size}px;height:${size}px"
    onerror="this.onerror=null;this.outerHTML='${fallback.replace(/'/g, "\\'")}'" />`;
}

// ========== Старт ==========
loadTeams();
