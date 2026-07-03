// Vercel Serverless Function - api/ac-extra.js
// Consulta ActiveCampaign DIRECTO desde Vercel (sin WordPress).
// Necesita la variable de entorno AC_API_KEY (se configura en Vercel → Settings → Environment Variables).
// Devuelve: por vendedor (owner), y por país / curso con F1..Won (país/curso es "best effort" según volumen).

export const config = { maxDuration: 60 };

const AC_BASE = 'https://eimec.api-us1.com/api/3';
const STAGES = { f1: 33, f2: 34, f3: 36, f4: 37 };
const CF_PAIS = 40;
const CF_CURSO = 3;

async function acGet(key, path, params = {}) {
  const qs = new URLSearchParams({ ...params, api_token: key }).toString();
  try {
    const r = await fetch(`${AC_BASE}${path}?${qs}`, { headers: { Accept: 'application/json' } });
    if (!r.ok) return {};
    return await r.json();
  } catch (_) { return {}; }
}

function addTo(bucket, k, s) {
  if (!k) k = 'Sin asignar';
  if (!bucket[k]) bucket[k] = { f1: 0, f2: 0, f3: 0, f4: 0, won: 0, total: 0 };
  bucket[k][s]++; bucket[k].total++;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const KEY = process.env.AC_API_KEY;
  if (!KEY) { res.status(200).json({ ok: false, error: 'no_key' }); return; }

  const start = Date.now();
  const budget = () => Date.now() - start < 48000; // deja margen antes del límite de 60s

  try {
    // 1) Usuarios (vendedores) — barato
    const ownerMap = {};
    for (let off = 0, guard = 0; guard < 30; guard++, off += 100) {
      const d = await acGet(KEY, '/users', { limit: 100, offset: off });
      const users = d.users || [];
      users.forEach(u => {
        let name = `${u.firstName || ''} ${u.lastName || ''}`.trim();
        if (!name) name = u.username || `Usuario ${u.id}`;
        if (u.id) ownerMap[u.id] = name;
      });
      if (users.length < 100) break;
    }

    // 2) Recoger deals (F1..F4 abiertos + Won) — guardamos contact + owner + etapa
    const deals = [];
    for (const [sk, sid] of Object.entries(STAGES)) {
      for (let off = 0, guard = 0; guard < 60; guard++, off += 100) {
        const d = await acGet(KEY, '/deals', { 'filters[stage]': sid, 'filters[status]': 0, limit: 100, offset: off });
        const arr = d.deals || [];
        arr.forEach(x => deals.push({ contact: x.contact, owner: x.owner, sk }));
        if (arr.length < 100) break;
      }
    }
    for (let off = 0, guard = 0; guard < 80; guard++, off += 100) {
      const d = await acGet(KEY, '/deals', { 'filters[status]': 1, limit: 100, offset: off });
      const arr = d.deals || [];
      arr.forEach(x => deals.push({ contact: x.contact, owner: x.owner, sk: 'won' }));
      if (arr.length < 100) break;
    }

    // 3) by_owner — barato, siempre disponible
    const by_owner = {};
    deals.forEach(d => addTo(by_owner, ownerMap[d.owner] || 'Sin asignar', d.sk));

    // 4) Mapear país/curso por contacto (best effort dentro del presupuesto de tiempo)
    const paisMap = {}, cursoMap = {};
    const mapField = async (fieldid, target) => {
      for (let off = 0, guard = 0; guard < 400; guard++, off += 100) {
        if (!budget()) return false;
        const d = await acGet(KEY, '/fieldValues', { 'filters[fieldid]': fieldid, limit: 100, offset: off });
        const rows = d.fieldValues || [];
        rows.forEach(r => { if (r.contact) target[r.contact] = (r.value || '').trim(); });
        if (rows.length < 100) break;
      }
      return true;
    };
    const paisOk = await mapField(CF_PAIS, paisMap);
    const cursoOk = await mapField(CF_CURSO, cursoMap);

    // 5) by_pais / by_curso
    const by_pais = {}, by_curso = {};
    if (paisOk) deals.forEach(d => addTo(by_pais, paisMap[d.contact] || 'Sin pais', d.sk));
    if (cursoOk) deals.forEach(d => addTo(by_curso, cursoMap[d.contact] || 'Sin curso', d.sk));

    let tot_f1 = 0; Object.values(by_pais).forEach(b => tot_f1 += b.f1);

    res.status(200).json({
      ok: true,
      by_owner,
      by_pais: paisOk ? by_pais : {},
      by_curso: cursoOk ? by_curso : {},
      total_f1: tot_f1,
      partial: !(paisOk && cursoOk),
      ms: Date.now() - start
    });
  } catch (error) {
    res.status(200).json({ ok: false, error: error.message });
  }
}
