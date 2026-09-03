// Vercel Serverless Function - api/ac-curso.js
// DETALLE DE UN CURSO POR PAÍS Y POR MES, para la sección "Curso × país" del informe.
//
// Pregunta que responde: de los leads de ESTE curso, ¿en qué países convierten mejor y
// cómo evoluciona mes a mes? Devuelve, para el curso pedido:
//   por_pais: { País: {tratos, f1, f2, f3, f4, won} }
//   por_mes:  { "AAAA-MM": {tratos, won} }
//   pais_mes: { País: { "AAAA-MM": {tratos, won} } }
//
// ES UNA COHORTE: todo se cuenta sobre los tratos CREADOS en el rango. F1-F4 = dónde
// están HOY esos tratos; won = cuántos de ellos se han ganado. Así el denominador es
// siempre el mismo (tratos) y los porcentajes significan algo. NO mezcla "ventas
// cerradas en el periodo" de leads antiguos: para eso están los otros cuadros.
export const config = { maxDuration: 60 };

const AC_BASE = 'https://eimec.api-us1.com/api/3';
const GROUP = '1';
const M_CURSO = '3';
const M_PAIS = '40';
const M_PM_CAMPAIGN = '11';
const PM_RE = /pacientes?[\s_\-]*modelo/i;
const STAGE_FASE = { '33': 'f1', '34': 'f2', '36': 'f3', '37': 'f4' };

const MES_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit' });
const mesES = v => { try { return MES_FMT.format(new Date(v)).slice(0, 7); } catch (_) { return String(v).slice(0, 7); } };

// ⚠️ Mismo vocabulario de países que ac-extra/index.html: si difiere, el país se parte en dos filas.
const ISO2 = {
  ES:'Spain', MX:'Mexico', CL:'Chile', PE:'Peru', AR:'Argentina', CO:'Colombia', VE:'Venezuela', EC:'Ecuador',
  BO:'Bolivia', UY:'Uruguay', PY:'Paraguay', CR:'Costa Rica', GT:'Guatemala', SV:'El Salvador', HN:'Honduras',
  NI:'Nicaragua', PA:'Panama', DO:'Dominican Republic', CU:'Cuba', PR:'Puerto Rico', US:'United States',
  CA:'Canada', BR:'Brazil', IT:'Italy', FR:'France', DE:'Germany', GB:'United Kingdom', UK:'United Kingdom',
  PT:'Portugal', IE:'Ireland', CH:'Switzerland', NL:'Netherlands', BE:'Belgium', PL:'Poland', RO:'Romania',
  GR:'Greece', UA:'Ukraine', RU:'Russia', TR:'Turkey', IL:'Israel', AE:'United Arab Emirates', SA:'Saudi Arabia',
  QA:'Qatar', MA:'Morocco', EG:'Egypt', NG:'Nigeria', ZA:'South Africa', IN:'India', PK:'Pakistan',
  PH:'Philippines', LY:'Libya', MT:'Malta', AU:'Australia', SE:'Sweden', NO:'Norway', DK:'Denmark', AT:'Austria',
  JO:'Jordan', KW:'Kuwait', OM:'Oman', BH:'Bahrain', LB:'Lebanon', IQ:'Iraq', SY:'Syria', YE:'Yemen',
  SD:'Sudan', TN:'Tunisia', DZ:'Algeria', JP:'Japan', KR:'South Korea', CN:'China'
};
const ALIAS = {
  'US':'United States','USA':'United States','EEUU':'United States','ESTADOS UNIDOS':'United States',
  'UK':'United Kingdom','REINO UNIDO':'United Kingdom','ESPAÑA':'Spain','ESPANA':'Spain',
  'MÉXICO':'Mexico','MEJICO':'Mexico','MÉJICO':'Mexico','TÜRKIYE':'Turkey','TURKIYE':'Turkey'
};
function normPais(v) {
  if (v === null || v === undefined) return 'Sin país';
  const k = String(v).trim();
  if (!k) return 'Sin país';
  if (/^sin\s+pa[ií]s$/i.test(k) || /^pa[ií]s$/i.test(k) || /^\d+$/.test(k)) return 'Sin país';
  const up = k.toUpperCase();
  if (k.length === 2 && ISO2[up]) return ISO2[up];
  return ALIAS[up] || k;
}

async function acGet(key, params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${AC_BASE}/deals?${qs}`, { headers: { 'Api-Token': key, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`AC ${r.status}`);
  return r.json();
}
function mapaCF(resp) {
  const m = {};
  (resp.dealCustomFieldData || []).forEach(r => {
    const v = r.custom_field_text_value || r.custom_field_text_blob || null;
    const id = String(r.deal);
    if (!m[id]) m[id] = {};
    m[id][String(r.custom_field_id)] = v;
  });
  return m;
}
// "master" casa con "Master", "MASTER 2026", "Máster"… sin casar con otros cursos
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const KEY = process.env.AC_API_KEY;
  if (!KEY) { res.setHeader('Cache-Control', 'no-store'); res.status(200).json({ ok: false, error: 'no_key' }); return; }

  const hoy = new Date();
  const { curso, from, to } = req.query || {};
  const cursoPedido = (curso || 'Master').trim();
  const cursoKey = norm(cursoPedido);
  const desde = from || `${hoy.getFullYear()}-01-01`;
  const hasta = to || hoy.toISOString().slice(0, 10);
  const [y, m, d] = hasta.split('-').map(Number);
  const hastaExc = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);

  const start = Date.now();
  try {
    const base = {
      'filters[group]': GROUP,
      'filters[created_after]': desde,
      'filters[created_before]': hastaExc,
      include: 'dealCustomFieldData',
      // Orden FIJO por id: sin el, al paginar en paralelo AC mueve registros entre
      // paginas y se pierden tratos (visto: 6.319 de 6.610 esperados).
      'orders[id]': 'ASC',
      limit: 100
    };
    const first = await acGet(KEY, { ...base, offset: 0 });
    const total = (first.meta && first.meta.total) ? Math.min(parseInt(first.meta.total, 10), 30000) : (first.deals || []).length;
    const paginas = [first];
    const offs = [];
    for (let o = 100; o < total; o += 100) offs.push(o);
    for (let i = 0; i < offs.length; i += 10) {
      const lote = await Promise.all(offs.slice(i, i + 10).map(o => acGet(KEY, { ...base, offset: o })));
      paginas.push(...lote);
    }

    const por_pais = {}, por_mes = {}, pais_mes = {};
    const cursosVistos = {};   // para el selector: qué cursos hay y con cuántos tratos
    const vistos = new Set();
    let tratos = 0, won = 0, perdidos = 0;

    const celdaP = p => (por_pais[p] = por_pais[p] || { tratos: 0, f1: 0, f2: 0, f3: 0, f4: 0, won: 0, perdidos: 0 });
    const celdaM = k => (por_mes[k] = por_mes[k] || { tratos: 0, won: 0 });

    paginas.forEach(p => {
      const cf = mapaCF(p);
      (p.deals || []).forEach(x => {
        if (vistos.has(x.id)) return;
        vistos.add(x.id);
        const c = cf[x.id] || {};
        if (PM_RE.test(c[M_PM_CAMPAIGN] || '')) return;
        const cu = (c[M_CURSO] || '').trim();
        cursosVistos[cu || 'Sin curso'] = (cursosVistos[cu || 'Sin curso'] || 0) + 1;
        if (norm(cu) !== cursoKey) return;

        const pais = normPais(c[M_PAIS]);
        const mes = x.cdate ? mesES(x.cdate) : 'Sin fecha';
        const P = celdaP(pais), M = celdaM(mes);
        tratos++; P.tratos++; M.tratos++;
        if (!pais_mes[pais]) pais_mes[pais] = {};
        const PM_ = (pais_mes[pais][mes] = pais_mes[pais][mes] || { tratos: 0, won: 0 });
        PM_.tratos++;

        const st = String(x.status);
        if (st === '1') { won++; P.won++; M.won++; PM_.won++; }
        else if (st === '2') { perdidos++; P.perdidos++; }
        else {
          const f = STAGE_FASE[String(x.stage)];
          if (f) P[f]++;
        }
      });
    });

    const meses = Object.keys(por_mes).filter(k => k !== 'Sin fecha').sort();
    const completo = vistos.size >= total;
    res.setHeader('Cache-Control', completo ? 's-maxage=900, stale-while-revalidate=1800' : 'no-store');
    res.status(200).json({
      ok: true, curso: cursoPedido, tratos, won, perdidos,
      por_pais, por_mes, pais_mes, meses,
      cursos_disponibles: cursosVistos,
      integridad: { esperados: total, obtenidos: vistos.size },
      period: { from: desde, to: hasta }, ms: Date.now() - start
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: false, error: e.message, period: { from: desde, to: hasta } });
  }
}
