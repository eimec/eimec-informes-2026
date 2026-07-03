// Vercel Serverless Function - api/ac-extra.js
// Proxy al endpoint NUEVO de WordPress (F1 por país + tratos por curso/país + por vendedor).
// Si el snippet aún no está activo, devuelve ok:false y el front simplemente no muestra las tablas extra.

const WP_EXTRA = 'https://www.eimec.com/wp-json/eimec/v1/ac-extra';
const WP_KEY = 'eimec2026dash';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const response = await fetch(`${WP_EXTRA}?key=${WP_KEY}`, { headers: { 'Accept': 'application/json' } });
    if (!response.ok) { res.status(200).json({ ok: false }); return; }
    const data = await response.json();
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json(data);
  } catch (error) {
    res.status(200).json({ ok: false, error: error.message });
  }
}
