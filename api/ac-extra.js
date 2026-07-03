// Vercel Serverless Function - api/ac-extra.js
// MOTOR DE DATOS: País y Curso son campos del TRATO (dealCustomFieldMeta 40=País, 3=Curso interesado),
// se leen con ?include=dealCustomFieldData. Devuelve tratos totales (F1+F2+F3+F4+Won) por PAÍS, CURSO y VENDEDOR,
// filtrados por FECHA DE CREACIÓN del trato (from/to). Necesita AC_API_KEY.

export const config = { maxDuration: 60 };

const AC_BASE = 'https://eimec.api-us1.com/api/3';
const STAGES = { f1: 33, f2: 34, f3: 36, f4: 37 };
const M_PAIS = '40';
const M_CURSO = '3';

const ISO2 = {
  ES:'Spain', MX:'Mexico', CL:'Chile', PE:'Peru', AR:'Argentina', CO:'Colombia', VE:'Venezuela', EC:'Ecuador',
  BO:'Bolivia', UY:'Uruguay', PY:'Paraguay', CR:'Costa Rica', GT:'Guatemala', SV:'El Salvador', HN:'Honduras',
  NI:'Nicaragua', PA:'Panama', DO:'Dominican Republic', CU:'Cuba', PR:'Puerto Rico', US:'United States',
  CA:'Canada', BR:'Brazil', IT:'Italy', FR:'France', DE:'Germany', GB:'United Kingdom', UK:'United Kingdom',
  PT:'Portugal', IE:'Ireland', CH:'Switzerland', NL:'Netherlands', BE:'Belgium', PL:'Poland', RO:'Romania',
  GR:'Greece', UA:'Ukraine', RU:'Russia', TR:'Turkey', IL:'Israel', AE:'United Arab Emirates', SA:'Saudi Arabia',
  QA:'Qatar', MA:'Morocco', EG:'Egypt', NG:'Nigeria', ZA:'South Africa', IN:'India', PK:'Pakistan',
  PH:'Philippines', LY:'Libya', MT:'Malta', AU:'Australia', SE:'Sweden', NO:'Norway', DK:'Denmark', AT:'Austria'
};
const ALIAS = { 'US':'United States','USA':'United States','U.S.':'United States','España':'Spain','Espana':'Spain','México':'Mexico','Mejico':'Mexico','Reino Unido':'United Kingdom','UK':'United Kingdom' };
function normPais(v) {
  if (!v) return 'Sin país';
  let k = String(v).trim();
  if (k === '') return 'Sin país';
  if (k.length === 2 && ISO2[k.toUpperCase()]) return ISO2[k.toUpperCase()];
  if (ALIAS[k]) return ALIAS[k];
  return k;
}

async function acGet(key, path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  try {
    const r = await fetch(`${AC_BASE}${path}${qs ? ('?' + qs) : ''}`, { headers: { Accept: 'application/json', 'Api-Token': key } });
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
  const dateParams = {};
  if (from) dateParams['filters[created_after]'] = from;
  if (to) dateParams['filters[created_before]'] = to;

  const start = Date.now();
  try {
    // Vendedores
    const ownerMap = {};
    for (let off = 0, g = 0; g < 20; g++, off += 100) {
      const d = await acGet(KEY, '/users', { limit: 100, offset: off });
      const us = d.users || [];
      us.forEach(u => { let n = `${u.firstName || ''} ${u.lastName || ''}`.trim(); if (!n) n = u.username || ('Usuario ' + u.id); if (u.id) ownerMap[u.id] = n; });
      if (us.length < 100) break;
    }

    const by_owner = {}, by_pais = {}, by_curso = {}, created_by_date = {};
    const add = (b, k, s) => { if (!k) k = 'Sin dato'; if (!b[k]) b[k] = { f1:0,f2:0,f3:0,f4:0,won:0,total:0 }; b[k][s]++; b[k].total++; };

    // Procesa una respuesta de /deals?include=dealCustomFieldData
    const process = (resp, sk) => {
      const cf = {};
      (resp.dealCustomFieldData || []).forEach(x => { (cf[x.deal_id] = cf[x.deal_id] || {})[x.custom_field_id] = x.custom_field_text_value; });
      (resp.deals || []).forEach(d => {
        const c = cf[d.id] || {};
        add(by_owner, ownerMap[d.owner] || 'Sin asignar', sk);
        add(by_pais, normPais(c[M_PAIS]), sk);
        const cu = c[M_CURSO] && String(c[M_CURSO]).trim(); add(by_curso, cu ? cu : 'Sin curso', sk);
        if (d.cdate) { const day = String(d.cdate).slice(0, 10); created_by_date[day] = (created_by_date[day] || 0) + 1; }
      });
    };

    const fetchStage = async (baseParams, sk) => {
      const first = await acGet(KEY, '/deals', { ...baseParams, include: 'dealCustomFieldData', limit: 100, offset: 0 });
      process(first, sk);
      const total = (first.meta && first.meta.total) ? Math.min(parseInt(first.meta.total, 10), 30000) : (first.deals || []).length;
      const offs = []; for (let o = 100; o < total; o += 100) offs.push(o);
      const B = 10;
      for (let i = 0; i < offs.length; i += B) {
        const r = await Promise.all(offs.slice(i, i + B).map(o => acGet(KEY, '/deals', { ...baseParams, include: 'dealCustomFieldData', limit: 100, offset: o })));
        r.forEach(x => process(x, sk));
      }
    };

    // F1-F4: tratos ABIERTOS creados en el periodo
    for (const [sk, sid] of Object.entries(STAGES)) {
      await fetchStage({ 'filters[stage]': sid, 'filters[status]': 0, ...dateParams }, sk);
    }
    // Mapa deal_id -> vendedor de TODOS los ganados. El front lo cruza con won_deals del proxy
    // (= ganados EN el periodo por fecha de cierre) para que el Won cuadre con el funnel (14).
    const won_owner = {};
    {
      const grab = async (off) => {
        const d = await acGet(KEY, '/deals', { 'filters[status]': 1, limit: 100, offset: off });
        (d.deals || []).forEach(x => { won_owner[x.id] = ownerMap[x.owner] || 'Sin asignar'; });
        return d;
      };
      const first = await grab(0);
      const total = (first.meta && first.meta.total) ? Math.min(parseInt(first.meta.total, 10), 30000) : 0;
      const offs = []; for (let o = 100; o < total; o += 100) offs.push(o);
      const B = 10;
      for (let i = 0; i < offs.length; i += B) { await Promise.all(offs.slice(i, i + B).map(o => grab(o))); }
    }

    let tot = { f1:0,f2:0,f3:0,f4:0,won:0,total:0 };
    Object.values(by_pais).forEach(b => { tot.f1+=b.f1; tot.f2+=b.f2; tot.f3+=b.f3; tot.f4+=b.f4; tot.won+=b.won; tot.total+=b.total; });
    const sinPais = by_pais['Sin país'] ? by_pais['Sin país'].total : 0;

    // ordenar creados por día (cronológico)
    const cbd = {};
    Object.keys(created_by_date).sort().forEach(k => { cbd[k] = created_by_date[k]; });

    res.status(200).json({
      ok: true, by_owner, by_pais, by_curso, won_owner, created_by_date: cbd, totals: tot, sin_pais: sinPais,
      period: { from: from || null, to: to || null }, ms: Date.now() - start
    });
  } catch (error) {
    res.status(200).json({ ok: false, error: error.message });
  }
}
