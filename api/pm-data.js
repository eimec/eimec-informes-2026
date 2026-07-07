// Vercel Serverless Function - api/pm-data.js
// MOTOR DE DATOS del informe "Pacientes Modelo" (ActiveCampaign dealGroup 4).
// Todo directo contra AC v3 (cabecera Api-Token, env var AC_API_KEY). Una sola fuente.
//
// SEMÁNTICA DE FECHAS (idéntica al informe gemelo):
//  · NUEVAS (abiertas)  = tratos status=0 CREADOS en el periodo (filters[created_after]/[created_before]).
//  · CONSEGUIDOS (won)  = tratos status=1 CERRADOS en el periodo, por fecha de cierre = mdate
//                         (el campo "Fecha de ganado" (5) está vacío en este pipeline → usamos mdate).
//  · PERDIDOS (lost)    = tratos status=2 cerrados en el periodo (mdate).
//  Cada trato se cuenta UNA vez. Total por dimensión = nuevas + conseguidos + perdidos.
//  Verificado en vivo: país = tratamiento = origen = vendedor = totales cuadran.

export const config = { maxDuration: 60 };

const AC_BASE = 'https://eimec.api-us1.com/api/3';
const GROUP = 4;                 // pipeline "Pacientes Modelo"
const M_PAIS = '40';             // campo País del trato

// Etapas reales del pipeline (dealStages del group 4), en orden de recorrido.
const STAGE_ORDER = ['42','94','47','50','46','49','44','45','52'];
const STAGE_LABEL = {
  '42':'1. Para contactar', '94':'1.1 Contactados', '47':'2. Para contactar (cita)',
  '50':'4. Llamar en otro momento', '46':'6. Citado', '49':'7. Citado. No acudió',
  '44':'3.2 No responde (WhatsApp)', '45':'3.3 Responde. No interesada', '52':'Otras ciudades o países'
};

// ── Tratamiento y origen se leen del TÍTULO del trato (Curso/UTM están vacíos en este pipeline).
//    Formato típico: "<Origen> | TTO <Tratamiento>" o "TTO <Tratamiento>".
const stripAcc = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const TRAT_ALIAS = {
  'acido hialuronico':'Ácido Hialurónico', 'hialuronico':'Ácido Hialurónico',
  'toxina botulinica':'Toxina Botulínica', 'botox':'Toxina Botulínica',
  'bioestimulacion':'Bioestimulación', 'lipolaser':'Lipoláser', 'laser':'Láser',
  'hilos tensores':'Hilos Tensores', 'blefaro':'Blefaroplastia', 'blefaroplastia':'Blefaroplastia',
  'ginecoestetica':'Ginecoestética', 'acido desoxicolico':'Ácido Desoxicólico'
};
const TRAT_JUNK = new Set(['modelo','contacto','paciente','sin tratamiento','','tto']);
function tratFromTitle(title) {
  let s = (title || '').trim();
  const m = s.match(/TTO\s+(.+)$/i);
  if (m) s = m[1];
  else s = s.replace(/^\s*(meta\s*ads?|meta|google\s*ads?|google|gads|tiktok)\s*[|\-–:]*\s*/i, '');
  s = s.replace(/[\-–|].*$/, '').trim();                       // corta tras el primer separador
  s = s.replace(/pacientes?\s*modelo/ig, '').replace(/[|·\-\s]+$/,'').trim();
  s = s.replace(/\s+/g, ' ').trim();
  const key = stripAcc(s.toLowerCase()).replace(/-/g, ' ').replace(/\s+/g,' ').trim();
  if (TRAT_JUNK.has(key)) return 'Sin tratamiento';
  if (TRAT_ALIAS[key]) return TRAT_ALIAS[key];
  return s ? s.replace(/\b\w/g, c => c.toUpperCase()) : 'Sin tratamiento';
}
function origenFromTitle(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('meta') || t.includes('facebook') || t.includes('instagram')) return 'Meta';
  if (t.includes('google') || t.includes('gads')) return 'Google';
  if (t.includes('tiktok')) return 'TikTok';
  if (t.includes('organ') || t.includes('orgán')) return 'Orgánico';
  return 'Sin origen';
}

// ── País: normalización + inferencia por prefijo telefónico (para los "Sin país") ──
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
const PHONE_PREFIX = {
  '34':'Spain','52':'Mexico','56':'Chile','51':'Peru','54':'Argentina','57':'Colombia','58':'Venezuela','593':'Ecuador',
  '591':'Bolivia','598':'Uruguay','595':'Paraguay','506':'Costa Rica','502':'Guatemala','503':'El Salvador','504':'Honduras',
  '505':'Nicaragua','507':'Panama','1':'United States','39':'Italy','44':'United Kingdom','33':'France','49':'Germany',
  '351':'Portugal','353':'Ireland','41':'Switzerland','31':'Netherlands','32':'Belgium','48':'Poland','40':'Romania','30':'Greece',
  '380':'Ukraine','90':'Turkey','972':'Israel','971':'United Arab Emirates','966':'Saudi Arabia','55':'Brazil','92':'Pakistan',
  '91':'India','63':'Philippines','218':'Libya','356':'Malta','212':'Morocco','20':'Egypt','234':'Nigeria','355':'Albania'
};
function countryFromPhone(phone) {
  if (!phone) return '';
  let p = String(phone).replace(/[^\d+]/g, '');
  if (p[0] === '+') p = p.slice(1);
  else if (p.startsWith('00')) p = p.slice(2);
  else return '';
  for (let len = 4; len >= 1; len--) { const pre = p.slice(0, len); if (PHONE_PREFIX[pre]) return PHONE_PREFIX[pre]; }
  return '';
}

async function acGet(key, path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  try {
    const r = await fetch(`${AC_BASE}${path}${qs ? ('?' + qs) : ''}`, { headers: { Accept: 'application/json', 'Api-Token': key } });
    if (!r.ok) return {};
    return await r.json();
  } catch (_) { return {}; }
}

// Trae TODOS los deals de un status en el group, con sus custom fields. status=1/2 son pocos (~140/116).
async function fetchAll(key, status, extra = {}) {
  const rows = [];
  const pull = resp => {
    const cf = {};
    (resp.dealCustomFieldData || []).forEach(x => { (cf[x.deal_id] = cf[x.deal_id] || {})[x.custom_field_id] = x.custom_field_text_value; });
    (resp.deals || []).forEach(d => { d._cf = cf[d.id] || {}; rows.push(d); });
  };
  const base = { 'filters[group]': GROUP, 'filters[status]': status, include: 'dealCustomFieldData', limit: 100, ...extra };
  const first = await acGet(key, '/deals', { ...base, offset: 0 });
  pull(first);
  const total = (first.meta && first.meta.total) ? Math.min(parseInt(first.meta.total, 10), 30000) : rows.length;
  const offs = []; for (let o = 100; o < total; o += 100) offs.push(o);
  const B = 10;
  for (let i = 0; i < offs.length; i += B) {
    const r = await Promise.all(offs.slice(i, i + B).map(o => acGet(key, '/deals', { ...base, offset: o })));
    r.forEach(pull);
  }
  return rows;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');

  const KEY = process.env.AC_API_KEY;
  if (!KEY) { res.status(200).json({ ok: false, error: 'no_key' }); return; }

  const { from, to } = req.query;
  const inPeriod = d => { if (!d) return false; const day = String(d).slice(0, 10); return (!from || day >= from) && (!to || day <= to); };
  const start = Date.now();

  try {
    // Vendedores (id -> nombre)
    const ownerMap = {};
    for (let off = 0, g = 0; g < 20; g++, off += 100) {
      const d = await acGet(KEY, '/users', { limit: 100, offset: off });
      const us = d.users || [];
      us.forEach(u => { let n = `${u.firstName || ''} ${u.lastName || ''}`.trim(); if (!n) n = u.username || ('Usuario ' + u.id); if (u.id) ownerMap[u.id] = n; });
      if (us.length < 100) break;
    }

    // Abiertas · ganados · perdidos. Traemos TODAS y filtramos por fecha en cliente:
    // el filtro server-side filters[created_after]/[created_before] de AC descarta tratos que SÍ
    // se crearon en el periodo (verificado: devolvía 621 vs 1015 reales), así que no lo usamos.
    const openDeals = await fetchAll(KEY, 0);
    const wonAll = await fetchAll(KEY, 1);
    const lostAll = await fetchAll(KEY, 2);

    // Stock EN VIVO por etapa: TODAS las abiertas (independiente del filtro de fechas).
    // Consulta ligera por etapa (meta.total), sin traer los cuerpos de los tratos.
    const stageStock = [];
    await Promise.all(STAGE_ORDER.map(async sid => {
      const d = await acGet(KEY, '/deals', { 'filters[group]': GROUP, 'filters[status]': 0, 'filters[stage]': sid, limit: 1 });
      stageStock.push({ id: sid, label: STAGE_LABEL[sid] || ('Etapa ' + sid), count: (d.meta && d.meta.total) ? parseInt(d.meta.total, 10) : 0 });
    }));
    stageStock.sort((a, b) => STAGE_ORDER.indexOf(a.id) - STAGE_ORDER.indexOf(b.id));

    // Acumuladores. idx: 0=nuevas(open) 1=won 2=lost
    const by_pais = {}, by_trat = {}, by_origen = {}, by_owner = {}, matrix = {};
    const created_by_date = {}, won_by_date = {};
    const totals = { open: 0, won: 0, lost: 0 };
    const bump = (b, k, idx) => { if (!k) k = 'Sin dato'; if (!b[k]) b[k] = { open: 0, won: 0, lost: 0, total: 0 }; const f = ['open','won','lost'][idx]; b[k][f]++; b[k].total++; };
    const sinPais = [];   // {contact, idx} para inferir por teléfono

    const addDeal = (d, idx) => {
      const owner = ownerMap[d.owner] || 'Sin asignar';
      const trat = tratFromTitle(d.title);
      const orig = origenFromTitle(d.title);
      bump(by_owner, owner, idx);
      bump(by_trat, trat, idx);
      bump(by_origen, orig, idx);
      const pv = d._cf[M_PAIS];
      if (pv && String(pv).trim()) bump(by_pais, normPais(pv), idx);
      else sinPais.push({ contact: d.contact, idx });
      totals[['open','won','lost'][idx]]++;
      if (idx === 1) {                        // matriz tratamiento × país solo de conseguidos
        const pk = (pv && String(pv).trim()) ? normPais(pv) : 'Sin país';
        (matrix[trat] = matrix[trat] || {})[pk] = (matrix[trat][pk] || 0) + 1;
      }
    };

    openDeals.forEach(d => { if (inPeriod(d.cdate)) { addDeal(d, 0); const day = String(d.cdate).slice(0, 10); created_by_date[day] = (created_by_date[day] || 0) + 1; } });
    wonAll.forEach(d => { if (inPeriod(d.mdate)) { addDeal(d, 1); const day = String(d.mdate).slice(0, 10); won_by_date[day] = (won_by_date[day] || 0) + 1; } });
    lostAll.forEach(d => { if (inPeriod(d.mdate)) { addDeal(d, 2); } });

    // Completar "Sin país" por prefijo telefónico del contacto
    let pais_recuperados = 0;
    const needC = [...new Set(sinPais.map(x => x.contact).filter(Boolean))].slice(0, 600);
    const phonePais = {};
    for (let i = 0; i < needC.length; i += 12) {
      if (Date.now() - start > 45000) break;
      const batch = needC.slice(i, i + 12);
      const rs = await Promise.all(batch.map(id => acGet(KEY, `/contacts/${id}`)));
      rs.forEach((r, j) => { const ph = r.contact && r.contact.phone; const inf = countryFromPhone(ph); if (inf) phonePais[batch[j]] = inf; });
    }
    sinPais.forEach(x => {
      const inf = phonePais[x.contact];
      if (inf) { bump(by_pais, inf, x.idx); pais_recuperados++; }
      else bump(by_pais, 'Sin país', x.idx);
    });

    const sortDays = o => { const out = {}; Object.keys(o).sort().forEach(k => out[k] = o[k]); return out; };

    res.status(200).json({
      ok: true,
      totals, by_pais, by_trat, by_origen, by_owner, matrix,
      stage_stock: stageStock, stage_stock_total: stageStock.reduce((s, x) => s + x.count, 0),
      created_by_date: sortDays(created_by_date), won_by_date: sortDays(won_by_date),
      sin_pais: by_pais['Sin país'] ? by_pais['Sin país'].total : 0, pais_recuperados,
      period: { from: from || null, to: to || null }, ms: Date.now() - start
    });
  } catch (error) {
    res.status(200).json({ ok: false, error: error.message });
  }
}
