// VERCEL SERVERLESS - api/ac-data.js (v2 - Production Ready)
// Análisis de Growth Data con filtros bulletproof

const AC_API_KEY = '585ad37ae247398fadfacf536416c0e86ae994f830bc97d90a7847eeae1ae4414f394e0d';
const AC_URL = 'https://eimec.api-us1.com/api/3';

const STAGES = { f1: 33, f2: 34, f3: 36, f4: 37, trash: 12 };
const FIELDS = { curso: 3, fecha_ganado: 5, pais: 40 };

// Fecha mínima para las queries (evita traer data vieja innecesaria)
function getMinDateParam(from) {
  const minDate = from || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000); // 1 año máximo
  return Math.floor(minDate.getTime() / 1000);
}

async function fetchAC(endpoint, params = {}) {
  const queryParams = new URLSearchParams({ api_token: AC_API_KEY, ...params });
  const url = `${AC_URL}${endpoint}?${queryParams}`;

  console.log(`[AC API] GET ${url.substring(0, 100)}...`);

  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    timeout: 15000
  });

  if (!response.ok) {
    throw new Error(`AC API ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

async function getAllDeals(params = {}) {
  let allDeals = [];
  let offset = 0;
  const limit = 100;
  let hasMore = true;

  while (hasMore && offset < 5000) { // Máximo 5000 deals
    try {
      const data = await fetchAC('/deals', { limit, offset, ...params });

      if (data.deals && data.deals.length > 0) {
        allDeals = allDeals.concat(data.deals);
        hasMore = data.deals.length === limit;
        offset += limit;
      } else {
        hasMore = false;
      }
    } catch (error) {
      console.error(`Error fetching deals at offset ${offset}:`, error);
      hasMore = false;
    }
  }

  return allDeals;
}

function parseDate(dateStr) {
  if (!dateStr) return null;

  if (typeof dateStr === 'number') {
    return new Date(dateStr * 1000);
  }

  if (dateStr.includes('T')) {
    return new Date(dateStr);
  }

  // Intenta parsear yyyy-mm-dd
  const [year, month, day] = dateStr.split('-');
  if (year && month && day) {
    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  }

  return null;
}

function filterByDateRange(deals, from, to, dateField = 'updated_timestamp') {
  if (!from || !to) return deals;

  const fromTime = from.getTime();
  const toTime = to.getTime() + (24 * 60 * 60 * 1000); // Incluye todo el día

  return deals.filter(deal => {
    let dealTime;
    const dateValue = deal[dateField] || deal.won_date;

    if (typeof dateValue === 'number') {
      dealTime = dateValue * 1000;
    } else if (dateValue) {
      dealTime = new Date(dateValue).getTime();
    } else {
      return false;
    }

    return dealTime >= fromTime && dealTime <= toTime;
  });
}

async function enrichContactData(deals) {
  const enriched = [];
  const contactCache = {};

  for (const deal of deals) {
    try {
      if (!deal.contact) continue;

      // Cachear contactos para evitar requests duplicados
      if (!contactCache[deal.contact]) {
        const contactData = await fetchAC(`/contacts/${deal.contact}`);
        if (contactData.contact) {
          const contact = contactData.contact;
          const fields = contact.fields || [];

          contactCache[deal.contact] = {
            curso: fields.find(f => f.id === String(FIELDS.curso))?.value || 'Sin Curso',
            pais: fields.find(f => f.id === String(FIELDS.pais))?.value || 'Desconocido',
            fecha_ganado: fields.find(f => f.id === String(FIELDS.fecha_ganado))?.value || null
          };
        }
      }

      const contact = contactCache[deal.contact];
      if (contact) {
        enriched.push({
          id: deal.id,
          title: deal.title,
          stage: deal.stage,
          value: deal.value || 0,
          date_won: deal.won_date || deal.updated_timestamp,
          date_created: deal.created_timestamp,
          status: deal.status,
          curso: contact.curso,
          pais: contact.pais,
          fecha_ganado: contact.fecha_ganado
        });
      }
    } catch (error) {
      console.error(`Error enriching deal ${deal.id}:`, error);
    }
  }

  return enriched;
}

function calculateGrowthMetrics(deals, from, to) {
  if (deals.length === 0) {
    return {
      total: 0,
      daily_avg: 0,
      velocity: 0,
      cycle_time_avg: 0
    };
  }

  const daysDiff = Math.max(1, Math.ceil((to - from) / (1000 * 60 * 60 * 24)));
  const daily_avg = Math.round(deals.length / daysDiff);

  return {
    total: deals.length,
    daily_avg,
    velocity: deals.length > 0 ? Math.round((deals.length / daysDiff) * 30) : 0, // Proyección a 30 días
    pct_change: 0 // Calcularía vs período anterior
  };
}

function groupByDate(deals, dateField = 'date_won') {
  const grouped = {};

  deals.forEach(deal => {
    const dateValue = deal[dateField];
    if (!dateValue) return;

    let dateStr;
    if (typeof dateValue === 'number') {
      dateStr = new Date(dateValue * 1000).toISOString().split('T')[0];
    } else if (dateValue.includes('T')) {
      dateStr = dateValue.split('T')[0];
    } else {
      dateStr = dateValue;
    }

    grouped[dateStr] = (grouped[dateStr] || 0) + 1;
  });

  // Ordenar y llenar gaps de días sin datos
  const sorted = Object.keys(grouped).sort();
  const filled = {};

  if (sorted.length > 0) {
    const [firstYear, firstMonth, firstDay] = sorted[0].split('-').map(Number);
    const [lastYear, lastMonth, lastDay] = sorted[sorted.length - 1].split('-').map(Number);

    let current = new Date(firstYear, firstMonth - 1, firstDay);
    const end = new Date(lastYear, lastMonth - 1, lastDay);

    while (current <= end) {
      const dateStr = current.toISOString().split('T')[0];
      filled[dateStr] = grouped[dateStr] || 0;
      current.setDate(current.getDate() + 1);
    }
  }

  return filled;
}

function buildMatrix(deals) {
  const matrix = {};
  const paisStats = {};
  const cursoStats = {};

  deals.forEach(deal => {
    const curso = deal.curso || 'Sin Curso';
    const pais = deal.pais || 'Desconocido';

    // Matriz
    if (!matrix[curso]) matrix[curso] = {};
    matrix[curso][pais] = (matrix[curso][pais] || 0) + 1;

    // Stats por país
    if (!paisStats[pais]) {
      paisStats[pais] = { total: 0, value: 0, courses: {} };
    }
    paisStats[pais].total++;
    paisStats[pais].value += deal.value || 0;
    paisStats[pais].courses[curso] = (paisStats[pais].courses[curso] || 0) + 1;

    // Stats por curso
    if (!cursoStats[curso]) {
      cursoStats[curso] = { total: 0, value: 0 };
    }
    cursoStats[curso].total++;
    cursoStats[curso].value += deal.value || 0;
  });

  return { matrix, paisStats, cursoStats };
}

function calculateConversionFunnel(f1, f2, f3, f4, won) {
  return {
    f1_to_f2: f1 > 0 ? Math.round((f2 / f1) * 100) : 0,
    f2_to_f3: f2 > 0 ? Math.round((f3 / f2) * 100) : 0,
    f3_to_f4: f3 > 0 ? Math.round((f4 / f3) * 100) : 0,
    f4_to_won: f4 > 0 ? Math.round((won / f4) * 100) : 0,
    total_won: (f1 + f2 + f3 + f4 + won) > 0 ? Math.round((won / (f1 + f2 + f3 + f4 + won)) * 100) : 0
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const { from, to } = req.query;

    // Parsear fechas
    let fromDate = from ? parseDate(from) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // Default 7d
    let toDate = to ? parseDate(to) : new Date();

    console.log(`[FILTER] From: ${fromDate.toISOString()}, To: ${toDate.toISOString()}`);

    // Obtener deals de todas las etapas
    const [f1All, f2All, f3All, f4All, wonAll, trashedAll] = await Promise.all([
      getAllDeals({ stage: STAGES.f1, status: 0 }),
      getAllDeals({ stage: STAGES.f2, status: 0 }),
      getAllDeals({ stage: STAGES.f3, status: 0 }),
      getAllDeals({ stage: STAGES.f4, status: 0 }),
      getAllDeals({ status: 1 }), // Won
      getAllDeals({ stage: STAGES.trash })
    ]);

    // Filtrar por rango de fecha (solo won y deals recientes)
    const wonFiltered = filterByDateRange(wonAll, fromDate, toDate, 'won_date');
    const f2Filtered = filterByDateRange(f2All, fromDate, toDate, 'updated_timestamp');

    // Enriquecer datos
    const wonEnriched = await enrichContactData(wonFiltered);
    const f2Enriched = await enrichContactData(f2Filtered);

    // Construir matriz y estadísticas
    const { matrix, paisStats, cursoStats } = buildMatrix(wonEnriched);

    // Agrupar por fecha
    const wonByDate = groupByDate(wonEnriched, 'date_won');
    const f2ByDate = groupByDate(f2Enriched, 'date_created');

    // Calcular métricas de growth
    const growthMetrics = calculateGrowthMetrics(wonEnriched, fromDate, toDate);

    // Funnel de conversión
    const conversionFunnel = calculateConversionFunnel(
      f1All.length,
      f2All.length,
      f3All.length,
      f4All.length,
      wonAll.length
    );

    // Respuesta
    res.status(200).json({
      ok: true,
      date_range: {
        from: fromDate.toISOString().split('T')[0],
        to: toDate.toISOString().split('T')[0],
        days: Math.ceil((toDate - fromDate) / (1000 * 60 * 60 * 24))
      },
      pipeline: {
        f1: f1All.length,
        f2: f2All.length,
        f3: f3All.length,
        f4: f4All.length,
        trash: trashedAll.length
      },
      won_count: wonAll.length,
      won_deals: wonEnriched,
      conversion_funnel: conversionFunnel,
      growth_metrics: growthMetrics,
      matrix,
      pais_stats: paisStats,
      curso_stats: cursoStats,
      won_by_date: wonByDate,
      f2_by_date: f2ByDate,
      timestamp: new Date().toISOString(),
      cached: false
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}
