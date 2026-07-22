// Vercel Serverless Function - api/ac-stock.js
// STOCK TOTAL del pipeline de ventas: cuántos tratos ABIERTOS hay AHORA en cada fase (histórico completo,
// SIN filtro de fechas). Es el "saldo" del CRM (ej. F1 ≈ 16.989). Las etapas 33/34/36/37 son del group 1.
export const config = { maxDuration: 30 };

const AC_BASE = 'https://eimec.api-us1.com/api/3';

async function count(key, stage) {
  // filters[group]=1 es redundante (las etapas 33/34/36/37 ya son solo de formación) pero lo dejamos EXPLÍCITO.
  const qs = new URLSearchParams({ 'filters[stage]': stage, 'filters[status]': 0, 'filters[group]': 1, limit: 1 }).toString();
  try {
    const r = await fetch(`${AC_BASE}/deals?${qs}`, { headers: { Accept: 'application/json', 'Api-Token': key } });
    if (!r.ok) return null;
    const j = await r.json();
    return (j.meta && j.meta.total) ? parseInt(j.meta.total, 10) : 0;
  } catch (_) { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');   // cambia poco: cache 30 min
  const KEY = process.env.AC_API_KEY;
  if (!KEY) { res.status(200).json({ ok: false, error: 'no_key' }); return; }
  try {
    const [f1, f2, f3, f4] = await Promise.all([count(KEY, 33), count(KEY, 34), count(KEY, 36), count(KEY, 37)]);
    const stock = { f1: f1 || 0, f2: f2 || 0, f3: f3 || 0, f4: f4 || 0 };
    res.status(200).json({ ok: true, stock, total: stock.f1 + stock.f2 + stock.f3 + stock.f4 });
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message });
  }
}
