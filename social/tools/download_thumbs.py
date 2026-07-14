# -*- coding: utf-8 -*-
"""Descarga las miniaturas de posts que aun apunten a URLs http (las de Metricool
caducan) y reescribe social/data.json para usar la copia local en social/img/.
Idempotente: las imagenes ya descargadas no se repiten.
Uso: python download_thumbs.py"""
import json, os, io, hashlib
from concurrent.futures import ThreadPoolExecutor
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data.json")
IMGDIR = os.path.join(HERE, "..", "img")
os.makedirs(IMGDIR, exist_ok=True)

try:
    from PIL import Image
    HAVE_PIL = True
except ImportError:
    HAVE_PIL = False

with io.open(DATA, encoding="utf-8") as f:
    data = json.load(f)

jobs = {}
for label, B in data["brands"].items():
    for net, Nt in B["nets"].items():
        for p in Nt["posts"]:
            u = p.get("image")
            if u and u.startswith("http"):
                jobs[u] = hashlib.md5(u.encode("utf-8")).hexdigest()[:12] + ".jpg"

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Referer": "https://app.metricool.com/"}
ok, fail = {}, []

def fetch(item):
    url, fname = item
    path = os.path.join(IMGDIR, fname)
    if os.path.exists(path) and os.path.getsize(path) > 500:
        ok[url] = fname; return
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read()
        if len(raw) < 500:
            fail.append(url); return
        if HAVE_PIL:
            try:
                im = Image.open(io.BytesIO(raw)).convert("RGB")
                w, h = im.size
                if w > 480: im = im.resize((480, int(h * 480 / w)))
                im.save(path, "JPEG", quality=72)
            except Exception:
                with open(path, "wb") as fo: fo.write(raw)
        else:
            with open(path, "wb") as fo: fo.write(raw)
        ok[url] = fname
    except Exception:
        fail.append(url)

with ThreadPoolExecutor(max_workers=10) as ex:
    list(ex.map(fetch, jobs.items()))

hits = 0
for label, B in data["brands"].items():
    for net, Nt in B["nets"].items():
        for p in Nt["posts"]:
            u = p.get("image")
            if u and u in ok:
                p["image"] = "img/" + ok[u]; hits += 1
            elif u and u.startswith("http"):
                p["image"] = None

with io.open(DATA, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

print("imagenes pendientes: %d | OK: %d | fallidas: %d | posts actualizados: %d"
      % (len(jobs), len(ok), len(fail), hits))
