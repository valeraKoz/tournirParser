// api/faceit.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.FACEIT_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'FACEIT_API_KEY не задан в переменных окружения Vercel' });
  }

  const { nickname } = req.query;
  if (!nickname || typeof nickname !== 'string') {
    return res.status(400).json({ error: 'Не указан параметр nickname' });
  }

  const headers = { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' };
  const base = 'https://open.faceit.com/data/v4';

  try {
    // 1. Профиль
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

    // 2. Lifetime-статистика CS2
    let stats = null;
    try {
      const statsRes = await fetch(`${base}/players/${player.player_id}/stats/cs2`, { headers });
      if (statsRes.ok) stats = await statsRes.json();
    } catch (e) {}

    // 3. История последних 30 матчей + детальная статистика каждого
    let history = null;
    const matchStatsMap = {};
    try {
      const histRes = await fetch(
        `${base}/players/${player.player_id}/history?game=cs2&offset=0&limit=30`,
        { headers }
      );
      if (histRes.ok) {
        history = await histRes.json();
        const items = history.items || [];
        const CONC = 5;
        for (let i = 0; i < items.length; i += CONC) {
          const chunk = items.slice(i, i + CONC);
          await Promise.all(chunk.map(async (m) => {
            try {
              const stRes = await fetch(`${base}/matches/${m.match_id}/stats`, { headers });
              if (!stRes.ok) return;
              const st = await stRes.json();
              const round = st.rounds?.[0];
              if (!round) return;
              const teamsObj = round.teams || {};
              const teamId = Object.keys(teamsObj).find(tid =>
                (teamsObj[tid].players || []).some(p => p.player_id === player.player_id)
              );
              if (!teamId) return;
              const playerStats = teamsObj[teamId].players.find(p => p.player_id === player.player_id);
              if (!playerStats) return;
              matchStatsMap[m.match_id] = {
                map: round.round_stats?.Map || null,
                score: round.round_stats?.Score || null,
                kd: playerStats.player_stats?.['K/D Ratio'] || null,
                kr: playerStats.player_stats?.['K/R Ratio'] || null,
                hs: playerStats.player_stats?.['Headshots %'] || null,
                adr: playerStats.player_stats?.ADR || null,
                kills: playerStats.player_stats?.Kills || null,
                deaths: playerStats.player_stats?.Deaths || null,
                assists: playerStats.player_stats?.Assists || null,
              };
            } catch (e) {}
          }));
        }
      }
    } catch (e) {}

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
        ...(matchStatsMap[m.match_id] || {}),
      })),
    };

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json(response);

  } catch (err) {
    return res.status(500).json({ error: 'Внутренняя ошибка прокси', message: err.message, nickname });
  }
}
