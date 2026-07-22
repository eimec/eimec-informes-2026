// Vercel Serverless Function - api/ads-spend.js
// ORQUESTADOR del GASTO publicitario para el apartado Paid Media.
// Pide en paralelo el gasto real de Meta (meta-ads.js) y Google (google-ads.js) para el rango from/to.
// Si un canal NO tiene credenciales (o su API falla), cae al gasto MANUAL de data/ad-spend.json
// (buckets mensuales en euros; se suman los meses que tocan el rango con sumMonthly).
// Respuesta: { ok, total, by_channel: { meta:{total, source:'api'|'manual'|'none'}, google:{...} }, partial, period }
// REGLA DE ORO: NUNCA devuelve 500 — si todo falla, degrada a ok:true con total 0 y sources 'none'.
export const config = { maxDuration: 60 };

import fs from 'node:fs';
import path from 'node:path';
import { metaSpend } from './meta-ads.js';
import { googleSpend } from './google-ads.js';
import { sumMonthly } from './_ads-common.js';

// Lee el fichero de gasto manual. Si no existe o está corrupto → null (se degrada a 'none').
function leerGastoManual() {
  try {
    const p = path.join(process.cwd(), 'data', 'ad-spend.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { return null; }
}

// Resuelve UN canal: API viva > gasto manual > sin datos.
function resolverCanal(nombre, api, manual, from, to) {
  if (api && api.ok) {
    const out = { total: Math.round((Number(api.total) || 0) * 100) / 100, source: 'api' };
    if (api.by_campaign) out.by_campaign = api.by_campaign;   // desglose para futuras tablas
    if (api.by_country) out.by_country = api.by_country;
    if (api.currency) out.currency = api.currency;
    return out;
  }
  const m = manual && manual[nombre];
  const totalManual = m ? sumMonthly(m.monthly, from, to) : 0;
  if (totalManual > 0) return { total: totalManual, source: 'manual' };
  return { total: 0, source: 'none', motivo: (api && api.error) || 'sin_datos' };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');   // el gasto pasado no cambia

  const { from, to } = req.query || {};
  const hoy = new Date();
  const desde = from || `${hoy.getFullYear()}-01-01`;
  const hasta = to || hoy.toISOString().slice(0, 10);

  try {
    // metaSpend/googleSpend nunca lanzan (devuelven {ok:false} en error), pero allSettled por cinturón y tirantes.
    const [metaR, googleR] = await Promise.allSettled([metaSpend(desde, hasta), googleSpend(desde, hasta)]);
    const manual = leerGastoManual();
    const meta = resolverCanal('meta',
      metaR.status === 'fulfilled' ? metaR.value : { ok: false, error: String(metaR.reason || 'error') },
      manual, desde, hasta);
    const google = resolverCanal('google',
      googleR.status === 'fulfilled' ? googleR.value : { ok: false, error: String(googleR.reason || 'error') },
      manual, desde, hasta);

    const total = Math.round((meta.total + google.total) * 100) / 100;
    const partial = meta.source === 'none' || google.source === 'none';   // falta al menos un canal

    res.status(200).json({ ok: true, total, by_channel: { meta, google }, partial, period: { from: desde, to: hasta } });
  } catch (e) {
    // Degradación total: el informe muestra "sin datos de inversión" pero NO se rompe.
    res.status(200).json({
      ok: true, total: 0,
      by_channel: { meta: { total: 0, source: 'none' }, google: { total: 0, source: 'none' } },
      partial: true, error: e.message, period: { from: desde, to: hasta }
    });
  }
}
