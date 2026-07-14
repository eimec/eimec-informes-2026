# -*- coding: utf-8 -*-
"""Ensambla los JSON por marca-red (social/tools/mc/) en social/data.json.
Uso: python assemble.py   (rutas relativas al propio script)"""
import json, os, io, re
from datetime import date, timedelta, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "mc")
OUT = os.path.join(HERE, "..", "data.json")

D0 = date(2026, 1, 15)
D1 = date.today()  # el front ancla los periodos en el penultimo dia con datos

DAYS = [(D0 + timedelta(days=i)).isoformat() for i in range((D1 - D0).days + 1)]
IDX = {d: i for i, d in enumerate(DAYS)}
N = len(DAYS)

BRANDS = {
    "886877":  {"label": "eimec.es",        "avatar": "ES", "handles": {"ig": "@eimec.es",       "tt": "@eimec",        "yt": "EIMEC",        "fb": "EIMEC Formación", "li": "EIMEC"}},
    "3409101": {"label": "eimec.clinic",    "avatar": "CL", "handles": {"ig": "@eimec.clinic",   "tt": "@eimec.clinic", "yt": "EIMEC Clinic", "fb": "EIMEC Clinic"}},
    "5398855": {"label": "EIMEC Talks",     "avatar": "TK", "handles": {"ig": "@eimectalks",     "tt": "@eimec.talks",  "yt": "EIMEC Talks",  "fb": "EIMEC Talks"}},
    "5387113": {"label": "Zainela Laborde", "avatar": "ZL", "handles": {"ig": "@zainelalaborde", "li": "Zainela Laborde"}},
    "6236985": {"label": "eimec.global",    "avatar": "GL", "handles": {"ig": "@eimec",          "yt": "EIMEC Global"}},
}

def num(v):
    if v is None: return None
    try: return float(v)
    except (TypeError, ValueError): return None

def aligned(daily, key):
    arr = [None] * N
    for row in daily:
        d = row.get("d")
        if d in IDX: arr[IDX[d]] = num(row.get(key))
    return arr

def ffill(arr):
    out = list(arr); last = None
    for i, v in enumerate(out):
        if v is not None: last = v
        else: out[i] = last
    first = next((v for v in out if v is not None), None)
    for i in range(len(out)):
        if out[i] is None: out[i] = first
    return out

def zfill(arr): return [v if v is not None else 0 for v in arr]
def r1(x): return None if x is None else round(x, 1)

problems = []
brands_out = {}
CANON = re.compile(r"^\d+-(ig|tt|yt|fb|li|gbp)\.json$")

for fname in sorted(os.listdir(SRC)):
    if not CANON.match(fname): continue
    with io.open(os.path.join(SRC, fname), encoding="utf-8") as f:
        data = json.load(f)
    bid = str(data.get("brandId", "")); net = data.get("net", "")
    if bid not in BRANDS:
        problems.append("marca desconocida en %s" % fname); continue
    label = BRANDS[bid]["label"]
    B = brands_out.setdefault(label, {"id": bid, "avatar": BRANDS[bid]["avatar"], "nets": {}, "gbp": None, "bestTimes": []})
    daily = data.get("daily") or []

    if net == "gbp":
        B["gbp"] = {
            "views":     zfill(aligned(daily, "views")),
            "searches":  zfill(aligned(daily, "searches")),
            "webClicks": zfill(aligned(daily, "webClicks")),
            "calls":     zfill(aligned(daily, "calls")),
            "directions":zfill(aligned(daily, "directions")),
            "reviews":   zfill(aligned(daily, "reviews")),
            "rating":    ffill(aligned(daily, "rating")),
        }
        continue

    followers = ffill(aligned(daily, "followers"))
    follows = zfill(aligned(daily, "follows"))
    if all(v == 0 for v in follows) and followers[0] is not None:
        for i in range(1, N):
            if followers[i] is not None and followers[i-1] is not None:
                follows[i] = followers[i] - followers[i-1]
    reach = zfill(aligned(daily, "reach"))
    views = zfill(aligned(daily, "views"))
    # Facebook: la API da reach diario null -> views (Page Media View) como alcance efectivo
    if sum(reach) == 0 and sum(views) > 0:
        reach = list(views)
    inter = zfill(aligned(daily, "inter"))
    postsD = zfill(aligned(daily, "posts"))
    stories = zfill(aligned(daily, "stories"))
    storiesReach = zfill(aligned(daily, "storiesReach"))

    posts = []
    for p in (data.get("posts") or []):
        dt = p.get("date") or ""
        d10 = dt[:10]
        if d10 not in IDX: continue
        likes = num(p.get("likes")); comments = num(p.get("comments"))
        saves = num(p.get("saves")); shares = num(p.get("shares"))
        it = num(p.get("inter"))
        if it is None:
            comp = [x for x in (likes, comments, saves, shares) if x is not None]
            it = sum(comp) if comp else 0
        rc = num(p.get("reach")); vw = num(p.get("views"))
        den = rc if (rc or 0) > 0 else (vw if (vw or 0) > 0 else None)
        er = (it / den * 100) if den else None
        title = (p.get("title") or "").strip() or "(sin texto)"
        posts.append({
            "day": IDX[d10],
            "time": dt[11:16] if len(dt) >= 16 else "",
            "net": net, "fmt": p.get("fmt") or "Post",
            "title": title[:110],
            "image": p.get("image") or None,
            "url": p.get("url") or None,
            "reach": rc, "views": vw, "inter": it,
            "likes": likes, "comments": comments, "saves": saves, "shares": shares,
            "er": r1(er),
        })
    posts.sort(key=lambda p: p["day"])

    followersNow = num(data.get("followersNow"))
    if followersNow is None:
        followersNow = followers[-1] if followers[-1] is not None else 0

    B["nets"][net] = {
        "handle": BRANDS[bid]["handles"].get(net, ""),
        "followersNow": followersNow,
        "followers": followers, "follows": follows,
        "reach": reach, "views": views, "inter": inter,
        "postsD": postsD, "stories": stories, "storiesReach": storiesReach,
        "posts": posts,
    }

BT = re.compile(r"^\d+-besttimes\.json$")
for fname in sorted(os.listdir(SRC)):
    if not BT.match(fname): continue
    with io.open(os.path.join(SRC, fname), encoding="utf-8") as f:
        data = json.load(f)
    bid = str(data.get("brandId", ""))
    if bid in BRANDS:
        brands_out[BRANDS[bid]["label"]]["bestTimes"] = data.get("cells") or []

def compact(o):
    if isinstance(o, float):
        return int(o) if abs(o - int(o)) < 1e-9 else round(o, 2)
    if isinstance(o, list): return [compact(x) for x in o]
    if isinstance(o, dict): return {k: compact(v) for k, v in o.items()}
    return o

result = compact({
    "generatedAt": datetime.now().strftime("%Y-%m-%dT%H:%M"),
    "days": DAYS,
    "brands": brands_out,
})

with io.open(OUT, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, separators=(",", ":"))

print("data.json escrito: %.0f KB, %d dias" % (os.path.getsize(OUT) / 1024.0, N))
for label, B in result["brands"].items():
    nets = ", ".join("%s(%d posts)" % (n, len(v["posts"])) for n, v in B["nets"].items())
    print("  %s: %s%s" % (label, nets, " + GBP" if B["gbp"] else ""))
if problems:
    print("PROBLEMAS:"); [print("  -", p) for p in problems]
