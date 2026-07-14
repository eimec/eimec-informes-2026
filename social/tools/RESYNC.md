# RESYNC — Re-sincronización diaria del Informe Social Media con Metricool

Objetivo: actualizar `social/data.json` y `social/img/` con los datos de los últimos días
desde la API de Metricool (vía las herramientas MCP de Metricool disponibles en la sesión)
y publicar con git push (Vercel redespliega solo).

**Repo:** `C:\Users\matia\eimec-informes-2026` (remote origin ya lleva credenciales; push a `main`).
**Si las herramientas MCP de Metricool NO están disponibles en la sesión: ABORTA sin tocar ningún archivo.**
El informe seguirá mostrando el último snapshot bueno.

## Paso 0 — preparación

- Directorio de trabajo temporal: crea una carpeta `upd/` en el scratchpad de la sesión.
- `git -C C:\Users\matia\eimec-informes-2026 pull --ff-only` antes de empezar.
- Ventanas: **evolution = últimos 14 días**, **posts/contenido = últimos 30 días** (formato fechas: `YYYY-MM-DDTHH:MM:SS+02:00`).

## Paso 1 — descargar actualizaciones por marca-red

Herramienta: `getAnalyticsDataByMetrics(brandId, from, to, metrics[])`.
La respuesta de **evolution** es `{rows:[[v1,...,vN,"YYYYMMDD"],...]}` — la ÚLTIMA columna es la fecha,
el resto en el MISMO orden en que pediste las métricas; valores como strings o null.
Los connectors de **contenido** devuelven las columnas en el orden pedido **SIN columna de fecha extra**.

Matriz marca-red (brandId → redes):

| Marca | brandId | redes |
|---|---|---|
| eimec.es | 886877 | ig, tt, yt, fb, li, gbp |
| eimec.clinic | 3409101 | ig, tt, yt, fb |
| EIMEC Talks | 5398855 | ig, tt, yt, fb |
| Zainela Laborde | 5387113 | ig, li |
| eimec.global | 6236985 | ig, yt |

Métricas por red (network → fieldIds):

- **ig** (network `instagram`): evolution `IGEV01`(followers LAST), `IGEV03`(follows), `IGEV06`(reach), `IGEV05`(views), `IGEV38`(inter), `IGEV37`(posts), `IGEV16`(stories), `IGEV18`(storiesReach).
  Contenido: connector `posts` → `IGPO02`(fecha+hora), `IGPO03`(content), `IGPO05`(image), `IGPO06`(url), `IGPO07`(type), `IGPO14`(reach), `IGPO28`(views), `IGPO12`(inter), `IGPO13`(likes), `IGPO08`(comments), `IGPO15`(saves), `IGPO27`(shares); connector `reels` → `IGRE02,03,05,06,11,23,09,10,07,12,21` (mismos conceptos; todo es fmt "Reel").
  fmt: FEED_CAROUSEL_ALBUM→Carrusel, FEED_IMAGE→Imagen, reels→Reel.
- **tt** (network `tiktok`): evolution `TKEV07`(followers), `TKEV08`(follows), `TKEV11`(reach), `TKEV12`(views), `TKEV06`(inter), `TKEV01`(posts).
  Contenido: connector `posts` → `TKPO02`(fecha), `TKPO05`(content), `TKPO04`(image), `TKPO03`(url), `TKPO22`(type), `TKPO11`(reach, suele venir null), `TKPO07`(views), `TKPO08`(likes), `TKPO09`(comments), `TKPO10`(shares). No hay saves ni inter agregado: **inter = likes+comments+shares**. fmt: VIDEO→Vídeo, PHOTO→Imagen.
- **yt** (network `youtube`): evolution `YTEV01`(subscribers), `YTEV05`(gained), `YTEV06`(lost) → **follows = gained − lost**, `YTEV02`(reach=videoViews), `YTEV04`(posts).
  Contenido: connector `videos published in range` → `YTVP02`(fecha), `YTVP17`(título=content), `YTVP03`(image), `YTVP05`(url), `YTVP06`(views), `YTVP09`(likes), `YTVP11`(comments), `YTVP12`(shares). inter = likes+comments+shares. fmt: "Short" si el título contiene #shorts, si no "Vídeo".
- **fb** (network `facebook`): evolution `FBEV17`(followers), `FBEV47`(acquired), `FBEV48`(lost) → **follows = acquired − lost**, `FBEV20`(reach, suele venir null), `FBEV49`(views=Page Media View), `FBEV34`(inter), `FBEV33`(posts), `FBEV35`(stories).
  Contenido: connector `posts` → `FBPO02,03,05,06,07,20,11,13,08,14` (fecha, content, image, url, type, reach organico, views, likes=reactions, comments, shares); connector `reels` → `FBRE02,05,04,06,11,10,07,08` (fecha, content, image, url, reach, views, inter=Reel Actions, likes); fmt reels→Reel, VIDEO→Vídeo, resto→Imagen.
- **li** (network `linkedin`): evolution `LIEV01`(followers), `LIEV08`(follows), `LIEV22`(reach=post impressions), `LIEV31`(views), `LIEV10`(inter), `LIEV04`(posts).
  Contenido: connector `posts` → `LIPO02`(fecha), `LIPO04`(content), `LIPO07`(image), `LIPO08`(url), `LIPO19`(type), `LIPO12`(reach=impressions), `LIPO13`(likes), `LIPO10`(comments), `LIPO18`(shares). fmt por type: MULTIIMAGE→Carrusel, VIDEO→Vídeo, IMAGE→Imagen, DOCUMENT→Documento, ARTICLE→Articulo, TEXT→Texto, null→Post.
- **gbp** (network `googleBusinessProfile`): evolution `GMEV18`(reachSearch), `GMEV19`(reachMaps) → **views = GMEV18+GMEV19** y **searches = GMEV18**, `GMEV21`(webClicks), `GMEV22`(calls), `GMEV23`(directions), `GMEV13`(reviews), `GMEV12`(rating AVG). Sin posts. OJO: GBP publica con ~3-4 días de retraso.

Para cada marca-red, escribe un archivo `upd/<brandId>-<net>.json` con este shape EXACTO
(igual que los canónicos de `social/tools/mc/`):

```json
{"net":"ig","brandId":"886877","label":"eimec.es","followersNow":21426,
 "daily":[{"d":"2026-07-01","followers":21400,"follows":5,"reach":4500,"views":9000,"inter":30,"posts":1,"stories":2,"storiesReach":150}],
 "posts":[{"id":"...","date":"2026-07-02T20:14","fmt":"Reel","title":"máx 110 chars sin saltos","image":"https://...","url":"https://...","reach":1234,"views":2000,"inter":56,"likes":40,"comments":6,"saves":5,"shares":5}]}
```

Claves que no apliquen a la red → `null`. Para gbp: daily con `d, views, searches, webClicks, calls, directions, reviews, rating` y `posts: []`.
**No inventes datos**; si una llamada falla, reintenta una vez y si no, salta esa marca-red y anótalo.

## Paso 2 — fusionar y regenerar

Por cada archivo de actualización:
```
python C:\Users\matia\eimec-informes-2026\social\tools\merge_update.py <ruta upd/...json>
```
Después:
```
python C:\Users\matia\eimec-informes-2026\social\tools\assemble.py
python C:\Users\matia\eimec-informes-2026\social\tools\download_thumbs.py
```
`download_thumbs.py` solo descarga las imágenes nuevas (idempotente) y pone a null las URLs caducadas.

**REGLA CRÍTICA: después de CUALQUIER ejecución de `assemble.py` hay que ejecutar SIEMPRE `download_thumbs.py`.**
`assemble.py` reconstruye data.json desde los mc/*.json, que guardan las URLs http originales (caducables);
sin el paso de thumbs, el informe queda apuntando a imágenes que morirán en días.

## Paso 3 — validar antes de publicar (obligatorio)

- `python -c "import json;d=json.load(open(r'C:\Users\matia\eimec-informes-2026\social\data.json',encoding='utf-8'));assert len(d['brands'])==5;print('OK',len(d['days']),'dias')"`
- El nº de posts por marca-red en data.json NUNCA debe bajar respecto al commit anterior (merge solo añade). Si baja, ABORTA y no publiques.

## Paso 4 — publicar

```
git -C C:\Users\matia\eimec-informes-2026 add social/data.json social/img social/tools/mc
git -C C:\Users\matia\eimec-informes-2026 commit -m "Social: resync Metricool <fecha>"
git -C C:\Users\matia\eimec-informes-2026 push origin main
```
Comprueba que `https://eimec-informes-2026.vercel.app/social/data.json` devuelve el nuevo `generatedAt` (puede tardar ~1 min).

## Semanal (solo lunes)

Actualiza también las mejores horas: `getBestTimeToPostByNetwork` (instagram) para cada brandId,
normaliza a `{"brandId":"...","cells":[{"dow":0-6 con 0=lunes,"hour":0-23,"score":n}]}` y guarda en
`social/tools/mc/<brandId>-besttimes.json` antes de ejecutar assemble. OJO: la API devuelve dayOfWeek 1-7
con convenciones distintas según la cuenta; verifica con el patrón de scores qué día es cuál (1=lunes normalmente).
