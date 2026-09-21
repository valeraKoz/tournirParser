// api/teams.js
import teams from '../data/teams.json' assert { type: 'json' };

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600');
  return res.status(200).json(teams);
}
