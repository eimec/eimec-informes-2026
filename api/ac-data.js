// Vercel Serverless Function - api/ac-data.js
// Proxy al endpoint de WordPress que YA está conectado a ActiveCampaign y verificado.
// Se llama SERVER-SIDE (sin CORS, sin protección de página) y se reenvía el JSON tal cual.

export const config = { maxDuration: 60 };

const WP_PROXY = 'https://www.eimec.com/wp-json/eimec/v1/ac';
const WP_KEY = 'eimec2026dash';

export default async function handler(req, res) {
  // CORS para el frontend
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    // Reenviar filtros de fecha si vienen (from=YYYY-MM-DD&to=YYYY-MM-DD)
    const params = new URLSearchParams({ key: WP_KEY });
    if (req.query.from) params.set('from', req.query.from);
    if (req.query.to) params.set('to', req.query.to);

    const url = `${WP_PROXY}?${params.toString()}`;

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`Proxy WP respondió ${response.status}`);
    }

    const data = await response.json();

    // Cache corto en el edge para no saturar (5 min)
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json(data);
  } catch (error) {
    console.error('Error llamando al proxy WP:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
}
