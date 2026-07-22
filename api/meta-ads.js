// Vercel Serverless Function - api/meta-ads.js
// GASTO de META ADS (Facebook/Instagram) vía Marketing API (Graph API), DIRECTO.
// Devuelve el gasto por PAÍS, por CAMPAÑA y total, para el rango from/to.
// Necesita en Vercel: META_ACCESS_TOKEN (System User token, ads_read, caducidad Never),
//                      META_AD_ACCOUNT_ID (act_XXXXXXXXXX), y opcional META_API_VERSION (def. v25.0).
// Mientras no existan esas env vars, devuelve { ok:false } sin romper nada.
export const config = { maxDuration: 60 };

// Códigos ISO-2 -> nombre de país (idéntico al normPais del informe, para que cuadre con la tabla de país)
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
const pais = c => ISO2[(c || '').toUpperCase()] || c || 'Sin país';

// "Paciente modelo" = captación de modelos para prácticas, NO es inversión de FORMACIÓN.
// MISMO regex que api/ac-extra.js: sus campañas se EXCLUYEN de total, by_campaign, by_country y by_day,
// para que el CPL del informe sea puro de formación y cuadre con el pipeline (que ya excluye PM).
const PM_RE = /pacientes?[\s_\-]*modelo/i;
const sinPM = rows => (rows || []).filter(x => !PM_RE.test(x.campaign_name || ''));

async function graph(base, path, params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${base}/${path}?${qs}`, { headers: { Accept: 'application/json' } });
  const j = await r.json();
  if (!r.ok || (j && j.error)) throw new Error((j && j.error && j.error.message) || `HTTP ${r.status}`);
  return j;
}

// Sigue la paginación (paging.next) sumando todas las filas 'data'
// timeIncrement=1 → una fila por campaña y DÍA (date_start), para el gasto diario de Paid Media.
async function insights(base, act, token, timeRange, breakdowns, timeIncrement) {
  const rows = [];
  let after = null;
  for (let guard = 0; guard < 50; guard++) {
    const params = {
      level: 'campaign',
      fields: 'campaign_id,campaign_name,spend,impressions,clicks',
      time_range: JSON.stringify(timeRange),
      limit: 500,
      access_token: token
    };
    if (breakdowns) params.breakdowns = breakdowns;
    if (timeIncrement) params.time_increment = timeIncrement;
    if (after) params.after = after;
    const j = await graph(base, `${act}/insights`, params);
    (j.data || []).forEach(x => rows.push(x));
    after = j.paging && j.paging.cursors && j.paging.next ? j.paging.cursors.after : null;
    if (!after) break;
  }
  return rows;
}

// Lógica reutilizable: la usa el handler de abajo Y el orquestador api/ads-spend.js.
// Devuelve SIEMPRE un objeto ({ ok:true, ... } o { ok:false, error }), nunca lanza.
// opts.byDay=true añade by_day {YYYY-MM-DD: gasto} (petición extra con time_increment=1).
export async function metaSpend(from, to, opts = {}) {
  const TOKEN = process.env.META_ACCESS_TOKEN;
  let ACT = process.env.META_AD_ACCOUNT_ID;
  const V = process.env.META_API_VERSION || 'v25.0';
  if (!TOKEN || !ACT) return { ok: false, error: 'faltan_credenciales', need: ['META_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID'] };
  if (!/^act_/.test(ACT)) ACT = 'act_' + ACT;   // acepta el id con o sin prefijo act_

  const today = new Date();
  const timeRange = { since: from || `${today.getFullYear()}-01-01`, until: to || today.toISOString().slice(0, 10) };
  const base = `https://graph.facebook.com/${V}`;
  const start = Date.now();

  try {
    // 1) gasto por CAMPAÑA (sin breakdown)  2) gasto por PAÍS (breakdown=country)  3) opcional: por DÍA
    // Todas las peticiones son level=campaign, así que cada fila trae campaign_name → se filtra PM en todas.
    const [byCampRowsAll, byCountryRowsAll, byDayRowsAll] = await Promise.all([
      insights(base, ACT, TOKEN, timeRange, null),
      insights(base, ACT, TOKEN, timeRange, 'country'),
      opts.byDay ? insights(base, ACT, TOKEN, timeRange, null, 1) : Promise.resolve(null)
    ]);
    const byCampRows = sinPM(byCampRowsAll);
    const byCountryRows = sinPM(byCountryRowsAll);
    const byDayRows = byDayRowsAll ? sinPM(byDayRowsAll) : null;

    const by_campaign = {};
    let total = 0, impressions = 0, clicks = 0;
    const sumaCampanas = rows => rows.forEach(x => {
      const s = parseFloat(x.spend || 0) || 0;
      total += s;
      impressions += parseInt(x.impressions || 0, 10) || 0;
      clicks += parseInt(x.clicks || 0, 10) || 0;
      const k = x.campaign_name || x.campaign_id || 'Sin campaña';
      by_campaign[k] = (by_campaign[k] || 0) + s;
    });
    sumaCampanas(byCampRows);
    const by_country = {};
    byCountryRows.forEach(x => {
      const s = parseFloat(x.spend || 0) || 0;
      const k = pais(x.country);
      by_country[k] = (by_country[k] || 0) + s;
    });

    // RESILIENCIA: a veces la Graph API devuelve transitoriamente 0 filas en la petición de campañas
    // aunque el desglose por país SÍ trae gasto (incoherencia = fallo transitorio). Reintentamos UNA vez
    // la de campañas; si sigue vacía, usamos la suma por país como total (con marca 'parcial') para
    // NUNCA devolver un total 0 falso que el informe muestre como "sin inversión".
    let parcial = false;
    let sumCountry = 0;
    Object.values(by_country).forEach(v => { sumCountry += v; });
    if (byCampRows.length === 0 && sumCountry > 0.01) {
      const retryRows = sinPM(await insights(base, ACT, TOKEN, timeRange, null));
      if (retryRows.length > 0) {
        sumaCampanas(retryRows);
      } else {
        total = sumCountry;
        parcial = true;   // total tomado del desglose por país; sin detalle por campaña esta vez
      }
    }
    let by_day = null;
    if (byDayRows) {
      by_day = {};
      byDayRows.forEach(x => {
        const s = parseFloat(x.spend || 0) || 0;
        if (x.date_start) by_day[x.date_start] = Math.round(((by_day[x.date_start] || 0) + s) * 100) / 100;
      });
    }

    return {
      ok: true, platform: 'meta', currency: null,
      by_country, by_campaign, total: Math.round(total * 100) / 100,
      impressions, clicks,
      sin_pm: true,   // las campañas de "paciente modelo" están EXCLUIDAS de todas las cifras
      ...(parcial ? { parcial: true, nota: 'total tomado del desglose por pais; sin detalle por campana esta vez' } : {}),
      ...(by_day ? { by_day } : {}),
      period: { from: timeRange.since, to: timeRange.until }, ms: Date.now() - start
    };
  } catch (e) {
    return { ok: false, platform: 'meta', error: e.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { from, to } = req.query;
  const out = await metaSpend(from, to);
  // La cabecera de caché se decide SEGÚN el resultado: cachear un error 1h dejaba el informe
  // "sin inversión" una hora entera aunque la API ya funcionara. Solo se cachean éxitos completos.
  res.setHeader('Cache-Control', (out && out.ok && !out.parcial)
    ? 's-maxage=3600, stale-while-revalidate=7200'   // el gasto pasado no cambia
    : 'no-store');
  res.status(200).json(out);
}
