// api/teams.js
import { readFileSync } from 'fs';
import { join } from 'path';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600');

  try {
    const filePath = join(process.cwd(), 'data', 'teams.json');
    const raw = readFileSync(filePath, 'utf-8');
    const teams = JSON.parse(raw);
    return res.status(200).json(teams);
  } catch (e) {
    return res.status(500).json({ error: 'Не удалось прочитать data/teams.json', message: e.message });
  }
}
