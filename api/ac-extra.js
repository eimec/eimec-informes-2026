// Vercel Serverless Function - api/ac-extra.js
// SOLO rendimiento por vendedor (owner). El owner está en el trato → dato fiable.
// País/curso se omiten a propósito: están vacíos en la mayoría de tratos del CRM.
// Necesita la variable de entorno AC_API_KEY.

export const config = { maxDuration: 60 };

const AC_BASE = 'https://eimec.api-us1.com/api/3';
const STAGES = { f1: 33, f2: 34, f3: 36, f4: 37 };

async function acGet(key, path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${AC_BASE}${path}${qs ? ('?' + qs) : ''}`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'Api-Token': key } });
    if (!r.ok) return {};
    return await r.json();
  } catch (_) { return {}; }
}

// Trae todos los deals de una consulta, paginando en paralelo (rápido)
async function fetchAllDeals(key, baseParams) {
  const first = await acGet(key, '/deals', { ...baseParams, limit: 100, offset: 0 });
  const deals = first.deals || [];
  const total = (first.meta && first.meta.total) ? parseInt(first.meta.total, 10) : deals.length;
  const cap = Math.min(total, 20000);
  const offsets = [];
  for (let o = 100; o < cap; o += 100) offsets.push(o);
  const batch = 10;
  for (let i = 0; i < offsets.length; i += batch) {
    const slice = offsets.slice(i, i + batch);
    const results = await Promise.all(slice.map(o => acGet(key, '/deals', { ...baseParams, limit: 100, offset: o })));
    results.forEach(r => { if (r.deals) deals.push(...r.deals); });
  }
  return deals;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');

  const KEY = process.env.AC_API_KEY;
  if (!KEY) { res.status(200).json({ ok: false, error: 'no_key' }); return; }

  const start = Date.now();
  try {
    // 1) Vendedores (id → nombre)
    const ownerMap = {};
    for (let off = 0, guard = 0; guard < 20; guard++, off += 100) {
      const d = await acGet(KEY, '/users', { limit: 100, offset: off });
      const users = d.users || [];
      users.forEach(u => {
        let name = `${u.firstName || ''} ${u.lastName || ''}`.trim();
        if (!name) name = u.username || `Usuario ${u.id}`;
        if (u.id) ownerMap[u.id] = name;
      });
      if (users.length < 100) break;
    }

    // 2) Deals por etapa (abiertos) + ganados, en paralelo
    const by_owner = {};
    const add = (oid, sk) => {
      const owner = (ownerMap[oid] && ownerMap[oid] !== '') ? ownerMap[oid] : 'Sin asignar';
      if (!by_owner[owner]) by_owner[owner] = { f1: 0, f2: 0, f3: 0, f4: 0, won: 0, total: 0 };
      by_owner[owner][sk]++; by_owner[owner].total++;
    };

    for (const [sk, sid] of Object.entries(STAGES)) {
      const deals = await fetchAllDeals(KEY, { 'filters[stage]': sid, 'filters[status]': 0 });
      deals.forEach(d => add(d.owner, sk));
    }
    const wonDeals = await fetchAllDeals(KEY, { 'filters[status]': 1 });
    wonDeals.forEach(d => add(d.owner, 'won'));

    res.status(200).json({
      ok: true,
      by_owner,
      ms: Date.now() - start
    });
  } catch (error) {
    res.status(200).json({ ok: false, error: error.message });
  }
}
