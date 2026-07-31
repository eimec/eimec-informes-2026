// Vercel Serverless Function - api/ac-asistidas.js
// VENTAS ASISTIDAS (multi-touch) para el cuadro por canal de Paid Media.
//
// Definición (ampliada 31-jul-2026): una venta cerrada del periodo está ASISTIDA por un canal
// (Meta/Google) cuando ese canal aparece en el rastro de la persona SIN ser el origen directo del
// trato ganado. Dos rastros, ambos válidos:
//   a) OTRO trato del mismo contacto (id distinto del ganado) con utm_source/utm_campaign/gclid del canal.
//   b) La FICHA DEL CONTACTO: utm_source (132), utm_campaign (131) o gclid (172).
// El (b) es el que faltaba: el utm se guarda en el contacto Y en el trato, pero cuando el comercial
// crea el trato a mano (o el trato es anterior a la rutina que copia contacto→trato, 23-jul-2026)
// el trato nace sin utm y la venta salía "Sin dato" aunque la persona hubiera entrado por un anuncio.
// Auditoría 31-jul-2026 sobre las 148 ventas de 2026: 6 ventas (50.200 €) tienen Meta SOLO en la
// ficha del contacto, y 3 más solo en otro trato del contacto.
//
// El canal DIRECTO del trato ganado nunca cuenta como asistencia de sí mismo (si no, la misma venta
// sumaría en "Ventas" y en "Asistidas" y el CPA asistido saldría inflado).
//
// Uso: GET /api/ac-asistidas?from=YYYY-MM-DD&to=YYYY-MM-DD&ids=101,102,...
//   ids = ids de los tratos GANADOS del periodo (los pasa el front, ya sin "paciente modelo").
// Respuesta: { ok, asistidas:{meta,google}, directas:{meta,google}, detalle:{meta:{otro_trato,ficha},...},
//              asistidas_campana, por_venta, n, period }
// Nunca 500. Caché s-maxage=600 SOLO si la respuesta es sana; si no, no-store.
export const config = { maxDuration: 60 };

import { normKey } from './_ads-common.js';

const AC_BASE = 'https://eimec.api-us1.com/api/3';
const M_UTM = '15';          // custom field de TRATO: utm_source
const M_CAMP = '11';         // custom field de TRATO: utm_campaign
const M_GCLID = '41';        // custom field de TRATO: gclid
const C_CAMP = '131';        // campo de CONTACTO: utm_campaign
const C_SOURCE = '132';      // campo de CONTACTO: utm_source
const C_MEDIUM = '133';      // campo de CONTACTO: utm_medium
const C_GCLID = '172';       // campo de CONTACTO: gclid
// MISMO criterio de canal que el front (regla de dirección, 22-jul): utm_source que CONTIENE
// "meta" → Meta, que CONTIENE "google" → Google. Nada más.
const RE_META = /meta/;
const RE_GOOGLE = /google/;
function canalDe(v) {
  const nk = normKey(v);
  if (!nk) return null;
  if (RE_META.test(nk)) return 'meta';
  if (RE_GOOGLE.test(nk)) return 'google';
  return null;
}
// Valor de texto de un campo del contacto (AC devuelve string o array según el tipo de campo)
const txt = v => (Array.isArray(v) ? v.join('|') : (v == null ? '' : String(v))).trim();

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
    // Sin ids no hay lista fiable de ventas del periodo (la fecha de cierre la calcula ac-extra).
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

    // 2) De cada contacto → TODOS sus tratos con su utm (source/campaign/gclid)
    const contactos = [...new Set(Object.values(ventaContacto))];
    const tratosContacto = {};   // contactId -> [{id, canal, campana}]
    for (let i = 0; i < contactos.length; i += 8) {
      if (Date.now() - start > 40000) break;   // presupuesto de tiempo: mejor parcial que timeout
      const lote = contactos.slice(i, i + 8);
      const rs = await Promise.all(lote.map(cid =>
        acGet(KEY, '/deals', { 'filters[contact]': cid, include: 'dealCustomFieldData', 'orders[id]': 'ASC', limit: 100 })));
      rs.forEach((d, j) => {
        const cf = {};
        (d.dealCustomFieldData || []).forEach(x => { (cf[x.deal_id] = cf[x.deal_id] || {})[x.custom_field_id] = x.custom_field_text_value; });
        tratosContacto[lote[j]] = (d.deals || []).map(x => {
          const c = cf[x.id] || {};
          const gclid = c[M_GCLID] && String(c[M_GCLID]).trim();
          return {
            id: String(x.id),
            canal: canalDe(c[M_UTM]) || canalDe(c[M_CAMP]) || (gclid ? 'google' : null),
            campana: (c[M_CAMP] && String(c[M_CAMP]).trim().slice(0, 80)) || null
          };
        });
      });
    }

    // 3) FICHA DEL CONTACTO: el utm que guarda la persona aunque el trato lo haya perdido.
    const fichaContacto = {};   // contactId -> {canal, campana}
    for (let i = 0; i < contactos.length; i += 8) {
      if (Date.now() - start > 48000) break;
      const lote = contactos.slice(i, i + 8);
      const rs = await Promise.all(lote.map(cid => acGet(KEY, `/contacts/${cid}`, { include: 'fieldValues' })));
      rs.forEach((r, j) => {
        const v = {};
        (r.fieldValues || []).forEach(fv => { v[String(fv.field)] = txt(fv.value); });
        const canal = canalDe(v[C_SOURCE]) || canalDe(v[C_CAMP]) || canalDe(v[C_MEDIUM]) || (v[C_GCLID] ? 'google' : null);
        fichaContacto[lote[j]] = { canal, campana: (v[C_CAMP] || '').slice(0, 80) || null };
      });
    }

    // 4) Asistencia = canal presente en OTRO trato del contacto o en su ficha, distinto del canal
    //    DIRECTO del trato ganado (ese ya suma en la columna "Ventas").
    const asistidas = { meta: 0, google: 0 };
    const directas = { meta: 0, google: 0 };
    const detalle = { meta: { otro_trato: 0, ficha: 0 }, google: { otro_trato: 0, ficha: 0 } };
    const asistidas_campana = {};   // utm_campaign -> nº de ventas del periodo que asistió
    const por_venta = {};
    ids.forEach(wonId => {
      const cid = ventaContacto[wonId];
      const deals = (cid && tratosContacto[cid]) || [];
      const propio = deals.find(dl => dl.id === String(wonId));
      const directo = (propio && propio.canal) || null;
      if (directo && directas[directo] !== undefined) directas[directo]++;

      const otros = deals.filter(dl => dl.id !== String(wonId));
      const ficha = (cid && fichaContacto[cid]) || {};
      const res_ = { meta: false, google: false, via: {} };
      ['meta', 'google'].forEach(ch => {
        if (ch === directo) return;                       // el origen directo no se asiste a sí mismo
        const porTrato = otros.some(dl => dl.canal === ch);
        const porFicha = ficha.canal === ch;
        if (!porTrato && !porFicha) return;
        res_[ch] = true;
        res_.via[ch] = porTrato ? (porFicha ? 'trato+ficha' : 'otro trato') : 'ficha contacto';
        asistidas[ch]++;
        if (porTrato) detalle[ch].otro_trato++; else detalle[ch].ficha++;
      });
      // Campañas que asistieron (1 por venta): las de los otros tratos + la de la ficha del contacto
      const camps = new Set(otros.map(dl => dl.campana).filter(Boolean));
      if (ficha.campana) camps.add(ficha.campana);
      camps.forEach(camp => { asistidas_campana[camp] = (asistidas_campana[camp] || 0) + 1; });
      por_venta[wonId] = res_;
    });

    // Sana = pudimos resolver el contacto, sus tratos y su ficha de todas las ventas pedidas
    const sana = Object.keys(ventaContacto).length === ids.length
      && contactos.every(c => tratosContacto[c] !== undefined && fichaContacto[c] !== undefined);
    res.setHeader('Cache-Control', sana ? 's-maxage=600, stale-while-revalidate=1200' : 'no-store');
    res.status(200).json({
      ok: true, asistidas, directas, detalle, asistidas_campana, por_venta, n: ids.length, completo: sana,
      period: { from: from || null, to: to || null }, ms: Date.now() - start
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: false, error: e.message });
  }
}
