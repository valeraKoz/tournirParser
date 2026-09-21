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
const modal = $('#modal');
const modalBody = $('#modal-body');
const modalTitle = $('#modal-title');

let teamsData = [];

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
  } catch (e) {
    statusEl.textContent = 'Ошибка загрузки команд: ' + e.message;
    statusEl.classList.add('error');
  }
}

// ========== Сетка команд ==========
function renderTeams(teams) {
  teamsEl.innerHTML = '';
  teams.forEach((team) => {
    const el = document.createElement('div');
    el.className = 'team';
    el.dataset.team = team.name;
    el.innerHTML = `
      <span class="team__name">${escapeHtml(team.name)}</span>
      <span class="team__arrow">→</span>
    `;
    el.addEventListener('click', () => openTeamModal(team, el));
    teamsEl.appendChild(el);
  });
}

// ========== Открытие модалки: грузим всех игроков, потом показываем ==========
async function openTeamModal(team, teamEl) {
  if (teamEl.dataset.busy === '1') return;
  teamEl.dataset.busy = '1';

  const results = await Promise.all(team.players.map(p => fetchPlayerWithRetry(p.faceit)));

  teamEl.dataset.busy = '0';

  modalTitle.textContent = team.name;
  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');

  modalBody.innerHTML = team.players.map((p, i) => {
    const data = results[i];
    const avatar = data?.avatar ? `src="${escapeAttr(data.avatar)}"` : '';
    const levelHtml = data
      ? levelIconHtml(data.level, false)
      : `<span class="lvl-slot"><span class="lvl-text">—</span></span>`;
    const eloHtml = data
      ? `<span class="acc__elo">${data.elo ?? '—'}</span>`
      : `<span class="acc__elo">—</span>`;
    return `
      <div class="acc" data-nick="${escapeAttr(p.faceit)}" ${data ? 'data-loaded="1"' : ''}>
        <div class="acc__head">
          <div class="acc__left">
            <img class="acc__avatar" alt="" ${avatar} />
            <div class="acc__info">
              <div class="acc__nick">${escapeHtml(p.faceit)}</div>
              <div class="acc__lenza">${escapeHtml(p.lenza)}</div>
            </div>
          </div>
          <div class="acc__right">
            ${levelHtml}
            ${eloHtml}
            <span class="acc__chev">▶</span>
          </div>
        </div>
        <div class="acc__body"></div>
      </div>
    `;
  }).join('');

  modalBody.querySelectorAll('.acc').forEach((accEl, i) => {
    const data = results[i];
    if (data) {
      accEl._data = data;
      accEl.querySelector('.acc__body').innerHTML = renderPlayerCard(data);
      attachLevelFallbacks(accEl);
    } else {
      accEl.querySelector('.acc__body').innerHTML =
        '<div style="color:var(--red);padding:10px">Не удалось загрузить данные. Кликните по игроку, чтобы попробовать снова.</div>';
    }
    accEl.querySelector('.acc__head').addEventListener('click', () => toggleAccordion(accEl, team.players[i]));
  });
}

function closeModal() {
  modal.classList.add('hidden');
  document.body.classList.remove('modal-open');
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
});
$('#modal-close').addEventListener('click', closeModal);
$('#modal-overlay').addEventListener('click', closeModal);

// ========== Аккордеон ==========
async function toggleAccordion(accEl, player) {
  const isOpen = accEl.classList.contains('open');
  if (isOpen) { accEl.classList.remove('open'); return; }

  modalBody.querySelectorAll('.acc.open').forEach(a => a.classList.remove('open'));
  accEl.classList.add('open');

  if (accEl._data) return;

  accEl.classList.add('loading');
  const data = await fetchPlayerWithRetry(player.faceit);
  accEl.classList.remove('loading');

  if (!data) {
    accEl.querySelector('.acc__body').innerHTML =
      '<div style="color:var(--red);padding:10px">Не удалось загрузить данные. Закройте и откройте команду заново.</div>';
    return;
  }

  accEl._data = data;
  if (data.avatar) accEl.querySelector('.acc__avatar').src = data.avatar;
  accEl.querySelector('.acc__right').innerHTML = `
    ${levelIconHtml(data.level, false)}
    <span class="acc__elo">${data.elo ?? '—'}</span>
    <span class="acc__chev">▶</span>
  `;
  attachLevelFallbacks(accEl);
  accEl.querySelector('.acc__body').innerHTML = renderPlayerCard(data);
  attachLevelFallbacks(accEl.querySelector('.acc__body'));
}

// ========== Загрузка игрока с 3 попытками ==========
async function fetchPlayerWithRetry(nickname) {
  const cacheKey = 'faceit:' + nickname.toLowerCase();
  const cached = lsGet(cacheKey);
  if (cached) return cached;

  const delays = [0, 1500, 4000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await sleep(delays[i]);
    try {
      const res = await fetch(API.faceit(nickname));
      const data = await res.json();
      if (!res.ok) {
        if (res.status !== 429 && res.status < 500) return null;
        continue;
      }
      lsSet(cacheKey, data);
      return data;
    } catch (e) {}
  }
  return null;
}

// ========== Карточка игрока ==========
function renderPlayerCard(d) {
  const s = d.stats || {};
  const recent = (d.recent || []).slice(0, 30);
  const recentReversed = recent.slice().reverse();

  const dots = recentReversed.map(m => {
    const cls = m.winner === '1' ? 'win' : m.winner === '0' ? 'loss' : 'unknown';
    return `<span class="pc__dot ${cls}"></span>`;
  }).join('');

  const wins = recentReversed.filter(m => m.winner === '1').length;
  const losses = recentReversed.filter(m => m.winner === '0').length;

  const eloPoints = recentReversed.map(m => m.elo).filter(v => v != null);
  const chartSvg = renderEloChart(eloPoints);
  let deltaHtml = '<span class="delta">—</span>';
  if (eloPoints.length >= 2) {
    const delta = eloPoints[eloPoints.length - 1] - eloPoints[0];
    const cls = delta >= 0 ? 'plus' : 'minus';
    deltaHtml = `<span class="delta ${cls}">${delta >= 0 ? '+' : ''}${delta} ELO</span>`;
  }

  return `
    <div class="pc">
      <div class="pc__season">
        <div class="pc__season-left">
          <span class="pc__season-name">Season 9</span>
          <span class="pc__season-sub">Матчмейкинг</span>
        </div>
        <div class="pc__season-right">Статистика Season 9</div>
      </div>

      <div class="pc__elo-block">
        <div class="pc__level-wrap">
          ${levelIconHtml(d.level, true)}
        </div>
        <div class="pc__elo-num">${d.elo ?? '—'}</div>
      </div>

      <div class="pc__summary">
        <div class="pc__summary-cell">
          <span class="pc__summary-label">Матчи</span>
          <span class="pc__summary-value">${s.matches ?? '—'}</span>
        </div>
        <div class="pc__summary-cell">
          <span class="pc__summary-label">Процент побед</span>
          <span class="pc__summary-value">${s.win_rate != null ? s.win_rate + '%' : '—'}</span>
        </div>
      </div>

      <div class="pc__recent-title">
        <span>Недавние результаты</span>
        <span class="muted">Последние матчи (30)</span>
      </div>

      <div class="pc__dots-row">
        <span class="label">Изменение Elo</span>
        ${deltaHtml}
        <span class="pc__dots">${dots}</span>
      </div>

      <div class="pc__chart">
        <div class="pc__chart-head">
          <span class="left">Изменение Elo по матчам</span>
          <span class="w">${wins} W</span>
          <span class="l">${losses} L</span>
        </div>
        <div class="pc__chart-svg">${chartSvg}</div>
      </div>

      <div class="pc__grid">
        <div class="pc__cell">
          <div class="pc__cell-label">K/D/A</div>
          <div class="pc__cell-value big">${avgKda(recent)}</div>
        </div>
        <div class="pc__cell">
          <div class="pc__cell-label">K/D</div>
          <div class="pc__cell-value big">${s.kd ?? '—'}</div>
        </div>
        <div class="pc__cell">
          <div class="pc__cell-label">K/R</div>
          <div class="pc__cell-value big">${s.kr ?? '—'}</div>
        </div>
        <div class="pc__cell">
          <div class="pc__cell-label">HS%</div>
          <div class="pc__cell-value big">${s.hs != null ? s.hs + '%' : '—'}</div>
        </div>
        <div class="pc__cell">
          <div class="pc__cell-label">ADR</div>
          <div class="pc__cell-value big">${s.adr ?? '—'}</div>
        </div>
        <div class="pc__cell">
          <div class="pc__cell-label">Процент побед</div>
          <div class="pc__cell-value big">${s.win_rate != null ? s.win_rate + '%' : '—'}</div>
        </div>
      </div>

      <div class="pc__table-wrap">
        <div class="pc__table-head">
          <span>Последние матчи</span>
          <span>${recent.length}</span>
        </div>
        <div class="pc__table-scroll">
          ${renderRecentTable(recent)}
        </div>
      </div>

      <div class="pc__footer">
        <span class="muted">Источник: FACEIT API</span>
        <a href="${normalizeFaceitUrl(d.faceit_url, d.nickname)}" target="_blank" rel="noopener">Открыть профиль →</a>
      </div>
    </div>
  `;
}

function avgKda(recent) {
  const arr = recent.filter(m => m.kills != null && m.deaths != null);
  if (!arr.length) return '—';
  const kills = arr.reduce((a, m) => a + Number(m.kills), 0);
  const deaths = arr.reduce((a, m) => a + Number(m.deaths), 0);
  const assists = arr.reduce((a, m) => a + Number(m.assists || 0), 0);
  return `${Math.round(kills / arr.length)} / ${Math.round(deaths / arr.length)} / ${Math.round(assists / arr.length)}`;
}

// ========== SVG-график Elo ==========
function renderEloChart(points) {
  if (!points.length) return '<div style="color:var(--muted);font-size:11px;padding:8px">нет данных</div>';
  const W = 320, H = 80, pad = 6;
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
    return '<div style="color:var(--muted);font-size:11px;padding:8px">нет данных</div>';
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
        <td>${m.map || '—'}</td>
        <td>${m.score || '—'}</td>
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
  loadTeams();
});

// ========== Утилиты ==========
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

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
  const cls = big ? ' lvl-slot--big' : '';
  return `<span class="lvl-slot${cls}">
    <img class="lvl-icon"
      src="/assets/levels/${lvl}_lvl.png"
      alt="LVL ${level ?? '—'}"
      data-fallback="${escapeAttr(level ?? '—')}" />
  </span>`;
}

function attachLevelFallbacks(root = document) {
  root.querySelectorAll('img.lvl-icon:not([data-bound])').forEach(img => {
    img.dataset.bound = '1';
    img.addEventListener('error', () => {
      const slot = img.closest('.lvl-slot');
      if (!slot) { img.remove(); return; }
      const badge = document.createElement('span');
      badge.className = 'lvl-text';
      badge.textContent = img.dataset.fallback || '—';
      slot.innerHTML = '';
      slot.appendChild(badge);
    });
  });
}

// ========== Старт ==========
loadTeams();
