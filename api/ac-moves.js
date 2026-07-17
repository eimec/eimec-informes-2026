// Vercel Serverless Function - api/ac-moves.js
// MOVIMIENTOS DE FASE del periodo: cuántos tratos PASARON a F2/F3/F4 entre from y to,
// da igual cuándo se creó el lead. Lee el registro de actividad global de AC
// (/dealActivities, dataType='d_stageid' = cambio de etapa) paginando de HOY hacia atrás
// hasta cubrir el rango. Etapas 34/36/37 son del pipeline de ventas (group 1), así que
// filtrar por etapa destino ya restringe el pipeline. Necesita AC_API_KEY.
export const config = { maxDuration: 60 };

const AC_BASE = 'https://eimec.api-us1.com/api/3';
const TARGET = { '34': 'f2', '36': 'f3', '37': 'f4' };   // etapa destino -> paso del embudo
const MAX_PAGES = 400;          // tope de seguridad (40.000 actividades)
const TIME_BUDGET = 42000;      // ms; si no llegamos al 'from', devolvemos partial:true

async function acGet(key, params) {
  const qs = new URLSearchParams(params).toString();
  try {
    const r = await fetch(`${AC_BASE}/dealActivities?${qs}`, { headers: { Accept: 'application/json', 'Api-Token': key } });
    if (!r.ok) return {};
    return await r.json();
  } catch (_) { return {}; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');

  const KEY = process.env.AC_API_KEY;
  if (!KEY) { res.status(200).json({ ok: false, error: 'no_key' }); return; }

  const { from, to } = req.query;
  if (!from || !to) { res.status(200).json({ ok: false, error: 'faltan from/to' }); return; }

  const start = Date.now();
  const seen = { f2: new Set(), f3: new Set(), f4: new Set() };
  const wonMoves = new Set();
  let oldest = null, pages = 0, partial = false, done = false;

  try {
    const B = 8;   // páginas en paralelo por tanda
    for (let wave = 0; !done; wave++) {
      const offs = [];
      for (let i = 0; i < B; i++) offs.push((wave * B + i) * 100);
      const results = await Promise.all(offs.map(o => acGet(KEY, { limit: 100, offset: o, 'orders[cdate]': 'DESC' })));
      for (const d of results) {
        const acts = d.dealActivities || [];
        pages++;
        for (const a of acts) {
          const day = String(a.cdate || '').slice(0, 10);
          if (!oldest || day < oldest) oldest = day;
          if (day >= from && day <= to) {
            if (a.dataType === 'd_stageid' && TARGET[a.dataAction]) seen[TARGET[a.dataAction]].add(String(a.deal || a.d_id));
            if (a.dataType === 'status' && a.dataAction === '1') wonMoves.add(String(a.deal || a.d_id));
          }
        }
        if (acts.length < 100) done = true;          // fin del registro
      }
      if (oldest && oldest < from) done = true;      // ya cubrimos todo el rango
      if (pages >= MAX_PAGES || (Date.now() - start) > TIME_BUDGET) {
        if (!(oldest && oldest < from)) partial = true;   // nos quedamos cortos
        done = true;
      }
    }

    res.status(200).json({
      ok: true,
      moves: { f2: seen.f2.size, f3: seen.f3.size, f4: seen.f4.size },
      won_moves: wonMoves.size,
      partial, pages, oldest,
      period: { from, to }, ms: Date.now() - start
    });
  } catch (error) {
    res.status(200).json({ ok: false, error: error.message });
  }
}
