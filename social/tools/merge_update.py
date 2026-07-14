# -*- coding: utf-8 -*-
"""Fusiona un JSON de actualizacion (ventana corta de dias/posts recientes) en el
archivo canonico social/tools/mc/<brandId>-<net>.json.
Uso: python merge_update.py <ruta_update.json>
El update tiene el mismo shape que los canonicos:
{"net":"ig","brandId":"886877","followersNow":n|null,
 "daily":[{"d":"YYYY-MM-DD",...}...], "posts":[{...,"date":"YYYY-MM-DDTHH:MM","url":...}...]}
Reglas: daily se reemplaza por fecha; posts se upsertan por url (o date+title si no hay url);
followersNow se actualiza si no es null. Nunca borra datos antiguos."""
import json, os, io, sys

HERE = os.path.dirname(os.path.abspath(__file__))

def main():
    if len(sys.argv) != 2:
        print("uso: python merge_update.py <update.json>"); sys.exit(1)
    with io.open(sys.argv[1], encoding="utf-8") as f:
        upd = json.load(f)
    bid, net = str(upd["brandId"]), upd["net"]
    canon_path = os.path.join(HERE, "mc", "%s-%s.json" % (bid, net))
    if os.path.exists(canon_path):
        with io.open(canon_path, encoding="utf-8") as f:
            base = json.load(f)
    else:
        base = {"net": net, "brandId": bid, "label": upd.get("label", ""), "followersNow": None, "daily": [], "posts": []}

    # daily: reemplazo por fecha
    by_date = {r["d"]: r for r in base.get("daily", []) if r.get("d")}
    changed_days = 0
    for r in (upd.get("daily") or []):
        if r.get("d"):
            by_date[r["d"]] = r; changed_days += 1
    base["daily"] = sorted(by_date.values(), key=lambda r: r["d"])

    # posts: upsert por url o (date+title)
    def key(p): return p.get("url") or ((p.get("date") or "")[:16] + "|" + (p.get("title") or ""))
    by_key = {key(p): p for p in base.get("posts", [])}
    new_posts = 0
    for p in (upd.get("posts") or []):
        k = key(p)
        if k not in by_key: new_posts += 1
        by_key[k] = p
    base["posts"] = sorted(by_key.values(), key=lambda p: p.get("date") or "")

    if upd.get("followersNow") is not None:
        base["followersNow"] = upd["followersNow"]

    with io.open(canon_path, "w", encoding="utf-8") as f:
        json.dump(base, f, ensure_ascii=False, separators=(",", ":"))
    print("%s-%s: %d dias actualizados, %d posts nuevos, followersNow=%s"
          % (bid, net, changed_days, new_posts, base.get("followersNow")))

if __name__ == "__main__":
    main()
