// Vercel Serverless Function - api/google-ads.js
// GASTO de GOOGLE ADS vía Google Ads API (REST), DIRECTO.
// Devuelve gasto por CAMPAÑA y total para el rango from/to. (País: pendiente, requiere segments.geo_target_country.)
// Necesita en Vercel:
//   GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
//   GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_CUSTOMER_ID (10 dígitos, SIN guiones),
//   opcional GOOGLE_ADS_LOGIN_CUSTOMER_ID (id del MCC, sin guiones), GOOGLE_ADS_API_VERSION (def. v24).
// Mientras no existan esas env vars, devuelve { ok:false } sin romper nada.
export const config = { maxDuration: 60 };

async function accessToken(id, secret, refresh) {
  const body = new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('oauth: ' + (j.error_description || j.error || r.status));
  return j.access_token;
}

// Lógica reutilizable: la usa el handler de abajo Y el orquestador api/ads-spend.js.
// Devuelve SIEMPRE un objeto ({ ok:true, ... } o { ok:false, error }), nunca lanza.
// opts.byDay=true añade by_day {YYYY-MM-DD: gasto} (segments.date en el GAQL; los totales no cambian).
export async function googleSpend(from, to, opts = {}) {
  const DEV = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const CID = process.env.GOOGLE_CLIENT_ID;
  const CSEC = process.env.GOOGLE_CLIENT_SECRET;
  const REF = process.env.GOOGLE_ADS_REFRESH_TOKEN;
  const CUST = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
  const LOGIN = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, '');
  const V = process.env.GOOGLE_ADS_API_VERSION || 'v24';
  const need = [];
  if (!DEV) need.push('GOOGLE_ADS_DEVELOPER_TOKEN');
  if (!CID) need.push('GOOGLE_CLIENT_ID');
  if (!CSEC) need.push('GOOGLE_CLIENT_SECRET');
  if (!REF) need.push('GOOGLE_ADS_REFRESH_TOKEN');
  if (!CUST) need.push('GOOGLE_ADS_CUSTOMER_ID');
  if (need.length) return { ok: false, error: 'faltan_credenciales', need };

  const today = new Date();
  const desde = from || `${today.getFullYear()}-01-01`;
  const hasta = to || today.toISOString().slice(0, 10);
  const start = Date.now();

  try {
    const token = await accessToken(CID, CSEC, REF);
    const query = `SELECT campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks, customer.currency_code${opts.byDay ? ', segments.date' : ''}
                   FROM campaign
                   WHERE segments.date BETWEEN '${desde}' AND '${hasta}' AND metrics.cost_micros > 0`;
    const headers = { Authorization: 'Bearer ' + token, 'developer-token': DEV, 'Content-Type': 'application/json' };
    if (LOGIN) headers['login-customer-id'] = LOGIN;
    const r = await fetch(`https://googleads.googleapis.com/${V}/customers/${CUST}/googleAds:searchStream`, {
      method: 'POST', headers, body: JSON.stringify({ query })
    });
    const j = await r.json();
    if (!r.ok) throw new Error('ads: ' + JSON.stringify(j).slice(0, 200));

    const by_campaign = {};
    const by_day = opts.byDay ? {} : null;
    let total = 0, currency = null;
    const batches = Array.isArray(j) ? j : [j];
    batches.forEach(b => (b.results || []).forEach(row => {
      const spend = Number(row.metrics && row.metrics.costMicros || 0) / 1e6;
      total += spend;
      currency = currency || (row.customer && row.customer.currencyCode);
      const k = (row.campaign && row.campaign.name) || 'Sin campaña';
      by_campaign[k] = (by_campaign[k] || 0) + spend;
      if (by_day) { const dia = row.segments && row.segments.date; if (dia) by_day[dia] = Math.round(((by_day[dia] || 0) + spend) * 100) / 100; }
    }));

    return {
      ok: true, platform: 'google', currency,
      by_campaign, total: Math.round(total * 100) / 100,
      ...(by_day ? { by_day } : {}),
      period: { from: desde, to: hasta }, ms: Date.now() - start
    };
  } catch (e) {
    return { ok: false, platform: 'google', error: e.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  const { from, to } = req.query;
  res.status(200).json(await googleSpend(from, to));
}
