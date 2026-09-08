// Vercel Serverless Function - api/meta-campanas.js
// ESTADO de las campañas de Meta Ads (activa / pausada / archivada) + objetivo y presupuesto.
// El gasto lo da api/meta-ads.js; esto responde a la otra mitad de la pregunta:
// "¿esta campaña sigue viva?". Sin esto, la única pista era "gastó algo el mes pasado",
// que confunde una campaña pausada con una activa sin entrega.
// Usa las mismas env vars que meta-ads.js: META_ACCESS_TOKEN, META_AD_ACCOUNT_ID.
export const config = { maxDuration: 30 };

const PM_RE = /pacientes?[\s_\-]*modelo/i;   // mismo criterio que meta-ads.js y ac-extra.js

const ES = { ACTIVE: 'Activa', PAUSED: 'Pausada', ARCHIVED: 'Archivada', DELETED: 'Eliminada',
             CAMPAIGN_PAUSED: 'Pausada', ADSET_PAUSED: 'Pausada', IN_PROCESS: 'En revisión',
             WITH_ISSUES: 'Con incidencias', DISAPPROVED: 'Rechazada', PENDING_REVIEW: 'En revisión' };

export async function metaCampanas() {
  const TOKEN = process.env.META_ACCESS_TOKEN;
  let ACT = process.env.META_AD_ACCOUNT_ID;
  const V = process.env.META_API_VERSION || 'v25.0';
  if (!TOKEN || !ACT) return { ok: false, error: 'faltan_credenciales' };
  if (!/^act_/.test(ACT)) ACT = 'act_' + ACT;

  const base = `https://graph.facebook.com/${V}`;
  const out = [];
  let url = `${base}/${ACT}/campaigns?` + new URLSearchParams({
    fields: 'name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time,updated_time',
    limit: 500, access_token: TOKEN
  });
  try {
    for (let guard = 0; guard < 20 && url; guard++) {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      const j = await r.json();
      if (!r.ok || (j && j.error)) throw new Error((j && j.error && j.error.message) || `HTTP ${r.status}`);
      (j.data || []).forEach(c => {
        if (PM_RE.test(c.name || '')) return;         // paciente modelo no es inversión de formación
        out.push({
          nombre: c.name,
          estado: ES[c.effective_status] || ES[c.status] || c.effective_status || c.status || '—',
          estado_raw: c.effective_status || c.status || null,
          objetivo: c.objective || null,
          presupuesto_diario: c.daily_budget ? Number(c.daily_budget) / 100 : null,
          presupuesto_total: c.lifetime_budget ? Number(c.lifetime_budget) / 100 : null,
          inicio: c.start_time || null, fin: c.stop_time || null, actualizada: c.updated_time || null
        });
      });
      url = (j.paging && j.paging.next) || null;
    }
    return { ok: true, n: out.length, campanas: out };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const out = await metaCampanas();
  // El estado cambia cuando alguien toca la cuenta: caché corta, no la hora del gasto.
  res.setHeader('Cache-Control', out.ok ? 's-maxage=300, stale-while-revalidate=600' : 'no-store');
  res.status(200).json(out);
}
