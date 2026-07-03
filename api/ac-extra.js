// Vercel Serverless Function - api/ac-extra.js
// MOTOR DE DATOS: dado un rango de fechas (from/to sobre fecha de CREACIÓN del trato),
// devuelve tratos totales (F1+F2+F3+F4+Won) desglosados por PAÍS, CURSO y VENDEDOR.
// País y curso se leen del contacto (matcheando deal.contact). Necesita AC_API_KEY.

export const config = { maxDuration: 60 };

const AC_BASE = 'https://eimec.api-us1.com/api/3';
const STAGES = { f1: 33, f2: 34, f3: 36, f4: 37 };
const CF_PAIS = 40;
const CF_CURSO = 3;

async function acGet(key, path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${AC_BASE}${path}${qs ? ('?' + qs) : ''}`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'Api-Token': key } });
    if (!r.ok) return {};
    return await r.json();
  } catch (_) { return {}; }
}

// Trae todos los items de un recurso paginado, en paralelo (rápido)
async function fetchAll(key, path, baseParams, arrKey, cap = 30000) {
  const first = await acGet(key, path, { ...baseParams, limit: 100, offset: 0 });
  const items = first[arrKey] || [];
  const total = (first.meta && first.meta.total) ? Math.min(parseInt(first.meta.total, 10), cap) : items.length;
  const offsets = [];
  for (let o = 100; o < total; o += 100) offsets.push(o);
  const B = 12;
  for (let i = 0; i < offsets.length; i += B) {
    const r = await Promise.all(offsets.slice(i, i + B).map(o => acGet(key, path, { ...baseParams, limit: 100, offset: o })));
    r.forEach(x => { if (x[arrKey]) items.push(...x[arrKey]); });
  }
  return items;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');

  const KEY = process.env.AC_API_KEY;
  if (!KEY) { res.status(200).json({ ok: false, error: 'no_key' }); return; }

  const { from, to } = req.query;
  const dateParams = {};
  if (from) dateParams['filters[created_after]'] = from;
  if (to) dateParams['filters[created_before]'] = to;

  const start = Date.now();
  try {
    // 1) Mapas (vendedor, país, curso) — en paralelo
    const [users, paisVals, cursoVals] = await Promise.all([
      fetchAll(KEY, '/users', {}, 'users', 3000),
      fetchAll(KEY, '/fieldValues', { 'filters[fieldid]': CF_PAIS }, 'fieldValues'),
      fetchAll(KEY, '/fieldValues', { 'filters[fieldid]': CF_CURSO }, 'fieldValues')
    ]);
    const ownerMap = {};
    users.forEach(u => {
      let name = `${u.firstName || ''} ${u.lastName || ''}`.trim();
      if (!name) name = u.username || `Usuario ${u.id}`;
      if (u.id) ownerMap[u.id] = name;
    });
    const paisMap = {}, cursoMap = {};
    paisVals.forEach(v => { if (v.contact) paisMap[v.contact] = (v.value || '').trim(); });
    cursoVals.forEach(v => { if (v.contact) cursoMap[v.contact] = (v.value || '').trim(); });

    // 2) Tratos por etapa (abiertos) + ganados, filtrados por fecha de creación
    const by_owner = {}, by_pais = {}, by_curso = {};
    const add = (b, k, s) => {
      if (!k) k = 'Sin dato';
      if (!b[k]) b[k] = { f1: 0, f2: 0, f3: 0, f4: 0, won: 0, total: 0 };
      b[k][s]++; b[k].total++;
    };
    const tally = (d, s) => {
      const c = d.contact;
      add(by_owner, ownerMap[d.owner] || 'Sin asignar', s);
      add(by_pais, (paisMap[c] && paisMap[c] !== '') ? paisMap[c] : 'Sin país', s);
      add(by_curso, (cursoMap[c] && cursoMap[c] !== '') ? cursoMap[c] : 'Sin curso', s);
    };

    for (const [sk, sid] of Object.entries(STAGES)) {
      const deals = await fetchAll(KEY, '/deals', { 'filters[stage]': sid, 'filters[status]': 0, ...dateParams }, 'deals');
      deals.forEach(d => tally(d, sk));
    }
    const wonDeals = await fetchAll(KEY, '/deals', { 'filters[status]': 1, ...dateParams }, 'deals');
    wonDeals.forEach(d => tally(d, 'won'));

    // Totales de control
    let tot = { f1: 0, f2: 0, f3: 0, f4: 0, won: 0, total: 0 };
    Object.values(by_pais).forEach(b => { tot.f1 += b.f1; tot.f2 += b.f2; tot.f3 += b.f3; tot.f4 += b.f4; tot.won += b.won; tot.total += b.total; });
    const sinPais = by_pais['Sin país'] ? by_pais['Sin país'].total : 0;

    res.status(200).json({
      ok: true,
      by_owner, by_pais, by_curso,
      totals: tot,
      sin_pais: sinPais,
      period: { from: from || null, to: to || null },
      ms: Date.now() - start
    });
  } catch (error) {
    res.status(200).json({ ok: false, error: error.message });
  }
}
