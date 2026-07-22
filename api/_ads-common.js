// api/_ads-common.js
// Utilidades COMPARTIDAS por las funciones de anuncios (meta-ads.js, google-ads.js, ads-spend.js).
// OBJETIVO: una sola fuente de verdad para normalizar el PAÍS, para que el gasto por país
// cuadre EXACTAMENTE con la tabla "Pipeline por país" del informe.
//
// ⚠️ normPais() DEBE ser idéntico al normPais() de index.html y al de api/ac-extra.js.
//    Si difieren, el mismo país se parte en dos (gasto por un lado, leads por otro) y el CPL sale falso.

// ISO-2 -> nombre de país (idéntico a index.html)
export const ISO2 = {
  ES: 'Spain', MX: 'Mexico', CL: 'Chile', PE: 'Peru', AR: 'Argentina', CO: 'Colombia', VE: 'Venezuela', EC: 'Ecuador',
  BO: 'Bolivia', UY: 'Uruguay', PY: 'Paraguay', CR: 'Costa Rica', GT: 'Guatemala', SV: 'El Salvador', HN: 'Honduras',
  NI: 'Nicaragua', PA: 'Panama', DO: 'Dominican Republic', CU: 'Cuba', PR: 'Puerto Rico', US: 'United States',
  CA: 'Canada', BR: 'Brazil', IT: 'Italy', FR: 'France', DE: 'Germany', GB: 'United Kingdom', UK: 'United Kingdom',
  PT: 'Portugal', IE: 'Ireland', CH: 'Switzerland', NL: 'Netherlands', BE: 'Belgium', PL: 'Poland', RO: 'Romania',
  GR: 'Greece', UA: 'Ukraine', RU: 'Russia', TR: 'Turkey', IL: 'Israel', AE: 'United Arab Emirates', SA: 'Saudi Arabia',
  QA: 'Qatar', MA: 'Morocco', EG: 'Egypt', NG: 'Nigeria', ZA: 'South Africa', IN: 'India', PK: 'Pakistan',
  PH: 'Philippines', LY: 'Libya', MT: 'Malta', AU: 'Australia', SE: 'Sweden', NO: 'Norway', DK: 'Denmark', AT: 'Austria'
};

export const ALIAS_PAIS = {
  US: 'United States', USA: 'United States', 'U.S.': 'United States', 'U.S': 'United States', EEUU: 'United States',
  'EE.UU.': 'United States', 'EE.UU': 'United States', 'ESTADOS UNIDOS': 'United States', 'UNITED STATES OF AMERICA': 'United States',
  UK: 'United Kingdom', 'U.K.': 'United Kingdom', 'REINO UNIDO': 'United Kingdom', ENGLAND: 'United Kingdom', 'GREAT BRITAIN': 'United Kingdom',
  'ESPAÑA': 'Spain', ESPANA: 'Spain',
  'MÉXICO': 'Mexico', MEJICO: 'Mexico', 'MÉJICO': 'Mexico',
  'TÜRKIYE': 'Turkey', TURKIYE: 'Turkey'
};

// IDÉNTICO a index.html: acepta ISO-2, alias y limpia basura ("País", números sueltos, vacío).
export function normPais(p) {
  if (p === null || p === undefined) return 'Sin país';
  const k = String(p).trim();
  if (!k) return 'Sin país';
  if (/^sin\s+pa[ií]s$/i.test(k)) return 'Sin país';
  if (/^pa[ií]s$/i.test(k) || /^\d+$/.test(k)) return 'Sin país';
  const up = k.toUpperCase();
  if (k.length === 2 && ISO2[up]) return ISO2[up];
  if (ALIAS_PAIS[up]) return ALIAS_PAIS[up];
  return k;
}

// Clave normalizada para emparejar nombres de campaña de la plataforma con el utm_campaign del CRM.
// (minúsculas, sin acentos, solo alfanumérico) -> "Blefaro_ES 2026!" y "blefaro es 2026" colapsan igual.
export function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // quita acentos combinados
    .replace(/[^a-z0-9]+/g, '');
}

// Lista de meses 'YYYY-MM' que INTERSECAN el rango [from,to] (ambos 'YYYY-MM-DD'), inclusive.
// Se usa para sumar los buckets mensuales del gasto MANUAL dentro del rango del filtro.
// Nota: incluye el mes entero aunque el filtro cubra solo parte de él (el gasto manual es aproximado).
export function monthsInRange(from, to) {
  const out = [];
  if (!from || !to) return out;
  const [fy, fm] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  let y = fy, m = fm;
  for (let guard = 0; guard < 240; guard++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (y === ty && m === tm) break;
    if (y > ty || (y === ty && m >= tm)) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// Suma un objeto {YYYY-MM: importe} sobre los meses que caen dentro del rango.
export function sumMonthly(monthly, from, to) {
  if (!monthly) return 0;
  const meses = new Set(monthsInRange(from, to));
  let s = 0;
  for (const [ym, v] of Object.entries(monthly)) {
    if (meses.has(ym)) s += Number(v) || 0;
  }
  return Math.round(s * 100) / 100;
}
