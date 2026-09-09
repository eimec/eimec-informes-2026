// Vercel Serverless Function - api/google-campanas.js
// DIAGNOSTICO de la cuenta de Google Ads: estado y presupuesto de cada campaña, y sobre todo
// la CUOTA DE IMPRESIONES PERDIDA, separando la que se pierde por PRESUPUESTO (falta dinero:
// subirlo da más volumen inmediato) de la que se pierde por RANGO (puja/calidad: subir el
// presupuesto no sirve de nada). Sin ese desglose, repartir presupuesto es adivinar.
// Añade los términos de búsqueda más caros, para ver dónde se va el dinero en las genéricas.
// Usa las mismas env vars que google-ads.js.
export const config = { maxDuration: 60 };

const ES_ESTADO = { ENABLED: 'Activa', PAUSED: 'Pausada', REMOVED: 'Eliminada' };
const ES_CANAL = { SEARCH: 'Búsqueda', PERFORMANCE_MAX: 'Performance Max', DISPLAY: 'Display',
                   VIDEO: 'Vídeo', SHOPPING: 'Shopping', DEMAND_GEN: 'Demand Gen' };
const ES_PUJA = { TARGET_CPA: 'CPA objetivo', MAXIMIZE_CONVERSIONS: 'Maximizar conversiones',
                  MAXIMIZE_CONVERSION_VALUE: 'Maximizar valor', TARGET_ROAS: 'ROAS objetivo',
                  MANUAL_CPC: 'CPC manual', TARGET_SPEND: 'Maximizar clics',
                  TARGET_IMPRESSION_SHARE: 'Cuota de impresiones' };

async function accessToken(id, secret, refresh) {
  const body = new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('oauth: ' + (j.error_description || j.error || r.status));
  return j.access_token;
}

export async function googleCampanas(from, to) {
  const DEV = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const CID = process.env.GOOGLE_CLIENT_ID;
  const CSEC = process.env.GOOGLE_CLIENT_SECRET;
  const REF = process.env.GOOGLE_ADS_REFRESH_TOKEN;
  const CUST = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
  const LOGIN = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, '');
  const V = process.env.GOOGLE_ADS_API_VERSION || 'v24';
  if (!DEV || !CID || !CSEC || !REF || !CUST) return { ok: false, error: 'faltan_credenciales' };

  const hoy = new Date();
  const hasta = to || hoy.toISOString().slice(0, 10);
  const desde = from || new Date(hoy.getTime() - 30 * 864e5).toISOString().slice(0, 10);

  const token = await accessToken(CID, CSEC, REF);
  const headers = { Authorization: 'Bearer ' + token, 'developer-token': DEV, 'Content-Type': 'application/json' };
  if (LOGIN) headers['login-customer-id'] = LOGIN;

  // Cada consulta va por separado y es NO-FATAL: si una falla, las demás siguen dando datos.
  async function gaql(query) {
    async function pedir(h) {
      const r = await fetch(`https://googleads.googleapis.com/${V}/customers/${CUST}/googleAds:searchStream`, {
        method: 'POST', headers: h, body: JSON.stringify({ query })
      });
      return [r, await r.json()];
    }
    let [r, j] = await pedir(headers);
    // misma auto-corrección que google-ads.js: cuenta de acceso directo, no cuelga del MCC
    if (!r.ok && LOGIN && JSON.stringify(j).includes('USER_PERMISSION_DENIED')) {
      const h2 = { ...headers }; delete h2['login-customer-id'];
      [r, j] = await pedir(h2);
    }
    if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 300));
    const filas = [];
    (Array.isArray(j) ? j : [j]).forEach(t => (t.results || []).forEach(x => filas.push(x)));
    return filas;
  }

  const out = { ok: true, periodo: { desde, hasta } };

  // 1) AJUSTES: estado, presupuesto diario, tipo de campaña y estrategia de puja
  try {
    const filas = await gaql(`SELECT campaign.id, campaign.name, campaign.status,
        campaign.advertising_channel_type, campaign.bidding_strategy_type,
        campaign_budget.amount_micros, campaign.start_date, campaign.end_date
      FROM campaign WHERE campaign.status != 'REMOVED'`);
    out.campanas = filas.map(x => ({
      id: x.campaign?.id, nombre: x.campaign?.name,
      estado: ES_ESTADO[x.campaign?.status] || x.campaign?.status,
      tipo: ES_CANAL[x.campaign?.advertisingChannelType] || x.campaign?.advertisingChannelType,
      puja: ES_PUJA[x.campaign?.biddingStrategyType] || x.campaign?.biddingStrategyType,
      presupuesto_dia: x.campaignBudget?.amountMicros ? Number(x.campaignBudget.amountMicros) / 1e6 : null,
      inicio: x.campaign?.startDate, fin: x.campaign?.endDate
    }));
  } catch (e) { out.error_ajustes = e.message; }

  // 2) RENDIMIENTO + CUOTA DE IMPRESIONES (lo que decide dónde poner el dinero)
  try {
    const filas = await gaql(`SELECT campaign.name, metrics.impressions, metrics.clicks,
        metrics.cost_micros, metrics.conversions, metrics.all_conversions, metrics.average_cpc,
        metrics.search_impression_share, metrics.search_budget_lost_impression_share,
        metrics.search_rank_lost_impression_share
      FROM campaign WHERE segments.date BETWEEN '${desde}' AND '${hasta}'`);
    out.rendimiento = filas.map(x => ({
      nombre: x.campaign?.name,
      impresiones: Number(x.metrics?.impressions || 0),
      clics: Number(x.metrics?.clicks || 0),
      coste: Number(x.metrics?.costMicros || 0) / 1e6,
      cpc: Number(x.metrics?.averageCpc || 0) / 1e6,
      conversiones: Number(x.metrics?.conversions || 0),
      conv_todas: Number(x.metrics?.allConversions || 0),
      cuota_impr: x.metrics?.searchImpressionShare ?? null,
      perdida_presupuesto: x.metrics?.searchBudgetLostImpressionShare ?? null,
      perdida_rango: x.metrics?.searchRankLostImpressionShare ?? null
    })).filter(x => x.impresiones > 0);
  } catch (e) { out.error_rendimiento = e.message; }

  // 3) TERMINOS DE BUSQUEDA mas caros: donde se va el dinero de las genericas
  try {
    const filas = await gaql(`SELECT search_term_view.search_term, campaign.name,
        metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM search_term_view WHERE segments.date BETWEEN '${desde}' AND '${hasta}'
        AND metrics.cost_micros > 0 ORDER BY metrics.cost_micros DESC LIMIT 150`);
    out.terminos = filas.map(x => ({
      termino: x.searchTermView?.searchTerm, campana: x.campaign?.name,
      clics: Number(x.metrics?.clicks || 0),
      coste: Number(x.metrics?.costMicros || 0) / 1e6,
      conversiones: Number(x.metrics?.conversions || 0)
    }));
  } catch (e) { out.error_terminos = e.message; }

  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { from, to } = req.query || {};
  let out;
  try { out = await googleCampanas(from, to); }
  catch (e) { out = { ok: false, error: e.message }; }
  res.setHeader('Cache-Control', out.ok ? 's-maxage=300, stale-while-revalidate=600' : 'no-store');
  res.status(200).json(out);
}
