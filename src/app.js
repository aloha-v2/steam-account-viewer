/* Steam Account Viewer — frontend
 * Работает и без Tauri: в браузере поднимается демо-режим с моками. */

const TAURI = window.__TAURI__;
const invoke = TAURI?.core?.invoke;
const DESKTOP = typeof invoke === "function";
const CONFIRM_WORD = "подтверждаю";

const S = {
  loading: true,
  error: null,
  steamPath: null,
  manual: false,
  accounts: [],
  query: "",
  sort: "date",
  open: null,
  target: null,
};

const $ = (s) => document.querySelector(s);
const listEl = $("#list");

/* ── helpers ─────────────────────────────── */
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function bytes(n) {
  if (!n) return "0 Б";
  const u = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  const v = n / 1024 ** i;
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function plural(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

function ago(ts) {
  if (!ts) return "неизвестно";
  const d = Math.floor((Date.now() / 1000 - ts) / 86400);
  if (d <= 0) return "сегодня";
  if (d === 1) return "вчера";
  if (d < 30) return `${d} ${plural(d, ["день", "дня", "дней"])} назад`;
  const m = Math.floor(d / 30);
  if (m < 12) return `${m} ${plural(m, ["месяц", "месяца", "месяцев"])} назад`;
  const y = Math.floor(d / 365);
  return `${y} ${plural(y, ["год", "года", "лет"])} назад`;
}

function fullDate(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("ru-RU", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function hue(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

function avatarHTML(a) {
  if (a.avatar) return `<img class="av" src="${a.avatar}" alt="" />`;
  const h = hue(a.steam_id || a.account_name);
  const letter = esc((a.persona_name || a.account_name || "?").trim().charAt(0).toUpperCase());
  return `<div class="av ph" style="background:linear-gradient(150deg, oklch(0.42 0.05 ${h}), oklch(0.28 0.035 ${(h + 40) % 360}))">${letter}</div>`;
}

/* ── data ────────────────────────────────── */
async function scan() {
  S.loading = true;
  S.error = null;
  render();
  try {
    const r = DESKTOP ? await invoke("scan") : await mockScan();
    S.steamPath = r.steam_path;
    S.manual = r.manual;
    S.accounts = r.accounts || [];
    S.error = r.error;
  } catch (e) {
    S.error = String(e);
    S.accounts = [];
  }
  S.loading = false;
  render();
}

function visible() {
  const q = S.query.trim().toLowerCase();
  let out = S.accounts.filter(
    (a) =>
      !q ||
      (a.persona_name || "").toLowerCase().includes(q) ||
      (a.account_name || "").toLowerCase().includes(q) ||
      (a.steam_id || "").includes(q)
  );
  const by = {
    date: (x, y) => (y.timestamp || 0) - (x.timestamp || 0),
    name: (x, y) => (x.persona_name || x.account_name).localeCompare(y.persona_name || y.account_name, "ru"),
    size: (x, y) => (y.total_bytes || 0) - (x.total_bytes || 0),
  }[S.sort];
  return out.sort(by);
}

/* ── render ──────────────────────────────── */
function render() {
  $("#path-text").textContent = S.steamPath || (S.loading ? "Поиск папки Steam…" : "Папка Steam не найдена");
  $("#path-src").hidden = !S.manual;

  if (S.loading) {
    listEl.innerHTML = Array.from({ length: 4 })
      .map(() => `<div class="sk"><div class="sk-b sk-av"></div><div class="sk-l"><span class="sk-b"></span><span class="sk-b"></span></div></div>`)
      .join("");
    $("#foot-count").textContent = "Сканирую…";
    return;
  }

  if (S.error) {
    listEl.innerHTML = `<div class="state"><h2>Не вышло прочитать данные Steam</h2><p>${esc(S.error)}</p><button class="btn primary" onclick="pickFolder()">Указать папку вручную</button></div>`;
    $("#foot-count").textContent = "—";
    return;
  }

  const rows = visible();
  if (!rows.length) {
    listEl.innerHTML = S.accounts.length
      ? `<div class="state"><h2>Ничего не нашлось</h2><p>Под запрос «${esc(S.query)}» не подходит ни один аккаунт.</p></div>`
      : `<div class="state"><h2>Записей входа нет</h2><p>В loginusers.vdf пусто: либо в Steam ни разу не заходили с этого компьютера, либо данные уже вычищены.</p></div>`;
  } else {
    listEl.innerHTML = rows.map(rowHTML).join("");
  }

  const total = S.accounts.reduce((s, a) => s + (a.total_bytes || 0), 0);
  $("#foot-count").textContent = `${S.accounts.length} ${plural(S.accounts.length, ["аккаунт", "аккаунта", "аккаунтов"])} · ${bytes(total)} локальных данных`;
}

function rowHTML(a) {
  const open = S.open === a.steam_id;
  const tags = [];
  if (a.auto_login) tags.push('<span class="tag on">автовход</span>');
  else if (a.most_recent) tags.push('<span class="tag">последний</span>');
  if (a.remember_password) tags.push('<span class="tag">пароль сохранён</span>');

  return `<article class="row${open ? " open" : ""}" data-id="${esc(a.steam_id)}">
    <div class="row-main" data-toggle>
      ${avatarHTML(a)}
      <div class="who">
        <b>${esc(a.persona_name || a.account_name)}</b>
        <small><span>${esc(a.account_name)}</span><span class="mono">${esc(a.steam_id)}</span></small>
      </div>
      <div class="tags">${tags.join("")}</div>
      <div class="meta"><b>${ago(a.timestamp)}</b><small>${bytes(a.total_bytes)}</small></div>
      <div class="row-act">
        <button class="icon-btn del" data-del title="Удалить локальные данные"><svg class="ic"><use href="#i-trash"/></svg></button>
        <span class="icon-btn chev"><svg class="ic"><use href="#i-chevron"/></svg></span>
      </div>
    </div>
    ${open ? detailHTML(a) : ""}
  </article>`;
}

function detailHTML(a) {
  const files = (a.artifacts || [])
    .map(
      (f) => `<li>
        <span class="lbl">${esc(f.label)}<span class="loc mono">${esc(f.path)}</span></span>
        <span class="sz">${f.exists ? bytes(f.bytes) : '<span class="missing">нет</span>'}</span>
      </li>`
    )
    .join("");
  return `<div class="detail">
    <h3>Последний вход · ${esc(fullDate(a.timestamp))}</h3>
    <ul class="files">${files}</ul>
  </div>`;
}

/* ── modal ───────────────────────────────── */
function openModal(a) {
  S.target = a;
  const el = $("#modal");
  $("#m-lead").innerHTML = `С компьютера пропадёт след того, что вы заходили в <b>${esc(a.persona_name || a.account_name)}</b> (<span class="mono">${esc(a.steam_id)}</span>).`;
  $("#m-artifacts").innerHTML = (a.artifacts || [])
    .map((f) => `<li><span>${esc(f.label)}</span><span class="sz">${f.exists ? bytes(f.bytes) : "нет на диске"}</span></li>`)
    .join("");
  const input = $("#m-input");
  input.value = "";
  input.classList.remove("ok");
  $("#m-go").disabled = true;
  el.hidden = false;
  setTimeout(() => input.focus(), 60);
}

function closeModal() {
  $("#modal").hidden = true;
  S.target = null;
}

async function doRemove() {
  const a = S.target;
  const word = $("#m-input").value;
  const btn = $("#m-go");
  btn.disabled = true;
  btn.textContent = "Удаляю…";
  try {
    const report = DESKTOP
      ? await invoke("remove_account", { steamId: a.steam_id, confirmation: word })
      : await mockRemove(a);
    closeModal();
    const failed = report.filter((r) => !r.ok && r.error);
    toast(failed.length ? `Готово с оговорками: ${failed.length} ${plural(failed.length, ["шаг", "шага", "шагов"])} не прошло` : `Локальные данные ${a.persona_name || a.account_name} удалены`);
    await scan();
  } catch (e) {
    toast(`Не получилось: ${e}`);
    btn.disabled = false;
  }
  btn.textContent = "Удалить данные";
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  t.style.animation = "none";
  void t.offsetWidth;
  t.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4200);
}

/* ── actions ─────────────────────────────── */
async function pickFolder() {
  if (!DESKTOP) return toast("Выбор папки доступен в приложении");
  try {
    const p = await invoke("pick_steam_folder");
    if (p) await scan();
  } catch (e) {
    toast(String(e));
  }
}
window.pickFolder = pickFolder;

/* ── events ──────────────────────────────── */
listEl.addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (!row) return;
  const acc = S.accounts.find((a) => a.steam_id === row.dataset.id);
  if (!acc) return;
  if (e.target.closest("[data-del]")) return openModal(acc);
  if (e.target.closest("[data-toggle]")) {
    S.open = S.open === acc.steam_id ? null : acc.steam_id;
    render();
  }
});

$("#q").addEventListener("input", (e) => {
  S.query = e.target.value;
  render();
});

const seg = $("#seg");
function moveThumb() {
  const on = seg.querySelector(".seg-btn.is-on");
  const thumb = seg.querySelector(".seg-thumb");
  thumb.style.width = `${on.offsetWidth}px`;
  thumb.style.transform = `translateX(${on.offsetLeft - 3}px)`;
}
seg.addEventListener("click", (e) => {
  const b = e.target.closest(".seg-btn");
  if (!b) return;
  seg.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("is-on", x === b));
  S.sort = b.dataset.sort;
  moveThumb();
  render();
});

$("#btn-rescan").addEventListener("click", scan);
$("#btn-pick").addEventListener("click", pickFolder);
$("#m-go").addEventListener("click", doRemove);
$("#m-input").addEventListener("input", (e) => {
  const ok = e.target.value.trim().toLowerCase() === CONFIRM_WORD;
  e.target.classList.toggle("ok", ok);
  $("#m-go").disabled = !ok;
});
$("#m-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !$("#m-go").disabled) doRemove();
});
document.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeModal));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#modal").hidden) closeModal();
});

if (DESKTOP) {
  const win = TAURI.window.getCurrentWindow();
  $("#btn-min").addEventListener("click", () => win.minimize());
  $("#btn-close").addEventListener("click", () => win.close());
} else {
  $("#btn-min").style.display = $("#btn-close").style.display = "none";
}

/* ── demo data (browser only) ────────────── */
function mockScan() {
  const now = Math.floor(Date.now() / 1000);
  const mk = (id, login, name, days, gb, flags = {}) => ({
    steam_id: id,
    account_name: login,
    persona_name: name,
    timestamp: now - days * 86400,
    remember_password: flags.rp !== false,
    most_recent: !!flags.recent,
    auto_login: !!flags.auto,
    avatar: null,
    total_bytes: Math.round(gb * 1024 ** 3),
    artifacts: [
      { label: "Запись входа в loginusers.vdf", path: "C:\\Program Files (x86)\\Steam\\config\\loginusers.vdf", bytes: 420, exists: true },
      { label: "Кэш аватара", path: `C:\\Program Files (x86)\\Steam\\config\\avatarcache\\${id}.png`, bytes: 38_400, exists: true },
      { label: "Данные пользователя", path: `C:\\Program Files (x86)\\Steam\\userdata\\${Number(BigInt(id) - 76561197960265728n)}`, bytes: Math.round(gb * 1024 ** 3), exists: gb > 0 },
      { label: "Запись в config.vdf", path: "C:\\Program Files (x86)\\Steam\\config\\config.vdf", bytes: 0, exists: true },
    ],
  });
  return new Promise((res) =>
    setTimeout(
      () =>
        res({
          steam_path: "C:\\Program Files (x86)\\Steam",
          manual: false,
          error: null,
          accounts: [
            mk("76561198043211557", "kuzma_dev", "Кузьма", 0, 2.42, { recent: true, auto: true }),
            mk("76561198127654321", "blade.gaming", "BLADE", 12, 0.63),
            mk("76561199001234567", "anna.p", "мама не горюй", 96, 0.14, { rp: false }),
            mk("76561197995551234", "oldacc2011", "steam_user_2011", 780, 0),
          ],
        }),
      850
    )
  );
}

function mockRemove(a) {
  return new Promise((res) =>
    setTimeout(() => {
      S.accounts = S.accounts.filter((x) => x.steam_id !== a.steam_id);
      res([{ label: "demo", ok: true, error: null }]);
    }, 600)
  );
}
if (!DESKTOP) {
  const orig = scan;
  window.__mock = true;
}

moveThumb();
scan();
