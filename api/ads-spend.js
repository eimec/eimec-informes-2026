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
    if (api.by_day) out.by_day = api.by_day;                  // gasto por día (gráfico diario)
    if (api.currency) out.currency = api.currency;
    if (api.impressions !== undefined) out.impressions = Number(api.impressions) || 0;   // para el cuadro por canal
    if (api.clicks !== undefined) out.clicks = Number(api.clicks) || 0;
    if (api.conversions !== undefined) out.conversions = Number(api.conversions) || 0;   // conversiones de la plataforma (Google)
    if (api.sin_pm) out.sin_pm = true;                        // Meta: sin campañas de paciente modelo
    if (api.parcial) out.parcial = true;                      // respuesta incompleta del canal → no cachear
    return out;
  }
  const m = manual && manual[nombre];
  const totalManual = m ? sumMonthly(m.monthly, from, to) : 0;
  if (totalManual > 0) return { total: totalManual, source: 'manual' };
  return { total: 0, source: 'none', motivo: (api && api.error) || 'sin_datos' };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // ⚠️ La cabecera de caché se decide AL FINAL según el resultado. Cachear aquí arriba provocó un bug:
  // una respuesta degradada (fallo transitorio de Meta con total 0) quedó cacheada 1h en el CDN y el
  // informe mostró "sin datos de inversión" aunque el gasto real existía.

  const { from, to } = req.query || {};
  const hoy = new Date();
  const desde = from || `${hoy.getFullYear()}-01-01`;
  const hasta = to || hoy.toISOString().slice(0, 10);

  try {
    // metaSpend/googleSpend nunca lanzan (devuelven {ok:false} en error), pero allSettled por cinturón y tirantes.
    // byDay: gasto POR DÍA (línea de CPL diario). byCountry: gasto POR PAÍS (cuadro de país).
    // (metaSpend devuelve by_country siempre; googleSpend solo si se le pide.)
    const [metaR, googleR] = await Promise.allSettled([
      metaSpend(desde, hasta, { byDay: true }),
      googleSpend(desde, hasta, { byDay: true, byCountry: true })
    ]);
    const manual = leerGastoManual();
    const meta = resolverCanal('meta',
      metaR.status === 'fulfilled' ? metaR.value : { ok: false, error: String(metaR.reason || 'error') },
      manual, desde, hasta);
    const google = resolverCanal('google',
      googleR.status === 'fulfilled' ? googleR.value : { ok: false, error: String(googleR.reason || 'error') },
      manual, desde, hasta);

    const total = Math.round((meta.total + google.total) * 100) / 100;
    const partial = meta.source === 'none' || google.source === 'none';   // falta al menos un canal

    // Gasto POR DÍA combinado (solo de los canales con API viva; el gasto manual es mensual y no entra aquí).
    const by_day = {};
    [meta, google].forEach(c => {
      if (c.by_day) Object.entries(c.by_day).forEach(([dia, v]) => {
        by_day[dia] = Math.round(((by_day[dia] || 0) + (Number(v) || 0)) * 100) / 100;
      });
    });

    // Gasto POR PAÍS combinado (claves = nombres normPais, las mismas que la tabla del CRM).
    // Si parte del gasto no tiene desglose por país (canal manual, o el desglose falló), se apunta
    // en "Sin desglose por país" para que la SUMA por país siempre cuadre con el total. NUNCA se pierde.
    const by_pais = {};
    [meta, google].forEach(c => {
      if (c.by_country) Object.entries(c.by_country).forEach(([p, v]) => {
        by_pais[p] = Math.round(((by_pais[p] || 0) + (Number(v) || 0)) * 100) / 100;
      });
    });
    let sumPais = 0;
    Object.values(by_pais).forEach(v => { sumPais += v; });
    const restoPais = Math.round((total - sumPais) * 100) / 100;
    if (restoPais > 0.01) by_pais['Sin desglose por país'] = Math.round(((by_pais['Sin desglose por país'] || 0) + restoPais) * 100) / 100;

    // CACHÉ SEGÚN RESULTADO: solo se cachea una respuesta COMPLETA y SANA. Cachear una degradada
    // (canal caído, total 0 con source api, parcial...) dejaba el informe "sin inversión" 1 hora.
    const canalDegradado = c => c.source === 'none' || !!c.motivo || !!c.parcial || (c.source === 'api' && !(c.total > 0));
    const sana = !partial && !canalDegradado(meta) && !canalDegradado(google);
    res.setHeader('Cache-Control', sana ? 's-maxage=3600, stale-while-revalidate=7200' : 'no-store');

    res.status(200).json({ ok: true, total, by_channel: { meta, google }, by_day, by_pais, partial, period: { from: desde, to: hasta } });
  } catch (e) {
    // Degradación total: el informe muestra "sin datos de inversión" pero NO se rompe. Y NUNCA se cachea.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true, total: 0,
      by_channel: { meta: { total: 0, source: 'none' }, google: { total: 0, source: 'none' } },
      by_day: {}, by_pais: {}, partial: true, error: e.message, period: { from: desde, to: hasta }
    });
  }
}
