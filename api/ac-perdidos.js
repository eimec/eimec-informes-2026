// Vercel Serverless Function - api/ac-perdidos.js
// MOTIVOS DE PERDIDO por MES, para el cuadro del final de la hoja "Equipo de ventas".
//
// Devuelve { motivo -> { "AAAA-MM": n } } de los tratos PERDIDOS (status=2) del pipeline
// de formación (group=1) CREADOS dentro del rango. Excluye paciente modelo, igual que
// el resto del informe.
//
// ⚠️ EL MES ES EL DE CREACIÓN DEL TRATO, no el del día en que se marcó como perdido.
// Se probó usar mdate (última modificación) y NO sirve: el 3-sep-2026 había 777 tratos
// "modificados" en junio y 1.946 en julio — una edición masiva, no pérdidas reales.
// ActiveCampaign no expone una "fecha de perdido"; para tenerla habría que leer el
// registro de actividad (dataType=status, dataAction=2), que es otro orden de coste.
// Así que esto responde: "de los leads que entraron en este mes, por qué se perdieron".
export const config = { maxDuration: 60 };

const AC_BASE = 'https://eimec.api-us1.com/api/3';
const GROUP = '1';
const M_MOTIVO = '4';        // dropdown "Motivo de perdido"
const M_PM_CAMPAIGN = '11';  // utm_campaign, solo para detectar paciente modelo
const PM_RE = /pacientes?[\s_\-]*modelo/i;

// Día en hora de Madrid, mismo criterio que ac-extra (AC devuelve cdate con offset americano)
const MES_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit' });
const mesES = v => { try { return MES_FMT.format(new Date(v)).slice(0, 7); } catch (_) { return String(v).slice(0, 7); } };

async function acGet(key, params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${AC_BASE}/deals?${qs}`, { headers: { 'Api-Token': key, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`AC ${r.status}`);
  return r.json();
}

// Valor de texto de un campo personalizado en el listado masivo
function mapaCF(resp) {
  const m = {};
  (resp.dealCustomFieldData || []).forEach(r => {
    const v = r.custom_field_text_value || r.custom_field_text_blob || null;
    const id = String(r.deal);
    if (!m[id]) m[id] = {};
    m[id][String(r.custom_field_id)] = v;
  });
  return m;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const KEY = process.env.AC_API_KEY;
  if (!KEY) { res.setHeader('Cache-Control', 'no-store'); res.status(200).json({ ok: false, error: 'no_key' }); return; }

  const hoy = new Date();
  const { from, to } = req.query || {};
  const desde = from || `${hoy.getFullYear()}-01-01`;
  const hasta = to || hoy.toISOString().slice(0, 10);
  // AC trata created_before como EXCLUSIVO: se manda el día siguiente para incluir "hasta"
  const [y, m, d] = hasta.split('-').map(Number);
  const hastaExc = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);

  const start = Date.now();
  try {
    const base = {
      'filters[group]': GROUP,
      'filters[status]': 2,                 // 2 = Perdido
      'filters[created_after]': desde,
      'filters[created_before]': hastaExc,
      include: 'dealCustomFieldData',
      limit: 100
    };
    const first = await acGet(KEY, { ...base, offset: 0 });
    const total = (first.meta && first.meta.total) ? Math.min(parseInt(first.meta.total, 10), 20000) : (first.deals || []).length;

    const paginas = [first];
    const offs = [];
    for (let o = 100; o < total; o += 100) offs.push(o);
    for (let i = 0; i < offs.length; i += 8) {   // de 8 en 8 para no saturar la API
      const lote = await Promise.all(offs.slice(i, i + 8).map(o => acGet(KEY, { ...base, offset: o })));
      paginas.push(...lote);
    }

    const motivos = {};      // motivo -> { "AAAA-MM": n }
    const porMes = {};       // "AAAA-MM" -> n (total del mes)
    const vistos = new Set();
    let sinMotivo = 0, pm = 0;

    paginas.forEach(p => {
      const cf = mapaCF(p);
      (p.deals || []).forEach(x => {
        if (vistos.has(x.id)) return;        // dedupe: la paginación paralela puede repetir
        vistos.add(x.id);
        const c = cf[x.id] || {};
        if (PM_RE.test(c[M_PM_CAMPAIGN] || '')) { pm++; return; }
        const mes = x.cdate ? mesES(x.cdate) : 'Sin fecha';
        const mot = (c[M_MOTIVO] || '').trim() || 'Sin motivo anotado';
        if (mot === 'Sin motivo anotado') sinMotivo++;
        if (!motivos[mot]) motivos[mot] = {};
        motivos[mot][mes] = (motivos[mot][mes] || 0) + 1;
        porMes[mes] = (porMes[mes] || 0) + 1;
      });
    });

    const meses = Object.keys(porMes).filter(k => k !== 'Sin fecha').sort();
    const completo = vistos.size >= total;   // si falta alguna página, no cacheamos
    res.setHeader('Cache-Control', completo ? 's-maxage=900, stale-while-revalidate=1800' : 'no-store');
    res.status(200).json({
      ok: true, motivos, meses, por_mes: porMes,
      total: vistos.size - pm, sin_motivo: sinMotivo, paciente_modelo_excluidos: pm,
      base_fecha: 'creacion',
      integridad: { esperados: total, obtenidos: vistos.size },
      period: { from: desde, to: hasta }, ms: Date.now() - start
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: false, error: e.message, period: { from: desde, to: hasta } });
  }
}
