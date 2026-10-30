"use strict";

const STATUS = [
  { id: "gezocht", label: "Gezocht" },
  { id: "gespot", label: "Gespot" },
  { id: "besteld", label: "Besteld" },
  { id: "in_bezit", label: "In bezit" },
];
const LABEL = Object.fromEntries(STATUS.map(s => [s.id, s.label]));
const VIEWS = [
  { id: "wishlist", label: "Wishlist", test: a => a.status !== "in_bezit" },
  ...STATUS.map(s => ({ id: s.id, label: s.label, test: a => a.status === s.id })),
  { id: "alles", label: "Alles", test: () => true },
];

const state = { albums: [], view: "wishlist", band: null, q: "", sort: "band", selected: null, draft: null };
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const euro = n => n == null ? "—" : "€ " + Number(n).toFixed(2).replace(".", ",");
const collator = new Intl.Collator("nl", { sensitivity: "base", numeric: true });

function hue(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}
function coverHTML(a, big) {
  const size = big ? 120 : 22;
  const bg = `hsl(${hue(a.band + a.album)} 28% 38%)`;
  const disc = `<svg width="${size}" height="${size}" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="9" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="1.2"/><circle cx="11" cy="11" r="2.5" fill="rgba(255,255,255,.7)"/></svg>`;
  const img = a.id && a.cover !== "" ? `<img src="api/cover/${a.id}" alt="" loading="lazy" onerror="this.remove()">` : "";
  return `<div class="${big ? "bigcover" : "cover"}" style="background:${bg};position:relative">${disc}${img ? `<div style="position:absolute;inset:0">${img}</div>` : ""}</div>`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

async function load() {
  state.albums = await api("api/albums");
  render();
}

function visible() {
  const v = VIEWS.find(v => v.id === state.view);
  const q = state.q.trim().toLowerCase();
  let list = state.albums.filter(a =>
    v.test(a) &&
    (!state.band || a.band === state.band) &&
    (!q || a.band.toLowerCase().includes(q) || a.album.toLowerCase().includes(q) || (a.notitie || "").toLowerCase().includes(q)));
  const by = {
    band: (a, b) => collator.compare(a.band, b.band) || (a.jaar ?? 9999) - (b.jaar ?? 9999) || collator.compare(a.album, b.album),
    jaar: (a, b) => (a.jaar ?? 9999) - (b.jaar ?? 9999) || collator.compare(a.band, b.band),
    album: (a, b) => collator.compare(a.album, b.album),
    prijs: (a, b) => (a.prijs ?? Infinity) - (b.prijs ?? Infinity),
    recent: (a, b) => (b.gewijzigd || "").localeCompare(a.gewijzigd || ""),
  }[state.sort];
  return list.sort(by);
}

function renderFilters() {
  $("#statusList").innerHTML = VIEWS.map(v => {
    const n = state.albums.filter(a => v.test(a) && (!state.band || a.band === state.band)).length;
    return `<button type="button" class="navbtn ${state.view === v.id ? "on" : ""}" data-view="${v.id}">${v.label}<span class="count">${n}</span></button>`;
  }).join("");

  const bands = new Map();
  for (const a of state.albums) {
    const b = bands.get(a.band) || { total: 0, owned: 0 };
    b.total++;
    if (a.status === "in_bezit") b.owned++;
    bands.set(a.band, b);
  }
  const names = [...bands.keys()].sort(collator.compare);
  $("#bandList").innerHTML =
    `<button type="button" class="navbtn ${!state.band ? "on" : ""}" data-band="">Alle bands<span class="count">${names.length}</span></button>` +
    names.map(n => {
      const b = bands.get(n);
      return `<button type="button" class="navbtn bandbtn ${state.band === n ? "on" : ""}" data-band="${esc(n)}" aria-label="${esc(n)}, ${b.owned} van ${b.total} in bezit">
        <span class="top"><span>${esc(n)}</span><span class="count">${b.owned}/${b.total}</span></span>
        <span class="bar"><i style="width:${Math.round(100 * b.owned / b.total)}%"></i></span></button>`;
    }).join("");
}

function renderTable() {
  const list = visible();
  const v = VIEWS.find(v => v.id === state.view);
  $("#title").textContent = (state.band ? state.band + " — " : "") + v.label;
  const owned = list.filter(a => a.status === "in_bezit");
  const spent = owned.reduce((s, a) => s + (a.prijs || 0), 0);
  const spotted = list.filter(a => a.status === "gespot" || a.status === "besteld");
  const parts = [`${list.length} albums`];
  if (owned.length) parts.push(`${owned.length} in bezit, ${euro(spent)} besteed`);
  if (spotted.length) parts.push(`${spotted.length} gespot/besteld, ${euro(spotted.reduce((s, a) => s + (a.prijs || 0), 0))}`);
  $("#stats").textContent = parts.join(" · ");

  $("#rows").innerHTML = list.map(a => `
    <tr data-id="${a.id}" tabindex="0" class="${state.selected === a.id ? "sel" : ""}">
      <td><div class="albumcell">${coverHTML(a)}<div><b>${esc(a.album)}</b><small>${esc(a.band)}</small></div></div></td>
      <td class="num">${a.jaar ?? "—"}</td>
      <td class="num">${euro(a.prijs)}</td>
      <td><span class="badge s-${a.status}">${LABEL[a.status]}${a.bron && a.status !== "in_bezit" ? " · " + esc(a.bron) : ""}</span></td>
    </tr>`).join("");
  $("#empty").hidden = list.length > 0;
}

function renderDetail() {
  const el = $("#detail");
  const a = state.draft;
  if (!a) {
    el.innerHTML = `<p class="placeholder">Kies een album om het te bekijken of te bewerken.</p>`;
    return;
  }
  const bands = [...new Set(state.albums.map(x => x.band))].sort(collator.compare);
  el.innerHTML = `
    ${a.id ? coverHTML(a, true) : ""}
    <form id="albumForm" style="display:flex;flex-direction:column;gap:12px">
      <h2 style="margin:0;font-size:20px">${a.id ? "Album bewerken" : "Nieuw album"}</h2>
      <label class="field">Band<input type="text" name="band" list="bandsDl" required value="${esc(a.band)}"></label>
      <datalist id="bandsDl">${bands.map(b => `<option value="${esc(b)}">`).join("")}</datalist>
      <label class="field">Album<input type="text" name="album" required value="${esc(a.album)}"></label>
      <div class="grid2">
        <label class="field">Jaar<input type="number" name="jaar" min="1900" max="2100" value="${a.jaar ?? ""}"></label>
        <label class="field">Prijs (€)<input type="number" name="prijs" step="0.01" min="0" value="${a.prijs ?? ""}"></label>
      </div>
      <div class="field" role="group" aria-label="Status">Status
        <div class="seg">${STATUS.map(s => `<button type="button" data-status="${s.id}" class="${a.status === s.id ? "on" : ""}" aria-pressed="${a.status === s.id}">${s.label}</button>`).join("")}</div>
      </div>
      <div class="grid2">
        <label class="field">Bron / winkel<input type="text" name="bron" value="${esc(a.bron)}" placeholder="bijv. Vinted"></label>
        <label class="field">Uitgave<input type="text" name="uitgave" value="${esc(a.uitgave)}" placeholder="bijv. digipak"></label>
      </div>
      <label class="field">Notitie<textarea name="notitie">${esc(a.notitie)}</textarea></label>
      ${a.id ? `<button type="button" class="btn light" id="btnRecover" style="height:36px;font-size:14px;align-self:flex-start">Hoes opnieuw zoeken</button>` : ""}
      <div class="formactions">
        <p class="msg" id="formMsg" role="status"></p>
        <div class="row-between">
          ${a.id ? `<button type="button" class="btn danger" id="btnDelete">Verwijderen</button>` : `<button type="button" class="btn light" id="btnCancel">Annuleren</button>`}
          <button type="submit" class="btn primary">Opslaan</button>
        </div>
      </div>
    </form>`;
  el.scrollTop = 0;
}

function render() {
  renderFilters();
  renderTable();
}

function select(id) {
  state.selected = id;
  const a = state.albums.find(x => x.id === id);
  state.draft = a ? { ...a } : null;
  renderTable();
  renderDetail();
  if (window.innerWidth <= 760) $("#detail").scrollIntoView({ behavior: "smooth" });
}

function formData() {
  const f = $("#albumForm");
  const num = v => v === "" ? null : Number(v);
  return {
    band: f.band.value, album: f.album.value,
    jaar: num(f.jaar.value), prijs: num(f.prijs.value),
    status: state.draft.status,
    bron: f.bron.value || null, uitgave: f.uitgave.value || null, notitie: f.notitie.value || null,
  };
}

// ---------- events ----------
$("#statusList").addEventListener("click", e => {
  const b = e.target.closest("[data-view]");
  if (b) { state.view = b.dataset.view; render(); }
});
$("#bandList").addEventListener("click", e => {
  const b = e.target.closest("[data-band]");
  if (b) { state.band = b.dataset.band || null; render(); }
});
$("#q").addEventListener("input", e => { state.q = e.target.value; renderTable(); });
$("#sort").addEventListener("change", e => { state.sort = e.target.value; renderTable(); });
$("#rows").addEventListener("click", e => {
  const tr = e.target.closest("tr[data-id]");
  if (tr) select(Number(tr.dataset.id));
});
$("#rows").addEventListener("keydown", e => {
  const tr = e.target.closest("tr[data-id]");
  if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(Number(tr.dataset.id)); }
});
$("#btnAdd").addEventListener("click", () => {
  state.selected = null;
  state.draft = { band: state.band || "", album: "", jaar: null, prijs: null, status: "gezocht", bron: null, uitgave: null, notitie: null };
  renderTable();
  renderDetail();
  $("#albumForm").band.focus();
});

$("#detail").addEventListener("click", async e => {
  const seg = e.target.closest("[data-status]");
  if (seg) {
    state.draft.status = seg.dataset.status;
    document.querySelectorAll(".seg button").forEach(b => {
      const on = b.dataset.status === state.draft.status;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on);
    });
    return;
  }
  if (e.target.id === "btnCancel") { state.draft = null; renderDetail(); }
  if (e.target.id === "btnDelete") {
    if (!confirm(`"${state.draft.album}" van ${state.draft.band} verwijderen?`)) return;
    await api(`api/albums/${state.draft.id}`, { method: "DELETE" });
    state.selected = null; state.draft = null;
    await load(); renderDetail();
  }
  if (e.target.id === "btnRecover") {
    await api(`api/cover/${state.draft.id}/reset`, { method: "POST" });
    const a = state.albums.find(x => x.id === state.draft.id);
    a.cover = null;
    $("#formMsg").textContent = "Hoes wordt opnieuw gezocht…";
    // cache-buster zodat de browser niet de oude 404 hergebruikt
    document.querySelectorAll(`img[src^="api/cover/${a.id}"]`).forEach(i => i.remove());
    const box = document.querySelector("#detail .bigcover");
    if (box) {
      const img = new Image();
      img.alt = ""; img.onerror = () => { $("#formMsg").textContent = "Geen hoes gevonden."; img.remove(); };
      img.onload = () => { $("#formMsg").textContent = ""; };
      img.src = `api/cover/${a.id}?t=${Date.now()}`;
      img.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover";
      box.appendChild(img);
    }
  }
});

$("#detail").addEventListener("submit", async e => {
  e.preventDefault();
  const data = formData();
  try {
    const saved = state.draft.id
      ? await api(`api/albums/${state.draft.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
      : await api("api/albums", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    await load();
    select(saved.id);
    $("#formMsg").textContent = "Opgeslagen.";
  } catch (err) {
    $("#formMsg").textContent = "Fout: " + err.message;
  }
});

// ---------- import ----------
const dlg = $("#importDlg");
$("#btnImport").addEventListener("click", () => { $("#importMsg").textContent = ""; dlg.showModal(); });
$("#importCancel").addEventListener("click", () => dlg.close());
$("#importForm").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target;
  if (f.mode.value === "replace" && !confirm("Alle huidige albums worden vervangen. Doorgaan?")) return;
  const fd = new FormData();
  fd.append("file", f.file.files[0]);
  fd.append("mode", f.mode.value);
  $("#importMsg").textContent = "Bezig met importeren…";
  try {
    const r = await api("api/import", { method: "POST", body: fd });
    $("#importMsg").textContent = `Klaar: ${r.toegevoegd} toegevoegd, ${r.bijgewerkt} bijgewerkt.`;
    await load();
  } catch (err) {
    $("#importMsg").textContent = "Fout: " + err.message;
  }
});

load().catch(err => { $("#stats").textContent = "Kan de server niet bereiken: " + err.message; });
