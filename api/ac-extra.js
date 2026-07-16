// Vercel Serverless Function - api/ac-extra.js
// MOTOR DE DATOS: País y Curso son campos del TRATO (dealCustomFieldMeta 40=País, 3=Curso interesado),
// se leen con ?include=dealCustomFieldData. Devuelve tratos totales (F1+F2+F3+F4+Won) por PAÍS, CURSO y VENDEDOR,
// filtrados por FECHA DE CREACIÓN del trato (from/to). Necesita AC_API_KEY.

export const config = { maxDuration: 60 };

const AC_BASE = 'https://eimec.api-us1.com/api/3';
const STAGES = { f1: 33, f2: 34, f3: 36, f4: 37 };
const M_PAIS = '40';
const M_CURSO = '3';
const GROUP = '1';            // pipeline de VENTAS (validado: los tratos F1-F4 tienen group=1; el 4 es Pacientes Modelo)
const M_PM_CAMPAIGN = '11';   // utm_campaign — SOLO para detectar "paciente modelo"
// >>> INTERRUPTOR: campo del DESGLOSE de la tabla UTM. Cambiar solo esta línea para testear otra dimensión:
// 11=utm_campaign · 15=utm_source · 16=utm_medium · 17=utm_term · 18=utm_content
const M_UTM = '15';
const UTM_LABEL = { '11':'utm_campaign', '15':'utm_source', '16':'utm_medium', '17':'utm_term', '18':'utm_content' };
const UTM_TITLE = { '11':'campaña', '15':'origen', '16':'medio', '17':'término', '18':'contenido' };
const UTM_TITLE_PL = { '11':'campañas', '15':'orígenes', '16':'medios', '17':'términos', '18':'contenidos' };
// "Paciente modelo" = captación de modelos para prácticas de FORMACIÓN, no es venta → se excluye del informe.
// Coincide por campaña (…PACIENTE-MODELO) o por propietario ("Pacientes modelo EIMEC Formación").
const PM_RE = /pacientes?[\s_\-]*modelo/i;
const isPM = (camp, owner) => PM_RE.test(camp || '') || PM_RE.test(owner || '');

// Normaliza valores de la dimensión UTM para unificar duplicados por grafía (ej. "Meta-ads" y "Meta - ads").
// La clave se compara sin espacios/guiones/mayúsculas; añadir más alias aquí si aparecen otros duplicados.
const UTM_ALIAS = { 'metaads':'Meta-ads', 'meta':'Meta-ads' };
function normUtm(v){
  const s = v ? String(v).trim() : '';
  if (!s) return '';
  const key = s.toLowerCase().replace(/[\s_\-]+/g, '');
  return UTM_ALIAS[key] || s;
}

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

// Prefijo telefónico internacional → país (para completar los "Sin país")
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

    const by_owner = {}, by_pais = {}, by_curso = {}, by_campaign = {}, created_by_date = {}, f2_by_date = {};
    const sinPais = [];   // tratos sin país → intentaremos inferirlo por teléfono
    const add = (b, k, s) => { if (!k) k = 'Sin dato'; if (!b[k]) b[k] = { f1:0,f2:0,f3:0,f4:0,won:0,total:0 }; b[k][s]++; b[k].total++; };

    // Procesa una respuesta de /deals?include=dealCustomFieldData
    const process = (resp, sk) => {
      const cf = {};
      (resp.dealCustomFieldData || []).forEach(x => { (cf[x.deal_id] = cf[x.deal_id] || {})[x.custom_field_id] = x.custom_field_text_value; });
      (resp.deals || []).forEach(d => {
        const c = cf[d.id] || {};
        const ownerName = ownerMap[d.owner] || 'Sin asignar';
        const pmCamp = c[M_PM_CAMPAIGN] && String(c[M_PM_CAMPAIGN]).trim();
        if (isPM(pmCamp, ownerName)) return;   // excluir "paciente modelo" (formación, no ventas)
        add(by_owner, ownerName, sk);
        const cu = c[M_CURSO] && String(c[M_CURSO]).trim(); add(by_curso, cu ? cu : 'Sin curso', sk);
        const utm = normUtm(c[M_UTM]); add(by_campaign, utm || 'Sin dato', sk);
        const pv = c[M_PAIS];
        if (pv && String(pv).trim()) add(by_pais, normPais(pv), sk);
        else sinPais.push({ contact: d.contact, sk });   // resolver luego por teléfono
        if (d.cdate) {
          const day = String(d.cdate).slice(0, 10);
          created_by_date[day] = (created_by_date[day] || 0) + 1;
          // F2 por día de CREACIÓN, desde la MISMA fuente que el resto (evita el desfase horario del proxy WP)
          if (sk === 'f2') f2_by_date[day] = (f2_by_date[day] || 0) + 1;
        }
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

    // Completar "Sin país": inferir por el prefijo del teléfono del contacto (solo los que no tienen país)
    let pais_recuperados = 0;
    const needC = [...new Set(sinPais.map(x => x.contact).filter(Boolean))].slice(0, 700);
    const phonePais = {};
    for (let i = 0; i < needC.length; i += 12) {
      if (Date.now() - start > 42000) break;   // presupuesto de tiempo
      const batch = needC.slice(i, i + 12);
      const rs = await Promise.all(batch.map(id => acGet(KEY, `/contacts/${id}`)));
      rs.forEach((r, j) => { const ph = r.contact && r.contact.phone; const inf = countryFromPhone(ph); if (inf) phonePais[batch[j]] = inf; });
    }
    sinPais.forEach(x => {
      const inf = phonePais[x.contact];
      if (inf) { add(by_pais, inf, x.sk); pais_recuperados++; }
      else add(by_pais, 'Sin país', x.sk);
    });

    // Mapa deal_id -> vendedor de TODOS los ganados. El front lo cruza con won_deals del proxy
    // (= ganados EN el periodo por fecha de cierre) para que el Won cuadre con el funnel (14).
    const won_owner = {};
    const won_campaign = {};
    const pmWonIds = [];   // ids de ganados que son "paciente modelo" → el front los excluye
    {
      const grab = async (off) => {
        const d = await acGet(KEY, '/deals', { 'filters[status]': 1, include: 'dealCustomFieldData', limit: 100, offset: off });
        const cf = {};
        (d.dealCustomFieldData || []).forEach(x => { (cf[x.deal_id] = cf[x.deal_id] || {})[x.custom_field_id] = x.custom_field_text_value; });
        (d.deals || []).forEach(x => {
          const ownerName = ownerMap[x.owner] || 'Sin asignar';
          won_owner[x.id] = ownerName;
          const pmCamp = cf[x.id] && cf[x.id][M_PM_CAMPAIGN] && String(cf[x.id][M_PM_CAMPAIGN]).trim();
          const utm = normUtm(cf[x.id] && cf[x.id][M_UTM]);
          won_campaign[x.id] = utm || 'Sin dato';
          if (isPM(pmCamp, ownerName)) pmWonIds.push(x.id);
        });
        return d;
      };
      const first = await grab(0);
      const total = (first.meta && first.meta.total) ? Math.min(parseInt(first.meta.total, 10), 30000) : 0;
      const offs = []; for (let o = 100; o < total; o += 100) offs.push(o);
      const B = 10;
      for (let i = 0; i < offs.length; i += B) { await Promise.all(offs.slice(i, i + B).map(o => grab(o))); }
    }

    // GANADOS CREADOS EN EL PERIODO (cohorte): de los tratos que ENTRARON en estas fechas, cuántos ya se ganaron.
    // Es distinto del Won por fecha de cierre. Filtramos por GRUPO (pipeline de ventas = 1) porque estos tratos
    // pueden estar en cualquier etapa (F4, "Para Contactar"...), no solo en F1-F4. Fuera paciente modelo.
    const addWonc = (b, k) => { if (!k) k = 'Sin dato'; if (!b[k]) b[k] = { f1:0,f2:0,f3:0,f4:0,won:0,total:0 }; b[k].wonc = (b[k].wonc || 0) + 1; };
    let won_creados = 0;
    {
      const grabWC = async (off) => {
        const d = await acGet(KEY, '/deals', { 'filters[status]': 1, include: 'dealCustomFieldData', ...dateParams, limit: 100, offset: off });
        const cf = {};
        (d.dealCustomFieldData || []).forEach(x => { (cf[x.deal_id] = cf[x.deal_id] || {})[x.custom_field_id] = x.custom_field_text_value; });
        (d.deals || []).forEach(x => {
          if (String(x.group) !== GROUP) return;   // solo el pipeline de ventas
          const c = cf[x.id] || {};
          const ownerName = ownerMap[x.owner] || 'Sin asignar';
          const pmCamp = c[M_PM_CAMPAIGN] && String(c[M_PM_CAMPAIGN]).trim();
          if (isPM(pmCamp, ownerName)) return;     // fuera paciente modelo
          won_creados++;
          addWonc(by_owner, ownerName);
          const cu = c[M_CURSO] && String(c[M_CURSO]).trim(); addWonc(by_curso, cu ? cu : 'Sin curso');
          addWonc(by_campaign, normUtm(c[M_UTM]) || 'Sin dato');
          const pv = c[M_PAIS];
          addWonc(by_pais, (pv && String(pv).trim()) ? normPais(pv) : 'Sin país');
        });
        return d;
      };
      const first = await grabWC(0);
      const totalWC = (first.meta && first.meta.total) ? Math.min(parseInt(first.meta.total, 10), 30000) : 0;
      const offs = []; for (let o = 100; o < totalWC; o += 100) offs.push(o);
      const B = 10;
      for (let i = 0; i < offs.length; i += B) { await Promise.all(offs.slice(i, i + B).map(o => grabWC(o))); }
    }

    let tot = { f1:0,f2:0,f3:0,f4:0,won:0,total:0,wonc:0 };
    Object.values(by_pais).forEach(b => { tot.f1+=b.f1; tot.f2+=b.f2; tot.f3+=b.f3; tot.f4+=b.f4; tot.won+=b.won; tot.total+=b.total; tot.wonc+=(b.wonc||0); });
    const sinPaisFinal = by_pais['Sin país'] ? by_pais['Sin país'].total : 0;

    // ordenar creados por día (cronológico)
    const cbd = {};
    Object.keys(created_by_date).sort().forEach(k => { cbd[k] = created_by_date[k]; });
    const f2bd = {};
    Object.keys(f2_by_date).sort().forEach(k => { f2bd[k] = f2_by_date[k]; });

    res.status(200).json({
      ok: true, by_owner, by_pais, by_curso, by_campaign, won_owner, won_campaign, created_by_date: cbd, f2_by_date: f2bd, totals: tot,
      sin_pais: sinPaisFinal, pais_recuperados, pm_won_ids: pmWonIds, won_creados,
      utm_field: M_UTM, utm_label: UTM_LABEL[M_UTM] || ('cf' + M_UTM),
      utm_title: UTM_TITLE[M_UTM] || 'UTM', utm_title_pl: UTM_TITLE_PL[M_UTM] || 'UTM',
      period: { from: from || null, to: to || null }, ms: Date.now() - start
    });
  } catch (error) {
    res.status(200).json({ ok: false, error: error.message });
  }
}
