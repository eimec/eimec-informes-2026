// Vercel Serverless Function - api/oauth-exchange.js
// PUENTE DE UN SOLO USO para obtener el refresh token de Google Ads SIN copiar/pegar entre ventanas.
// Flujo: GET sin params → redirige al consentimiento de Google (app interna de eimec.com).
//        Google vuelve con ?code=... → esta función lo intercambia EN EL SERVIDOR usando
//        GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (ya guardados en Vercel) y muestra el
//        refresh token con un botón COPIAR. El secret nunca sale del servidor.
// ⚠️ BORRAR este fichero cuando GOOGLE_ADS_REFRESH_TOKEN esté configurado (es un puente temporal).
//    Solo usuarios de la organización eimec.com pueden completar el consentimiento (app interna).
export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const CID = process.env.GOOGLE_CLIENT_ID;
  const CSEC = process.env.GOOGLE_CLIENT_SECRET;
  if (!CID || !CSEC) { res.status(200).send('Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en Vercel.'); return; }

  const self = `https://${req.headers.host}/api/oauth-exchange`;
  const { code, error } = req.query || {};

  if (error) { res.status(200).send('Google devolvio un error: ' + String(error)); return; }

  if (!code) {
    // Paso 1: mandar al consentimiento de Google
    const qs = new URLSearchParams({
      client_id: CID, redirect_uri: self, response_type: 'code',
      scope: 'https://www.googleapis.com/auth/adwords',
      access_type: 'offline', prompt: 'consent'
    });
    res.writeHead(302, { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + qs.toString() });
    res.end();
    return;
  }

  // Paso 2: intercambiar el code por el refresh token (el secret vive solo en el servidor)
  try {
    const body = new URLSearchParams({
      code: String(code), client_id: CID, client_secret: CSEC,
      redirect_uri: self, grant_type: 'authorization_code'
    });
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
    });
    const j = await r.json();
    if (!j.refresh_token) {
      res.status(200).send('No llego refresh_token. Respuesta: ' + JSON.stringify(j).slice(0, 300) + ' — recarga /api/oauth-exchange para reintentar.');
      return;
    }
    const t = j.refresh_token;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Refresh token</title></head>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:60px auto;padding:0 20px;text-align:center">
  <h1 style="font-size:22px">✅ Refresh token de Google Ads generado</h1>
  <p style="color:#555">Paso 1: pulsa el botón. Paso 2: en la pestaña de Vercel que se abre, fila <b>GOOGLE_ADS_REFRESH_TOKEN</b> → ⋯ → Edit → clic en Value → <b>Ctrl+V</b> → Save.</p>
  <div id="tok" style="font-family:monospace;font-size:13px;background:#f4f4f6;border:1px solid #ddd;border-radius:10px;padding:14px;word-break:break-all;margin:18px 0">${t}</div>
  <button onclick="navigator.clipboard.writeText(document.getElementById('tok').textContent).then(()=>{this.textContent='✅ COPIADO — ve a Vercel y pulsa Ctrl+V';this.style.background='#1a7f37'})"
    style="font-size:20px;padding:16px 34px;background:#0b57d0;color:#fff;border:none;border-radius:12px;cursor:pointer;font-weight:700">📋 COPIAR TOKEN</button>
  <p style="margin-top:22px"><a href="https://vercel.com/info-84166052s-projects/eimec-informes-2026/settings/environment-variables" target="_blank" style="font-size:15px">→ Abrir las variables de Vercel</a></p>
  <p style="color:#999;font-size:12px;margin-top:30px">Página temporal: se eliminará al terminar la configuración.</p>
</body></html>`);
  } catch (e) {
    res.status(200).send('Error intercambiando el codigo: ' + e.message);
  }
}
