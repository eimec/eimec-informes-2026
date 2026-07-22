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

async function graph(base, path, params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${base}/${path}?${qs}`, { headers: { Accept: 'application/json' } });
  const j = await r.json();
  if (!r.ok || (j && j.error)) throw new Error((j && j.error && j.error.message) || `HTTP ${r.status}`);
  return j;
}

// Sigue la paginación (paging.next) sumando todas las filas 'data'
async function insights(base, act, token, timeRange, breakdowns) {
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
export async function metaSpend(from, to) {
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
    // 1) gasto por CAMPAÑA (sin breakdown)  2) gasto por PAÍS (breakdown=country)
    const [byCampRows, byCountryRows] = await Promise.all([
      insights(base, ACT, TOKEN, timeRange, null),
      insights(base, ACT, TOKEN, timeRange, 'country')
    ]);

    const by_campaign = {};
    let total = 0;
    byCampRows.forEach(x => {
      const s = parseFloat(x.spend || 0) || 0;
      total += s;
      const k = x.campaign_name || x.campaign_id || 'Sin campaña';
      by_campaign[k] = (by_campaign[k] || 0) + s;
    });
    const by_country = {};
    byCountryRows.forEach(x => {
      const s = parseFloat(x.spend || 0) || 0;
      const k = pais(x.country);
      by_country[k] = (by_country[k] || 0) + s;
    });

    return {
      ok: true, platform: 'meta', currency: null,
      by_country, by_campaign, total: Math.round(total * 100) / 100,
      period: { from: timeRange.since, to: timeRange.until }, ms: Date.now() - start
    };
  } catch (e) {
    return { ok: false, platform: 'meta', error: e.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');   // el gasto pasado no cambia
  const { from, to } = req.query;
  res.status(200).json(await metaSpend(from, to));
}
