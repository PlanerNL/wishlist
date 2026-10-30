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
const TYPES = [
  { id: "cd", label: "CD's", one: "CD", group: "band", groupLabel: "Band", groupsTitle: "Bands", titleLabel: "Album" },
  { id: "game", label: "Games", one: "Game", group: "platform", groupLabel: "Platform", groupsTitle: "Platformen", titleLabel: "Titel" },
];
const TYPE = Object.fromEntries(TYPES.map(t => [t.id, t]));
const PLATFORMS = [
  "PC", "PlayStation 5", "PlayStation 4", "PlayStation 3", "PlayStation 2", "PlayStation", "PSP", "PS Vita",
  "Xbox Series X|S", "Xbox One", "Xbox 360", "Xbox", "Nintendo Switch 2", "Nintendo Switch", "Wii U", "Wii",
  "GameCube", "Nintendo 64", "SNES", "NES", "Nintendo 3DS", "Nintendo DS", "Game Boy Advance", "Game Boy Color",
  "Game Boy", "Sega Dreamcast", "Sega Saturn", "Sega Mega Drive", "Sega Master System",
];

const ICON = {
  cd: s => `<svg width="${s}" height="${s}" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="9" fill="none" stroke="rgba(255,255,255,.75)" stroke-width="1.2"/><circle cx="11" cy="11" r="2.5" fill="rgba(255,255,255,.75)"/></svg>`,
  game: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.8)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8h12a4 4 0 0 1 3.9 4.9l-.9 4a2.5 2.5 0 0 1-4.4 1L15 16H9l-1.6 1.9a2.5 2.5 0 0 1-4.4-1l-.9-4A4 4 0 0 1 6 8z"/><path d="M8 11v3M6.5 12.5h3"/><circle cx="15.5" cy="12" r=".6" fill="rgba(255,255,255,.8)"/><circle cx="17.5" cy="13.5" r=".6" fill="rgba(255,255,255,.8)"/></svg>`,
};

const state = { items: [], type: "cd", view: "wishlist", group: null, q: "", sort: "group", selected: null, draft: null };
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const euro = n => n == null ? "—" : "€ " + Number(n).toFixed(2).replace(".", ",");
const collator = new Intl.Collator("nl", { sensitivity: "base", numeric: true });
const groupOf = a => a.type === "cd" ? a.band : a.platform;

function hue(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}
function coverHTML(a, big) {
  const bg = `hsl(${hue((groupOf(a) || "") + a.titel)} 28% 38%)`;
  const img = a.id && a.cover !== ""
    ? `<div style="position:absolute;inset:0"><img src="api/cover/${a.id}?v=${encodeURIComponent(a.cover || "")}" alt="" loading="lazy" onerror="this.remove()"></div>`
    : "";
  return `<div class="${big ? "bigcover" : "cover"}" style="background:${bg};position:relative">${ICON[a.type](big ? 72 : 22)}${img}</div>`;
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
  state.items = await api("api/items");
  render();
}

// Items van de gekozen soort (of alles), zonder status-/groepfilter
const ofType = () => state.items.filter(a => state.type === "alles" || a.type === state.type);

function visible() {
  const v = VIEWS.find(v => v.id === state.view);
  const q = state.q.trim().toLowerCase();
  const list = ofType().filter(a =>
    v.test(a) &&
    (!state.group || groupOf(a) === state.group) &&
    (!q || [a.titel, a.band, a.platform, a.notitie, a.uitgave].some(x => (x || "").toLowerCase().includes(q))));
  const by = {
    group: (a, b) => collator.compare(groupOf(a), groupOf(b)) || (a.jaar ?? 9999) - (b.jaar ?? 9999) || collator.compare(a.titel, b.titel),
    jaar: (a, b) => (a.jaar ?? 9999) - (b.jaar ?? 9999) || collator.compare(a.titel, b.titel),
    titel: (a, b) => collator.compare(a.titel, b.titel),
    prijs: (a, b) => (a.prijs ?? Infinity) - (b.prijs ?? Infinity),
    recent: (a, b) => (b.gewijzigd || "").localeCompare(a.gewijzigd || ""),
  }[state.sort];
  return list.sort(by);
}

function renderTabs() {
  const tabs = [...TYPES, { id: "alles", label: "Alles" }];
  $("#typeTabs").innerHTML = tabs.map(t => {
    const n = state.items.filter(a => (t.id === "alles" || a.type === t.id) && a.status !== "in_bezit").length;
    return `<button type="button" data-type="${t.id}" class="${state.type === t.id ? "on" : ""}" aria-pressed="${state.type === t.id}">${t.label}<span class="count">${n}</span></button>`;
  }).join("");
}

function renderFilters() {
  const base = ofType();
  $("#statusList").innerHTML = VIEWS.map(v => {
    const n = base.filter(a => v.test(a) && (!state.group || groupOf(a) === state.group)).length;
    return `<button type="button" class="navbtn ${state.view === v.id ? "on" : ""}" data-view="${v.id}">${v.label}<span class="count">${n}</span></button>`;
  }).join("");

  const t = TYPE[state.type];
  $("#groupSection").hidden = !t;
  if (!t) return;
  $("#groupTitle").textContent = t.groupsTitle;
  const groups = new Map();
  for (const a of base) {
    const g = groups.get(groupOf(a)) || { total: 0, owned: 0 };
    g.total++;
    if (a.status === "in_bezit") g.owned++;
    groups.set(groupOf(a), g);
  }
  const names = [...groups.keys()].sort(collator.compare);
  $("#groupList").innerHTML =
    `<button type="button" class="navbtn ${!state.group ? "on" : ""}" data-group="">Alle ${t.groupsTitle.toLowerCase()}<span class="count">${names.length}</span></button>` +
    names.map(n => {
      const g = groups.get(n);
      return `<button type="button" class="navbtn bandbtn ${state.group === n ? "on" : ""}" data-group="${esc(n)}" aria-label="${esc(n)}, ${g.owned} van ${g.total} in bezit">
        <span class="top"><span>${esc(n)}</span><span class="count">${g.owned}/${g.total}</span></span>
        <span class="bar"><i style="width:${Math.round(100 * g.owned / g.total)}%"></i></span></button>`;
    }).join("");
}

function renderTable() {
  const list = visible();
  const v = VIEWS.find(v => v.id === state.view);
  const t = TYPE[state.type];
  $("#title").textContent = (state.group ? state.group + " — " : "") + v.label + (t ? ` · ${t.label}` : "");
  const owned = list.filter(a => a.status === "in_bezit");
  const spotted = list.filter(a => a.status === "gespot" || a.status === "besteld");
  const sum = arr => arr.reduce((s, a) => s + (a.prijs || 0), 0);
  const parts = [`${list.length} items`];
  if (owned.length) parts.push(`${owned.length} in bezit, ${euro(sum(owned))} besteed`);
  if (spotted.length) parts.push(`${spotted.length} gespot/besteld, ${euro(sum(spotted))}`);
  $("#stats").textContent = parts.join(" · ");

  $("#rows").innerHTML = list.map(a => {
    const sub = (state.type === "alles" ? TYPE[a.type].one + " · " : "") + (groupOf(a) || "") + (a.uitgave && a.type === "game" ? " · " + a.uitgave : "");
    return `
    <tr data-id="${a.id}" tabindex="0" class="${state.selected === a.id ? "sel" : ""}">
      <td><div class="albumcell">${coverHTML(a)}<div><b>${esc(a.titel)}</b><small>${esc(sub)}</small></div></div></td>
      <td class="num">${a.jaar ?? "—"}</td>
      <td class="num">${euro(a.prijs)}</td>
      <td><span class="badge s-${a.status}">${LABEL[a.status]}${a.bron && a.status !== "in_bezit" ? " · " + esc(a.bron) : ""}</span></td>
    </tr>`;
  }).join("");
  $("#empty").hidden = list.length > 0;
}

function renderDatalists() {
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort(collator.compare);
  $("#bandsDl").innerHTML = uniq(state.items.map(a => a.band)).map(b => `<option value="${esc(b)}">`).join("");
  const used = uniq(state.items.map(a => a.platform));
  $("#platformsDl").innerHTML = [...used, ...PLATFORMS.filter(p => !used.includes(p))].map(p => `<option value="${esc(p)}">`).join("");
}

function renderDetail() {
  const el = $("#detail");
  const a = state.draft;
  if (!a) {
    el.innerHTML = `<p class="placeholder">Kies een CD of game om te bekijken of te bewerken.</p>`;
    return;
  }
  const t = TYPE[a.type];
  el.innerHTML = `
    ${a.id ? `${coverHTML(a, true)}
      <div class="coveractions">
        <button type="button" class="btn light" id="btnRecover">Hoes opnieuw zoeken</button>
        <label class="btn light filebtn">Eigen afbeelding<input type="file" id="coverFile" accept="image/jpeg,image/png,image/webp,image/gif"></label>
      </div>` : ""}
    <form id="itemForm" style="display:flex;flex-direction:column;gap:12px">
      <h2 style="margin:0;font-size:20px">${a.id ? `${t.one} bewerken` : `Nieuwe ${a.type === "cd" ? "CD" : "game"}`}</h2>
      ${a.id ? "" : `<div class="seg" role="group" aria-label="Soort">${TYPES.map(x => `<button type="button" data-settype="${x.id}" class="${a.type === x.id ? "on" : ""}" aria-pressed="${a.type === x.id}">${x.one}</button>`).join("")}</div>`}
      <label class="field">${t.groupLabel}<input type="text" name="group" list="${a.type === "cd" ? "bandsDl" : "platformsDl"}" required value="${esc(groupOf(a))}"></label>
      <label class="field">${t.titleLabel}<input type="text" name="titel" required value="${esc(a.titel)}"></label>
      <div class="grid2">
        <label class="field">Jaar<input type="number" name="jaar" min="1900" max="2100" value="${a.jaar ?? ""}"></label>
        <label class="field">Prijs (€)<input type="number" name="prijs" step="0.01" min="0" value="${a.prijs ?? ""}"></label>
      </div>
      <div class="field" role="group" aria-label="Status">Status
        <div class="seg">${STATUS.map(s => `<button type="button" data-status="${s.id}" class="${a.status === s.id ? "on" : ""}" aria-pressed="${a.status === s.id}">${s.label}</button>`).join("")}</div>
      </div>
      <div class="grid2">
        <label class="field">Bron / winkel<input type="text" name="bron" value="${esc(a.bron)}" placeholder="bijv. Vinted"></label>
        <label class="field">Uitgave<input type="text" name="uitgave" value="${esc(a.uitgave)}" placeholder="${a.type === "cd" ? "bijv. digipak" : "bijv. CIB, Steam"}"></label>
      </div>
      <label class="field">Notitie<textarea name="notitie">${esc(a.notitie)}</textarea></label>
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
  renderTabs();
  renderFilters();
  renderTable();
  renderDatalists();
}

function select(id) {
  state.selected = id;
  const a = state.items.find(x => x.id === id);
  state.draft = a ? { ...a } : null;
  renderTable();
  renderDetail();
  if (window.innerWidth <= 760) $("#detail").scrollIntoView({ behavior: "smooth" });
}

// Formulierwaarden in de draft bewaren (zodat wisselen van soort niets wist)
function syncDraft() {
  const f = $("#itemForm");
  if (!f) return;
  const num = v => v === "" ? null : Number(v);
  const d = state.draft;
  d.titel = f.titel.value;
  if (d.type === "cd") d.band = f.group.value; else d.platform = f.group.value;
  d.jaar = num(f.jaar.value);
  d.prijs = num(f.prijs.value);
  d.bron = f.bron.value || null;
  d.uitgave = f.uitgave.value || null;
  d.notitie = f.notitie.value || null;
}

function payload() {
  syncDraft();
  const d = state.draft;
  return {
    type: d.type, titel: d.titel, band: d.type === "cd" ? d.band : null, platform: d.type === "game" ? d.platform : null,
    jaar: d.jaar, prijs: d.prijs, status: d.status, bron: d.bron, uitgave: d.uitgave, notitie: d.notitie,
  };
}

function refreshCover(msg) {
  const a = state.items.find(x => x.id === state.draft.id);
  const box = document.querySelector("#detail .bigcover");
  if (!a || !box) return;
  box.querySelectorAll("div").forEach(d => d.remove());
  const img = new Image();
  img.alt = "";
  img.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover";
  img.onload = () => { $("#formMsg").textContent = ""; };
  img.onerror = () => { $("#formMsg").textContent = "Geen hoes gevonden. Je kunt zelf een afbeelding kiezen."; img.remove(); };
  img.src = `api/cover/${a.id}?t=${Date.now()}`;
  box.appendChild(img);
  $("#formMsg").textContent = msg;
}

// ---------- events ----------
$("#typeTabs").addEventListener("click", e => {
  const b = e.target.closest("[data-type]");
  if (!b) return;
  state.type = b.dataset.type;
  state.group = null;
  render();
});
$("#statusList").addEventListener("click", e => {
  const b = e.target.closest("[data-view]");
  if (b) { state.view = b.dataset.view; render(); }
});
$("#groupList").addEventListener("click", e => {
  const b = e.target.closest("[data-group]");
  if (b) { state.group = b.dataset.group || null; render(); }
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
  const type = state.type === "alles" ? "cd" : state.type;
  state.selected = null;
  state.draft = {
    type, titel: "", band: type === "cd" ? state.group || "" : null, platform: type === "game" ? state.group || "" : null,
    jaar: null, prijs: null, status: "gezocht", bron: null, uitgave: null, notitie: null,
  };
  renderTable();
  renderDetail();
  $("#itemForm").group.focus();
});

$("#detail").addEventListener("click", async e => {
  const typeBtn = e.target.closest("[data-settype]");
  if (typeBtn) {
    syncDraft();
    state.draft.type = typeBtn.dataset.settype;
    renderDetail();
    return;
  }
  const seg = e.target.closest("[data-status]");
  if (seg) {
    state.draft.status = seg.dataset.status;
    document.querySelectorAll("[data-status]").forEach(b => {
      const on = b.dataset.status === state.draft.status;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on);
    });
    return;
  }
  if (e.target.id === "btnCancel") { state.draft = null; renderDetail(); }
  if (e.target.id === "btnDelete") {
    if (!confirm(`"${state.draft.titel}" verwijderen?`)) return;
    await api(`api/items/${state.draft.id}`, { method: "DELETE" });
    state.selected = null; state.draft = null;
    await load(); renderDetail();
  }
  if (e.target.id === "btnRecover") {
    await api(`api/cover/${state.draft.id}/reset`, { method: "POST" });
    await load();
    refreshCover("Hoes wordt gezocht…");
  }
});

$("#detail").addEventListener("change", async e => {
  if (e.target.id !== "coverFile" || !e.target.files[0]) return;
  const fd = new FormData();
  fd.append("file", e.target.files[0]);
  try {
    await api(`api/cover/${state.draft.id}`, { method: "POST", body: fd });
    await load();
    refreshCover("");
  } catch (err) {
    $("#formMsg").textContent = "Fout: " + err.message;
  }
});

$("#detail").addEventListener("submit", async e => {
  e.preventDefault();
  const data = payload();
  try {
    const saved = state.draft.id
      ? await api(`api/items/${state.draft.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
      : await api("api/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
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
  if (f.mode.value === "replace" && !confirm("Bestaande items van dezelfde soort worden vervangen. Doorgaan?")) return;
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
