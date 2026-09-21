// api/faceit.js
// Serverless-функция Vercel: прокси к Faceit Data API.
// Ключ берётся из переменной окружения FACEIT_API_KEY (задаётся в дашборде Vercel).

export default async function handler(req, res) {
  // CORS для локальной разработки (на Vercel фронт и API на одном домене, но пусть будет)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const apiKey = process.env.FACEIT_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'FACEIT_API_KEY не задан в переменных окружения Vercel' });
  }

  const { nickname } = req.query;
  if (!nickname || typeof nickname !== 'string') {
    return res.status(400).json({ error: 'Не указан параметр nickname' });
  }

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json',
  };

  const base = 'https://open.faceit.com/data/v4';

  try {
    // 1. Профиль игрока
    const playerRes = await fetch(`${base}/players?nickname=${encodeURIComponent(nickname)}`, { headers });
    if (!playerRes.ok) {
      const text = await playerRes.text();
      return res.status(playerRes.status).json({
        error: `Faceit API: ${playerRes.status}`,
        details: text.slice(0, 300),
        nickname,
      });
    }
    const player = await playerRes.json();

    // 2. Статистика CS2 (lifetime)
    let stats = null;
    try {
      const statsRes = await fetch(`${base}/players/${player.player_id}/stats/cs2`, { headers });
      if (statsRes.ok) {
        stats = await statsRes.json();
      }
    } catch (e) {
      // игрок может не иметь CS2-статистики — не критично
    }

    // 3. Последние матчи (для графика Elo и полоски W/L)
    let history = null;
    try {
      const histRes = await fetch(
        `${base}/players/${player.player_id}/history?game=cs2&offset=0&limit=30`,
        { headers }
      );
      if (histRes.ok) {
        history = await histRes.json();
      }
    } catch (e) {
      // истории может не быть — не критично
    }

    // Собираем ответ в удобном для фронта виде
    const games = player.games?.cs2 || {};
    const lifetime = stats?.lifetime || {};

    const response = {
      player_id: player.player_id,
      nickname: player.nickname,
      avatar: player.avatar || null,
      country: player.country || null,
      faceit_url: player.faceit_url || null,
      elo: games.faceit_elo || null,
      level: games.skill_level || null,
      region: games.region || null,
      stats: {
        matches: lifetime['Matches'] || null,
        win_rate: lifetime['Win Rate %'] || null,
        kd: lifetime['Average K/D Ratio'] || null,
        kr: lifetime['Average K/R Ratio'] || null,
        hs: lifetime['Average Headshots %'] || null,
        adr: lifetime['ADR'] || null,
        wins: lifetime['Wins'] || null,
      },
      recent: (history?.items || []).map((m) => ({
        match_id: m.match_id,
        finished_at: m.finished_at,
        winner: m.results?.winner || null,
        score: m.results?.score || null,
        elo: m.elo ? Number(m.elo) : null,
        // Faceit не всегда отдаёт сторону игрока — оставим как есть
      })),
      _raw_keys: Object.keys(lifetime), // временно: посмотреть, какие поля реально приходят
    };

    // Кэш на 5 минут на стороне Vercel
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json(response);

  } catch (err) {
    return res.status(500).json({
      error: 'Внутренняя ошибка прокси',
      message: err.message,
      nickname,
    });
  }
}
