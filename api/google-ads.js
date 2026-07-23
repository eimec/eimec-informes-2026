// Vercel Serverless Function - api/google-ads.js
// GASTO de GOOGLE ADS vía Google Ads API (REST), DIRECTO.
// Devuelve gasto por CAMPAÑA y total para el rango from/to. (País: pendiente, requiere segments.geo_target_country.)
// Necesita en Vercel:
//   GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
//   GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_CUSTOMER_ID (10 dígitos, SIN guiones),
//   opcional GOOGLE_ADS_LOGIN_CUSTOMER_ID (id del MCC, sin guiones), GOOGLE_ADS_API_VERSION (def. v24).
// Mientras no existan esas env vars, devuelve { ok:false } sin romper nada.
export const config = { maxDuration: 60 };

// Criterion ID de Google (geoTargetConstants/XXXX) → nombre de país, MISMO vocabulario que
// normPais/ISO2 del resto del informe para que el gasto por país cuadre con la tabla del CRM.
// Los IDs no mapeados van al bucket "Otros países" (nunca se pierde gasto en silencio).
const GEO_ID_PAIS = {
  '2724':'Spain','2484':'Mexico','2152':'Chile','2604':'Peru','2032':'Argentina','2170':'Colombia',
  '2862':'Venezuela','2218':'Ecuador','2068':'Bolivia','2858':'Uruguay','2600':'Paraguay','2188':'Costa Rica',
  '2320':'Guatemala','2222':'El Salvador','2340':'Honduras','2558':'Nicaragua','2591':'Panama',
  '2214':'Dominican Republic','2630':'Puerto Rico','2840':'United States','2124':'Canada','2076':'Brazil',
  '2380':'Italy','2250':'France','2276':'Germany','2826':'United Kingdom','2620':'Portugal','2372':'Ireland',
  '2756':'Switzerland','2528':'Netherlands','2056':'Belgium','2616':'Poland','2642':'Romania','2300':'Greece',
  '2792':'Turkey','2376':'Israel','2784':'United Arab Emirates','2682':'Saudi Arabia','2634':'Qatar',
  '2504':'Morocco','2818':'Egypt'
};

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
// opts.byCountry=true añade by_country {País: gasto} con una query APARTE a geographic_view
// (segments.geo_target_country). Es NO-FATAL: si falla, el total y el resto siguen saliendo.
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
    const query = `SELECT campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, customer.currency_code${opts.byDay ? ', segments.date' : ''}
                   FROM campaign
                   WHERE segments.date BETWEEN '${desde}' AND '${hasta}' AND metrics.cost_micros > 0`;
    const headers = { Authorization: 'Bearer ' + token, 'developer-token': DEV, 'Content-Type': 'application/json' };
    if (LOGIN) headers['login-customer-id'] = LOGIN;
    let r = await fetch(`https://googleads.googleapis.com/${V}/customers/${CUST}/googleAds:searchStream`, {
      method: 'POST', headers, body: JSON.stringify({ query })
    });
    let j = await r.json();
    // AUTO-CORRECCIÓN: si la cuenta es de acceso DIRECTO (no cuelga del MCC), Google devuelve
    // USER_PERMISSION_DENIED cuando se manda login-customer-id. Reintentamos SIN ese header
    // (verificado en esta cuenta: 5157672395 es acceso directo de info@eimec.com).
    if (!r.ok && LOGIN && JSON.stringify(j).includes('USER_PERMISSION_DENIED')) {
      delete headers['login-customer-id'];
      r = await fetch(`https://googleads.googleapis.com/${V}/customers/${CUST}/googleAds:searchStream`, {
        method: 'POST', headers, body: JSON.stringify({ query })
      });
      j = await r.json();
    }
    if (!r.ok) throw new Error('ads: ' + JSON.stringify(j).slice(0, 200));

    const by_campaign = {};
    const conversions_by_campaign = {};   // conversiones únicas por campaña (para el cuadro por campaña)
    const by_day = opts.byDay ? {} : null;
    let total = 0, currency = null, impressions = 0, clicks = 0, conversions = 0;
    const batches = Array.isArray(j) ? j : [j];
    batches.forEach(b => (b.results || []).forEach(row => {
      const spend = Number(row.metrics && row.metrics.costMicros || 0) / 1e6;
      total += spend;
      impressions += Number(row.metrics && row.metrics.impressions || 0);
      clicks += Number(row.metrics && row.metrics.clicks || 0);
      const convRow = Number(row.metrics && row.metrics.conversions || 0);
      conversions += convRow;
      currency = currency || (row.customer && row.customer.currencyCode);
      const k = (row.campaign && row.campaign.name) || 'Sin campaña';
      by_campaign[k] = (by_campaign[k] || 0) + spend;
      if (convRow) conversions_by_campaign[k] = (conversions_by_campaign[k] || 0) + convRow;
      if (by_day) { const dia = row.segments && row.segments.date; if (dia) by_day[dia] = Math.round(((by_day[dia] || 0) + spend) * 100) / 100; }
    }));

    // Gasto por PAÍS (query aparte, NO-FATAL: si Google la rechaza, el total no se pierde).
    let by_country = null;
    if (opts.byCountry) {
      try {
        // geographic_view NO admite segments.geo_target_country: el país sale de su propio campo
        // geographic_view.country_criterion_id (verificado contra la cuenta real).
        const qPais = `SELECT geographic_view.country_criterion_id, metrics.cost_micros
                       FROM geographic_view
                       WHERE segments.date BETWEEN '${desde}' AND '${hasta}' AND metrics.cost_micros > 0`;
        const rp = await fetch(`https://googleads.googleapis.com/${V}/customers/${CUST}/googleAds:searchStream`, {
          method: 'POST', headers, body: JSON.stringify({ query: qPais })
        });
        const jp = await rp.json();
        if (!rp.ok) throw new Error('geo: ' + JSON.stringify(jp).slice(0, 150));
        by_country = {};
        let sumPais = 0;
        (Array.isArray(jp) ? jp : [jp]).forEach(b => (b.results || []).forEach(row => {
          const spend = Number(row.metrics && row.metrics.costMicros || 0) / 1e6;
          // criterion ID ("2724") → nombre de país
          const id = String((row.geographicView && row.geographicView.countryCriterionId) || '');
          const nombre = GEO_ID_PAIS[id] || 'Otros países';   // sin mapear → bucket, nunca se pierde
          by_country[nombre] = Math.round(((by_country[nombre] || 0) + spend) * 100) / 100;
          sumPais += spend;
        }));
        // Si el desglose geográfico no cubre todo el gasto (campañas sin atribución), el resto
        // también va a "Otros países" para que la suma por país CUADRE con el total del canal.
        const resto = Math.round((total - sumPais) * 100) / 100;
        if (resto > 0.01) by_country['Otros países'] = Math.round(((by_country['Otros países'] || 0) + resto) * 100) / 100;
      } catch (_) { by_country = null; }   // sin desglose por país; total intacto
    }

    return {
      ok: true, platform: 'google', currency,
      by_campaign, total: Math.round(total * 100) / 100,
      impressions, clicks,
      conversions: Math.round(conversions),   // conversiones que reporta Google (formulario enviado)
      conversions_by_campaign,                // por campaña, para el cuadro de campañas de Paid Media
      ...(by_day ? { by_day } : {}),
      ...(by_country ? { by_country } : {}),
      period: { from: desde, to: hasta }, ms: Date.now() - start
    };
  } catch (e) {
    return { ok: false, platform: 'google', error: e.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { from, to } = req.query;
  const out = await googleSpend(from, to);
  // Caché SEGÚN resultado: los errores ({ok:false}) no se cachean nunca (antes se cacheaban 1h).
  res.setHeader('Cache-Control', (out && out.ok)
    ? 's-maxage=3600, stale-while-revalidate=7200'
    : 'no-store');
  res.status(200).json(out);
}
