"""CD Wishlist — kleine self-hosted webapp voor je CD-collectie en wishlist."""
import io
import json
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
from fastapi import FastAPI, File, HTTPException, UploadFile, Form
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
DB_PATH = DATA_DIR / "wishlist.db"
COVER_DIR = DATA_DIR / "covers"
STATIC_DIR = Path(__file__).parent / "static"
COVERS_ENABLED = os.environ.get("COVERS", "1") != "0"

STATUSES = ["gezocht", "gespot", "besteld", "in_bezit"]

DATA_DIR.mkdir(parents=True, exist_ok=True)
COVER_DIR.mkdir(parents=True, exist_ok=True)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


with db() as c:
    c.execute(
        """CREATE TABLE IF NOT EXISTS albums (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            band TEXT NOT NULL,
            album TEXT NOT NULL,
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


class AlbumIn(BaseModel):
    band: str
    album: str
    jaar: Optional[int] = None
    status: str = "gezocht"
    prijs: Optional[float] = None
    bron: Optional[str] = None
    uitgave: Optional[str] = None
    notitie: Optional[str] = None


def clean(a: AlbumIn) -> dict:
    d = a.model_dump()
    d["band"] = d["band"].strip()
    d["album"] = d["album"].strip()
    if not d["band"] or not d["album"]:
        raise HTTPException(400, "Band en album zijn verplicht")
    if d["status"] not in STATUSES:
        raise HTTPException(400, f"Onbekende status: {d['status']}")
    for k in ("bron", "uitgave", "notitie"):
        if d[k] is not None:
            d[k] = d[k].strip() or None
    return d


app = FastAPI(title="CD Wishlist")


@app.get("/api/albums")
def list_albums():
    with db() as c:
        rows = c.execute("SELECT * FROM albums ORDER BY band COLLATE NOCASE, jaar, album").fetchall()
    return [dict(r) for r in rows]


@app.post("/api/albums")
def create_album(a: AlbumIn):
    d = clean(a)
    with db() as c:
        cur = c.execute(
            "INSERT INTO albums (band, album, jaar, status, prijs, bron, uitgave, notitie, toegevoegd, gewijzigd)"
            " VALUES (:band, :album, :jaar, :status, :prijs, :bron, :uitgave, :notitie, :t, :t)",
            {**d, "t": now()},
        )
        row = c.execute("SELECT * FROM albums WHERE id=?", (cur.lastrowid,)).fetchone()
    return dict(row)


@app.put("/api/albums/{aid}")
def update_album(aid: int, a: AlbumIn):
    d = clean(a)
    with db() as c:
        old = c.execute("SELECT * FROM albums WHERE id=?", (aid,)).fetchone()
        if not old:
            raise HTTPException(404, "Niet gevonden")
        # Andere band/album → hoes opnieuw zoeken
        reset_cover = old["band"] != d["band"] or old["album"] != d["album"]
        c.execute(
            "UPDATE albums SET band=:band, album=:album, jaar=:jaar, status=:status, prijs=:prijs, bron=:bron,"
            " uitgave=:uitgave, notitie=:notitie, gewijzigd=:t" + (", cover=NULL" if reset_cover else "") +
            " WHERE id=:id",
            {**d, "t": now(), "id": aid},
        )
        row = c.execute("SELECT * FROM albums WHERE id=?", (aid,)).fetchone()
    return dict(row)


@app.delete("/api/albums/{aid}")
def delete_album(aid: int):
    with db() as c:
        c.execute("DELETE FROM albums WHERE id=?", (aid,))
    return {"ok": True}


# ---------- Excel import / export ----------

HEADER_ALIASES = {
    "band": {"band", "artiest", "artist"},
    "album": {"album", "titel", "title"},
    "jaar": {"year", "jaar"},
    "prijs": {"prijs", "price"},
    "status": {"column1", "status"},
    "bron": {"bron", "winkel", "source"},
    "notitie": {"notitie", "notes", "opmerking"},
}


def map_status(raw) -> tuple[str, Optional[str]]:
    """Eerste kolom van de oude Excel: 'Check' = in bezit, 'Vinted' = gespot op Vinted."""
    s = str(raw or "").strip().lower()
    if not s:
        return "gezocht", None
    if s in ("check", "in_bezit", "in bezit", "gekocht"):
        return "in_bezit", None
    if s in STATUSES:
        return s, None
    # Iets anders (bijv. 'Vinted'): een gevonden aanbod bij die bron
    return "gespot", str(raw).strip()


def parse_excel(data: bytes) -> list[dict]:
    wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True)
    ws = wb.active
    rows = ws.iter_rows(values_only=True)
    header = next(rows, None)
    if not header:
        raise HTTPException(400, "Leeg bestand")
    cols = {}
    for i, h in enumerate(header):
        key = str(h or "").strip().lower()
        for field, names in HEADER_ALIASES.items():
            if key in names and field not in cols:
                cols[field] = i
    if "band" not in cols or "album" not in cols:
        raise HTTPException(400, "Kolommen 'Band' en 'Album' niet gevonden in de eerste rij")

    def get(row, field):
        i = cols.get(field)
        return row[i] if i is not None and i < len(row) else None

    out = []
    for row in rows:
        band, album = get(row, "band"), get(row, "album")
        if band is None or album is None or not str(band).strip() or not str(album).strip():
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
        bron = get(row, "bron") or bron
        out.append({
            "band": str(band).strip(), "album": str(album).strip(), "jaar": jaar,
            "status": status, "prijs": prijs, "bron": bron,
            "notitie": (str(get(row, "notitie")).strip() if get(row, "notitie") else None),
        })
    return out


@app.post("/api/import")
async def import_excel(file: UploadFile = File(...), mode: str = Form("merge")):
    items = parse_excel(await file.read())
    added = updated = 0
    with db() as c:
        if mode == "replace":
            c.execute("DELETE FROM albums")
        existing = {
            (r["band"].lower(), r["album"].lower()): r["id"]
            for r in c.execute("SELECT id, band, album FROM albums")
        }
        t = now()
        for it in items:
            key = (it["band"].lower(), it["album"].lower())
            if key in existing:
                c.execute(
                    "UPDATE albums SET jaar=COALESCE(:jaar, jaar), status=:status, prijs=COALESCE(:prijs, prijs),"
                    " bron=COALESCE(:bron, bron), gewijzigd=:t WHERE id=:id",
                    {**it, "t": t, "id": existing[key]},
                )
                updated += 1
            else:
                cur = c.execute(
                    "INSERT INTO albums (band, album, jaar, status, prijs, bron, notitie, toegevoegd, gewijzigd)"
                    " VALUES (:band, :album, :jaar, :status, :prijs, :bron, :notitie, :t, :t)",
                    {**it, "t": t},
                )
                existing[key] = cur.lastrowid
                added += 1
    return {"toegevoegd": added, "bijgewerkt": updated, "totaal": len(items)}


STATUS_LABEL = {"gezocht": "Gezocht", "gespot": "Gespot", "besteld": "Besteld", "in_bezit": "In bezit"}


@app.get("/api/export")
def export_excel():
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "CD Wishlist"
    ws.append(["Band", "Jaar", "Album", "Status", "Prijs", "Bron", "Uitgave", "Notitie"])
    for r in list_albums():
        ws.append([r["band"], r["jaar"], r["album"], STATUS_LABEL.get(r["status"], r["status"]),
                   r["prijs"], r["bron"], r["uitgave"], r["notitie"]])
    for col, w in zip("ABCDEFGH", (24, 8, 36, 12, 10, 14, 16, 40)):
        ws.column_dimensions[col].width = w
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    name = f"cd-wishlist-{datetime.now().strftime('%Y-%m-%d')}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


# ---------- Hoezen via MusicBrainz + Cover Art Archive ----------

UA = "CDWishlist/1.0 (self-hosted)"
_mb_lock = threading.Lock()
_mb_last = [0.0]


def _get(url: str, timeout=10) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _lucene(s: str) -> str:
    return re.sub(r'([+\-!(){}\[\]^"~*?:\\/]|&&|\|\|)', r"\\\1", s)


def fetch_cover(band: str, album: str) -> Optional[bytes]:
    q = f'releasegroup:"{_lucene(album)}" AND artist:"{_lucene(band)}"'
    url = "https://musicbrainz.org/ws/2/release-group/?" + urllib.parse.urlencode(
        {"query": q, "fmt": "json", "limit": 3})
    with _mb_lock:  # MusicBrainz: max 1 verzoek per seconde
        wait = 1.1 - (time.time() - _mb_last[0])
        if wait > 0:
            time.sleep(wait)
        try:
            res = json.loads(_get(url))
        finally:
            _mb_last[0] = time.time()
    for rg in res.get("release-groups", []):
        if rg.get("score", 0) < 80:
            continue
        try:
            return _get(f"https://coverartarchive.org/release-group/{rg['id']}/front-250", timeout=15)
        except Exception:
            continue
    return None


@app.get("/api/cover/{aid}")
def cover(aid: int):
    with db() as c:
        row = c.execute("SELECT band, album, cover FROM albums WHERE id=?", (aid,)).fetchone()
    if not row:
        raise HTTPException(404)
    if row["cover"]:
        p = COVER_DIR / row["cover"]
        if p.exists():
            return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
    if row["cover"] == "" or not COVERS_ENABLED:
        return Response(status_code=404)
    try:
        img = fetch_cover(row["band"], row["album"])
    except Exception:
        return Response(status_code=404)  # netwerkfout: later opnieuw proberen
    fname = f"{aid}.jpg" if img else ""
    if img:
        (COVER_DIR / fname).write_bytes(img)
    with db() as c:
        c.execute("UPDATE albums SET cover=? WHERE id=?", (fname, aid))
    if not img:
        return Response(status_code=404)
    return FileResponse(COVER_DIR / fname, media_type="image/jpeg")


@app.post("/api/cover/{aid}/reset")
def cover_reset(aid: int):
    with db() as c:
        c.execute("UPDATE albums SET cover=NULL WHERE id=?", (aid,))
    p = COVER_DIR / f"{aid}.jpg"
    if p.exists():
        p.unlink()
    return {"ok": True}


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
