// Vercel Serverless Function - api/ac-asistidas.js
// VENTAS ASISTIDAS (multi-touch) para el cuadro por canal de Paid Media.
// Definición: una venta cerrada del periodo es "asistida" por un canal (Meta/Google) si su CONTACTO
// tiene OTRO trato (distinto del ganado) cuyo utm_source (custom field 15) es de ese canal.
//
// Uso: GET /api/ac-asistidas?from=YYYY-MM-DD&to=YYYY-MM-DD&ids=101,102,...
//   ids = ids de los tratos GANADOS del periodo (los pasa el front desde won_deals, ya sin
//   "paciente modelo"), la MISMA lista que usa el resto del informe → coherencia garantizada.
//   Volumen esperado: 10-40 ventas/mes → viable llamada a llamada con lotes.
// Respuesta: { ok, asistidas: { meta, google }, por_venta: { id: { meta, google } }, n, period }
// Nunca 500. Caché s-maxage=600 SOLO si la respuesta es sana; si no, no-store.
export const config = { maxDuration: 60 };

import { normKey } from './_ads-common.js';

const AC_BASE = 'https://eimec.api-us1.com/api/3';
const M_UTM = '15';   // custom field: utm_source
// MISMO criterio de canal que el resto del informe (normKey + regex amplia)
const RE_META = /meta|facebook|fb|instagram/;
const RE_GOOGLE = /google|adwords/;
function canalDe(v) {
  const nk = normKey(v);
  if (!nk) return null;
  if (RE_META.test(nk)) return 'meta';
  if (RE_GOOGLE.test(nk)) return 'google';
  return null;
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

  const KEY = process.env.AC_API_KEY;
  if (!KEY) { res.setHeader('Cache-Control', 'no-store'); res.status(200).json({ ok: false, error: 'no_key' }); return; }

  const { from, to } = req.query || {};
  const ids = String((req.query && req.query.ids) || '')
    .split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s)).slice(0, 120);
  if (!ids.length) {
    // Sin ids no hay lista fiable de ventas del periodo (la fecha de cierre vive en el proxy, no aquí).
    // Devolvemos ok:false para que el front muestre "—" honesto, nunca un 0 falso.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: false, error: 'faltan_ids', period: { from: from || null, to: to || null } });
    return;
  }

  const start = Date.now();
  try {
    // 1) De cada venta ganada → su contacto
    const ventaContacto = {};   // wonId -> contactId
    for (let i = 0; i < ids.length; i += 8) {
      const lote = ids.slice(i, i + 8);
      const rs = await Promise.all(lote.map(id => acGet(KEY, `/deals/${id}`)));
      rs.forEach((r, j) => { const c = r.deal && r.deal.contact; if (c) ventaContacto[lote[j]] = String(c); });
    }

    // 2) De cada contacto → TODOS sus tratos con su utm_source (field 15)
    const contactos = [...new Set(Object.values(ventaContacto))];
    const canalesContacto = {};   // contactId -> { deals: [{id, canal}] }
    for (let i = 0; i < contactos.length; i += 8) {
      if (Date.now() - start > 45000) break;   // presupuesto de tiempo: mejor parcial que timeout
      const lote = contactos.slice(i, i + 8);
      const rs = await Promise.all(lote.map(cid =>
        acGet(KEY, '/deals', { 'filters[contact]': cid, include: 'dealCustomFieldData', limit: 100 })));
      rs.forEach((d, j) => {
        const cf = {};
        (d.dealCustomFieldData || []).forEach(x => { (cf[x.deal_id] = cf[x.deal_id] || {})[x.custom_field_id] = x.custom_field_text_value; });
        canalesContacto[lote[j]] = (d.deals || []).map(x => ({
          id: String(x.id),
          canal: canalDe(cf[x.id] && cf[x.id][M_UTM])
        }));
      });
    }

    // 3) Una venta es "asistida" por un canal si el contacto tiene OTRO trato (id distinto) de ese canal
    const asistidas = { meta: 0, google: 0 };
    const por_venta = {};
    ids.forEach(wonId => {
      const cid = ventaContacto[wonId];
      const deals = (cid && canalesContacto[cid]) || [];
      const m = deals.some(dl => dl.id !== String(wonId) && dl.canal === 'meta');
      const g = deals.some(dl => dl.id !== String(wonId) && dl.canal === 'google');
      if (m) asistidas.meta++;
      if (g) asistidas.google++;
      por_venta[wonId] = { meta: m, google: g };
    });

    // Sana = pudimos resolver el contacto y sus tratos de todas las ventas pedidas
    const sana = Object.keys(ventaContacto).length === ids.length
      && contactos.every(c => canalesContacto[c] !== undefined);
    res.setHeader('Cache-Control', sana ? 's-maxage=600, stale-while-revalidate=1200' : 'no-store');
    res.status(200).json({
      ok: true, asistidas, por_venta, n: ids.length, completo: sana,
      period: { from: from || null, to: to || null }, ms: Date.now() - start
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: false, error: e.message });
  }
}
