"""Hebbes — self-hosted wishlist voor je CD's en games."""
import io
import json
import mimetypes
import os
import re
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import openpyxl
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
DB_PATH = DATA_DIR / "wishlist.db"
COVER_DIR = DATA_DIR / "covers"
STATIC_DIR = Path(__file__).parent / "static"
COVERS_ENABLED = os.environ.get("COVERS", "1") != "0"

TYPES = ["cd", "game"]
STATUSES = ["gezocht", "gespot", "besteld", "in_bezit"]
STATUS_LABEL = {"gezocht": "Gezocht", "gespot": "Gespot", "besteld": "Besteld", "in_bezit": "In bezit"}

DATA_DIR.mkdir(parents=True, exist_ok=True)
COVER_DIR.mkdir(parents=True, exist_ok=True)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as c:
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        c.execute(
            """CREATE TABLE IF NOT EXISTS items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL DEFAULT 'cd',
                titel TEXT NOT NULL,
                band TEXT,
                platform TEXT,
                jaar INTEGER,
                status TEXT NOT NULL DEFAULT 'gezocht',
                prijs REAL,
                bron TEXT,
                uitgave TEXT,
                notitie TEXT,
                cover TEXT,
                toegevoegd TEXT,
                gewijzigd TEXT
            )"""
        )
        # Migratie vanuit de eerste versie (alleen CD's in tabel 'albums')
        if "albums" in tables and "items" not in tables:
            c.execute(
                """INSERT INTO items (id, type, titel, band, jaar, status, prijs, bron, uitgave, notitie, cover,
                                      toegevoegd, gewijzigd)
                   SELECT id, 'cd', album, band, jaar, status, prijs, bron, uitgave, notitie,
                          CASE WHEN cover IS NOT NULL AND cover <> '' THEN cover ELSE cover END,
                          toegevoegd, gewijzigd
                   FROM albums"""
            )
            c.execute("ALTER TABLE albums RENAME TO albums_backup_v1")


init_db()


class ItemIn(BaseModel):
    type: str = "cd"
    titel: str
    band: Optional[str] = None
    platform: Optional[str] = None
    jaar: Optional[int] = None
    status: str = "gezocht"
    prijs: Optional[float] = None
    bron: Optional[str] = None
    uitgave: Optional[str] = None
    notitie: Optional[str] = None


def clean(item: ItemIn) -> dict:
    d = item.model_dump()
    for k in ("titel", "band", "platform", "bron", "uitgave", "notitie"):
        if d[k] is not None:
            d[k] = d[k].strip() or None
    if d["type"] not in TYPES:
        raise HTTPException(400, f"Onbekend type: {d['type']}")
    if d["status"] not in STATUSES:
        raise HTTPException(400, f"Onbekende status: {d['status']}")
    if not d["titel"]:
        raise HTTPException(400, "Titel is verplicht")
    if d["type"] == "cd":
        if not d["band"]:
            raise HTTPException(400, "Band is verplicht")
        d["platform"] = None
    else:
        if not d["platform"]:
            raise HTTPException(400, "Platform is verplicht")
        d["band"] = None
    return d


app = FastAPI(title="Hebbes")


def get_item(c, iid: int):
    row = c.execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone()
    if not row:
        raise HTTPException(404, "Niet gevonden")
    return row


@app.get("/api/items")
def list_items():
    with db() as c:
        rows = c.execute("SELECT * FROM items").fetchall()
    return [dict(r) for r in rows]


@app.post("/api/items")
def create_item(item: ItemIn):
    d = clean(item)
    with db() as c:
        cur = c.execute(
            "INSERT INTO items (type, titel, band, platform, jaar, status, prijs, bron, uitgave, notitie,"
            " toegevoegd, gewijzigd) VALUES (:type, :titel, :band, :platform, :jaar, :status, :prijs, :bron,"
            " :uitgave, :notitie, :t, :t)",
            {**d, "t": now()},
        )
        return dict(get_item(c, cur.lastrowid))


@app.put("/api/items/{iid}")
def update_item(iid: int, item: ItemIn):
    d = clean(item)
    with db() as c:
        old = get_item(c, iid)
        # Andere titel/band/platform → automatisch gezochte hoes opnieuw zoeken (eigen upload blijft)
        changed = (old["titel"], old["band"], old["platform"]) != (d["titel"], d["band"], d["platform"])
        reset = changed and not (old["cover"] or "").startswith("u")
        c.execute(
            "UPDATE items SET type=:type, titel=:titel, band=:band, platform=:platform, jaar=:jaar, status=:status,"
            " prijs=:prijs, bron=:bron, uitgave=:uitgave, notitie=:notitie, gewijzigd=:t"
            + (", cover=NULL" if reset else "") + " WHERE id=:id",
            {**d, "t": now(), "id": iid},
        )
        return dict(get_item(c, iid))


@app.delete("/api/items/{iid}")
def delete_item(iid: int):
    with db() as c:
        row = c.execute("SELECT cover FROM items WHERE id=?", (iid,)).fetchone()
        c.execute("DELETE FROM items WHERE id=?", (iid,))
    if row and row["cover"]:
        (COVER_DIR / row["cover"]).unlink(missing_ok=True)
    return {"ok": True}


# ---------- Excel import / export ----------

HEADER_ALIASES = {
    "band": {"band", "artiest", "artist"},
    "titel": {"album", "titel", "title", "game", "naam", "spel"},
    "platform": {"platform", "console", "systeem"},
    "jaar": {"year", "jaar"},
    "prijs": {"prijs", "price"},
    "status": {"column1", "status"},
    "bron": {"bron", "winkel", "source"},
    "uitgave": {"uitgave", "editie", "edition"},
    "notitie": {"notitie", "notes", "opmerking"},
}


def map_status(raw) -> tuple[str, Optional[str]]:
    """Statuskolom: 'Check' = in bezit, leeg = gezocht, iets anders (bijv. 'Vinted') = gespot bij die bron."""
    s = str(raw or "").strip().lower()
    if not s:
        return "gezocht", None
    if s in ("check", "in_bezit", "in bezit", "gekocht"):
        return "in_bezit", None
    for k, label in STATUS_LABEL.items():
        if s in (k, label.lower()):
            return k, None
    return "gespot", str(raw).strip()


def parse_sheet(ws) -> list[dict]:
    rows = ws.iter_rows(values_only=True)
    header = next(rows, None)
    if not header:
        return []
    cols = {}
    for i, h in enumerate(header):
        key = str(h or "").strip().lower()
        for field, names in HEADER_ALIASES.items():
            if key in names and field not in cols:
                cols[field] = i
    if "titel" not in cols or ("band" not in cols and "platform" not in cols):
        return []
    kind = "game" if "platform" in cols else "cd"

    def get(row, field):
        i = cols.get(field)
        v = row[i] if i is not None and i < len(row) else None
        return v.strip() if isinstance(v, str) else v

    out = []
    for row in rows:
        titel = get(row, "titel")
        group = get(row, "platform" if kind == "game" else "band")
        if titel in (None, "") or group in (None, ""):
            continue
        jaar = get(row, "jaar")
        try:
            jaar = int(jaar) if jaar not in (None, "") else None
        except (TypeError, ValueError):
            jaar = None
        prijs = get(row, "prijs")
        try:
            prijs = round(float(str(prijs).replace(",", ".")), 2) if prijs not in (None, "") else None
        except (TypeError, ValueError):
            prijs = None
        status, bron = map_status(get(row, "status"))
        out.append({
            "type": kind, "titel": str(titel), "jaar": jaar, "status": status, "prijs": prijs,
            "band": str(group) if kind == "cd" else None,
            "platform": str(group) if kind == "game" else None,
            "bron": get(row, "bron") or bron,
            "uitgave": get(row, "uitgave"),
            "notitie": get(row, "notitie"),
        })
    return out


@app.post("/api/import")
async def import_excel(file: UploadFile = File(...), mode: str = Form("merge")):
    wb = openpyxl.load_workbook(io.BytesIO(await file.read()), data_only=True)
    items = [it for ws in wb.worksheets for it in parse_sheet(ws)]
    if not items:
        raise HTTPException(400, "Geen bruikbare rijen gevonden. Nodig: Titel/Album plus Band (CD's) of Platform (games).")
    kinds = {it["type"] for it in items}
    added = updated = 0
    with db() as c:
        if mode == "replace":  # alleen de soorten die in dit bestand zitten vervangen
            for k in kinds:
                c.execute("DELETE FROM items WHERE type=?", (k,))
        key = lambda t, g, ti: (t, (g or "").lower(), ti.lower())
        existing = {key(r["type"], r["band"] or r["platform"], r["titel"]): r["id"]
                    for r in c.execute("SELECT id, type, band, platform, titel FROM items")}
        t = now()
        for it in items:
            k = key(it["type"], it["band"] or it["platform"], it["titel"])
            if k in existing:
                c.execute(
                    "UPDATE items SET jaar=COALESCE(:jaar, jaar), status=:status, prijs=COALESCE(:prijs, prijs),"
                    " bron=COALESCE(:bron, bron), uitgave=COALESCE(:uitgave, uitgave), gewijzigd=:t WHERE id=:id",
                    {**it, "t": t, "id": existing[k]},
                )
                updated += 1
            else:
                cur = c.execute(
                    "INSERT INTO items (type, titel, band, platform, jaar, status, prijs, bron, uitgave, notitie,"
                    " toegevoegd, gewijzigd) VALUES (:type, :titel, :band, :platform, :jaar, :status, :prijs,"
                    " :bron, :uitgave, :notitie, :t, :t)",
                    {**it, "t": t},
                )
                existing[k] = cur.lastrowid
                added += 1
    return {"toegevoegd": added, "bijgewerkt": updated, "totaal": len(items)}


@app.get("/api/export")
def export_excel():
    items = list_items()
    wb = openpyxl.Workbook()
    sheets = [
        ("CD's", "cd", ["Band", "Jaar", "Album", "Status", "Prijs", "Bron", "Uitgave", "Notitie"],
         lambda r: [r["band"], r["jaar"], r["titel"]], (24, 8, 36)),
        ("Games", "game", ["Platform", "Jaar", "Titel", "Status", "Prijs", "Bron", "Uitgave", "Notitie"],
         lambda r: [r["platform"], r["jaar"], r["titel"]], (18, 8, 40)),
    ]
    first = True
    for title, kind, header, head_cols, widths in sheets:
        ws = wb.active if first else wb.create_sheet()
        first = False
        ws.title = title
        ws.append(header)
        rows = sorted((r for r in items if r["type"] == kind),
                      key=lambda r: ((r["band"] or r["platform"] or "").lower(), r["jaar"] or 9999, r["titel"].lower()))
        for r in rows:
            ws.append(head_cols(r) + [STATUS_LABEL.get(r["status"], r["status"]), r["prijs"], r["bron"],
                                      r["uitgave"], r["notitie"]])
        for col, w in zip("ABCDEFGH", widths + (12, 10, 14, 18, 40)):
            ws.column_dimensions[col].width = w
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    name = f"hebbes-{datetime.now().strftime('%Y-%m-%d')}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


# ---------- Hoezen ----------
# CD's: MusicBrainz + Cover Art Archive. Games: Wikipedia (paginafoto van het artikel over de game).

UA = "Hebbes/2.0 (self-hosted wishlist)"
_lock = threading.Lock()
_last = [0.0]


def _get(url: str, timeout=10, accept="application/json") -> tuple[bytes, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.headers.get_content_type()


def _throttled_json(url: str) -> dict:
    with _lock:  # MusicBrainz/Wikipedia netjes behandelen: max ~1 verzoek per seconde
        wait = 1.1 - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        try:
            return json.loads(_get(url)[0])
        finally:
            _last[0] = time.time()


def _lucene(s: str) -> str:
    return re.sub(r'([+\-!(){}\[\]^"~*?:\\/]|&&|\|\|)', r"\\\1", s)


def cover_cd(band: str, titel: str):
    q = f'releasegroup:"{_lucene(titel)}" AND artist:"{_lucene(band)}"'
    res = _throttled_json("https://musicbrainz.org/ws/2/release-group/?" +
                          urllib.parse.urlencode({"query": q, "fmt": "json", "limit": 3}))
    for rg in res.get("release-groups", []):
        if rg.get("score", 0) < 80:
            continue
        try:
            return _get(f"https://coverartarchive.org/release-group/{rg['id']}/front-250", 15, "image/*")
        except Exception:
            continue
    return None


def cover_game(titel: str, platform: str):
    for query in (f"{titel} {platform} video game", f"{titel} video game"):
        res = _throttled_json("https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode({
            "action": "query", "format": "json", "generator": "search", "gsrsearch": query,
            "gsrlimit": 1, "prop": "pageimages", "piprop": "thumbnail", "pithumbsize": 300, "pilicense": "any",
        }))
        for page in res.get("query", {}).get("pages", {}).values():
            src = page.get("thumbnail", {}).get("source")
            if src:
                return _get(src, 15, "image/*")
    return None


EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}


def save_cover(c, iid: int, data: bytes, ctype: str, prefix: str) -> str:
    old = c.execute("SELECT cover FROM items WHERE id=?", (iid,)).fetchone()
    if old and old["cover"]:
        (COVER_DIR / old["cover"]).unlink(missing_ok=True)
    fname = f"{prefix}{iid}-{int(time.time())}{EXT.get(ctype, '.jpg')}"
    (COVER_DIR / fname).write_bytes(data)
    c.execute("UPDATE items SET cover=? WHERE id=?", (fname, iid))
    return fname


def serve(fname: str):
    p = COVER_DIR / fname
    return FileResponse(p, media_type=mimetypes.guess_type(p.name)[0] or "image/jpeg",
                        headers={"Cache-Control": "max-age=86400"})


@app.get("/api/cover/{iid}")
def cover(iid: int):
    with db() as c:
        row = get_item(c, iid)
    if row["cover"] and (COVER_DIR / row["cover"]).exists():
        return serve(row["cover"])
    if row["cover"] == "" or not COVERS_ENABLED:
        return Response(status_code=404)
    try:
        found = cover_cd(row["band"], row["titel"]) if row["type"] == "cd" else cover_game(row["titel"], row["platform"])
    except Exception:
        return Response(status_code=404)  # netwerkfout: later opnieuw proberen
    with db() as c:
        if not found:
            c.execute("UPDATE items SET cover='' WHERE id=?", (iid,))
            return Response(status_code=404)
        fname = save_cover(c, iid, found[0], found[1], "a")
    return serve(fname)


@app.post("/api/cover/{iid}")
async def cover_upload(iid: int, file: UploadFile = File(...)):
    ctype = file.content_type or ""
    if ctype not in EXT:
        raise HTTPException(400, "Alleen JPG, PNG, WebP of GIF")
    data = await file.read()
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(400, "Afbeelding is groter dan 5 MB")
    with db() as c:
        get_item(c, iid)
        save_cover(c, iid, data, ctype, "u")
    return {"ok": True}


@app.post("/api/cover/{iid}/reset")
def cover_reset(iid: int):
    with db() as c:
        row = get_item(c, iid)
        if row["cover"]:
            (COVER_DIR / row["cover"]).unlink(missing_ok=True)
        c.execute("UPDATE items SET cover=NULL WHERE id=?", (iid,))
    return {"ok": True}


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
