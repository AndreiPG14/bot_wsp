// Panel del Bot de Alertas. Sin frameworks ni build: módulos nativos del navegador.
// Todo el contenido se arma con nodos (h) y textContent, nunca con innerHTML,
// para que nombres de grupos o asuntos de correo no puedan inyectar HTML.

// ─── Utilidades de DOM ───────────────────────────────────────────────────────

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';
function icon(d, { fill = false } = {}) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', d);
  if (fill) p.setAttribute('fill', 'currentColor');
  else {
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.9');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
  }
  svg.append(p);
  return svg;
}

const I = {
  chat: 'M4 20l1.3-3.9A8 8 0 1 1 8 19z',
  panel: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  send: 'M4 12 20 4l-6 16-3-7z',
  phone: 'M7 3h10v18H7zM11 18h2',
  plus: 'M12 5v14M5 12h14',
  play: 'M7 5v14l12-7z',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  trash: 'M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  text: 'M5 6h14M5 12h14M5 18h9',
  hook: 'M18 16a3 3 0 1 1-3 3H9M6 16a3 3 0 1 1 3-3l3-5M12 5a3 3 0 1 1 3 3l3 5',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20a6 6 0 0 1 12 0M16 4.5a3.5 3.5 0 0 1 0 6.5M21 20a6 6 0 0 0-4-5.6',
  x: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5 10 17l9-10',
  alert: 'M12 4 2.5 20h19zM12 10v4M12 17h.01',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  out: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  refresh: 'M20 11a8 8 0 0 0-14.6-4.5L4 8M4 13a8 8 0 0 0 14.6 4.5L20 16M4 4v4h4M20 20v-4h-4',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM16 16h2v2h-2z',
  test: 'M9 3h6M10 3v6L5 19a1.5 1.5 0 0 0 1.3 2h11.4a1.5 1.5 0 0 0 1.3-2L14 9V3',
};
const TICKS = () => {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 18 12');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', 'M1 6.5 4.5 10 11 2M7 9.5 7.6 10 14 2');
  for (const [k, v] of Object.entries({ fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) p.setAttribute(k, v);
  svg.append(p);
  return svg;
};

// ─── Estado y API ────────────────────────────────────────────────────────────

const state = {
  user: null,
  timezone: 'America/Lima',
  emailConfigured: false,
  view: (location.hash.slice(1) || 'panel'),
  overview: null,
  schedules: [],
  sessions: [],
  history: [],
  historyFilter: { q: '', status: '' },
  openRows: new Set(),
  seenHistory: new Set(),
};

class ApiError extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401 && path !== '/login') {
    state.user = null;
    renderLogin();
    throw new ApiError('Tu sesión expiró');
  }
  if (!res.ok) throw new ApiError(data.error || `Error ${res.status}`);
  return data;
}

// ─── Formatos ────────────────────────────────────────────────────────────────

const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const tzFmt = (opts) => new Intl.DateTimeFormat('es-PE', { timeZone: state.timezone, ...opts });
const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: state.timezone }).format(d);

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const time = tzFmt({ hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const today = dayKey(new Date());
  const k = dayKey(d);
  if (k === today) return `Hoy ${time}`;
  if (k === dayKey(new Date(Date.now() + 86400e3))) return `Mañana ${time}`;
  if (k === dayKey(new Date(Date.now() - 86400e3))) return `Ayer ${time}`;
  return `${tzFmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(d)} · ${time}`;
}

function fmtIn(iso) {
  const min = Math.round((new Date(iso) - Date.now()) / 60000);
  if (min < 1) return 'en un momento';
  if (min < 60) return `en ${min} min`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `en ${hrs} h`;
  return `en ${Math.round(hrs / 24)} d`;
}

const fmtSize = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} kB` : `${(b / 1048576).toFixed(1)} MB`);

function describeTrigger(t) {
  if (!t) return '';
  if (t.type === 'webhook') return 'Cuando llega por webhook';
  const sorted = (t.days || []).slice().sort();
  const days = sorted.join() === '1,2,3,4,5' ? 'Lun a vie' : sorted.map((d) => DAYS[d]).join(', ');
  switch (t.mode) {
    case 'daily': return `Todos los días · ${t.time}`;
    case 'weekdays': return `Lunes a viernes · ${t.time}`;
    case 'weekly': return `${days} · ${t.time}`;
    case 'hourly': return `Cada ${t.every} h, ${t.from}–${t.to}${days && t.days.length < 7 ? ` · ${days}` : ''}`;
    case 'monthly': return `Día ${t.dom} de cada mes · ${t.time}`;
    case 'custom': return `Cron · ${t.cron}`;
    default: return t.cron || '';
  }
}

function describeSource(s) {
  if (!s) return { icon: I.file, label: '—' };
  switch (s.type) {
    case 'url': {
      let host = s.url;
      try { host = new URL(s.url.replace(/\{\w+\}/g, 'x')).host; } catch {}
      return { icon: I.link, label: host, kind: 'URL' };
    }
    case 'email': return { icon: I.mail, label: s.subject ? `“${s.subject}”` : 'Último correo', kind: 'Correo' };
    case 'file': return { icon: I.file, label: s.filename || 'Archivo', kind: 'Archivo' };
    case 'text': return { icon: I.text, label: 'Solo mensaje', kind: 'Texto' };
    default: return { icon: I.file, label: s.type };
  }
}

const ORIGIN = { programado: 'Programado', manual: 'Manual', webhook: 'Webhook', api: 'API' };
const STATUS = {
  enviado: ['ok', 'Enviado'], parcial: ['warn', 'Parcial'], error: ['bad', 'Error'], enviando: ['info', 'Enviando'],
};
function statusChip(st) {
  const [cls, label] = STATUS[st] || ['', st];
  return h('span', { class: `chip ${cls}` }, st === 'enviando' ? h('span', { class: 'spin' }) : null, label);
}

function recipientsSummary(r) {
  const g = r?.groups?.length || 0;
  const n = r?.numbers?.length || 0;
  return [g && `${g} grupo${g > 1 ? 's' : ''}`, n && `${n} número${n > 1 ? 's' : ''}`].filter(Boolean).join(' · ') || 'Sin destinatarios';
}

// ─── Avisos y diálogos ───────────────────────────────────────────────────────

function toast(msg, bad = false) {
  const t = h('div', { class: `toast${bad ? ' bad' : ''}` }, icon(bad ? I.alert : I.check), msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), 4200);
}

function modal(build, { wide = false } = {}) {
  const prev = document.activeElement;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const box = h('div', { class: `modal-box${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' });
  const overlay = h('div', { class: 'modal', onclick: (e) => { if (e.target === overlay) close(); } }, box);
  box.append(...[build(close)].flat());
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  box.querySelector('button, input')?.focus();
  return close;
}

function confirmDialog(title, text, okLabel = 'Eliminar') {
  return new Promise((resolve) => {
    modal((close) => [
      h('h3', {}, title),
      h('p', {}, text),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn ghost', onclick: () => { close(); resolve(false); } }, 'Cancelar'),
        h('button', { class: 'btn danger-fill', onclick: () => { close(); resolve(true); } }, okLabel)),
    ]);
  });
}

async function withBusy(btn, fn) {
  btn.classList.add('loading');
  try { return await fn(); } finally { btn.classList.remove('loading'); }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copiado'); } catch { toast('No se pudo copiar', true); }
}

// ─── Login ───────────────────────────────────────────────────────────────────

function renderLogin() {
  stopPolling();
  const err = h('p', { class: 'error', role: 'alert' });
  const user = h('input', { class: 'input', name: 'user', autocomplete: 'username', required: true, value: 'admin' });
  const pass = h('input', { class: 'input', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Entrar');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      await withBusy(btn, async () => {
        try {
          await api('/login', { method: 'POST', body: { user: user.value, password: pass.value } });
          await boot();
        } catch (e2) { err.textContent = e2.message; pass.select(); }
      });
    },
  },
  h('div', { class: 'brand' }, h('span', { class: 'logo' }, icon(I.chat)), h('div', {}, h('h1', {}, 'Bot de Alertas'), h('p', { class: 'muted' }, 'Reportes automáticos por WhatsApp'))),
  h('label', { class: 'field' }, h('span', {}, 'Usuario'), user),
  h('label', { class: 'field' }, h('span', {}, 'Contraseña'), pass),
  err, btn);
  document.getElementById('root').replaceChildren(h('div', { class: 'login' }, form));
  pass.focus();
}

// ─── Estructura ──────────────────────────────────────────────────────────────

const NAV = [
  ['panel', 'Panel', I.panel],
  ['programaciones', 'Programaciones', I.clock],
  ['envios', 'Envíos', I.send],
  ['sesiones', 'Sesiones', I.phone],
];

let mainEl;
let liveEl;
let navEl;

function renderShell() {
  liveEl = h('span', { class: 'live' });
  navEl = h('nav', { class: 'side', 'aria-label': 'Secciones' });
  mainEl = h('main', { class: 'main', id: 'main' });
  const top = h('header', { class: 'top' },
    h('span', { class: 'logo' }, icon(I.chat)),
    h('div', {}, h('p', { class: 't1' }, 'Bot de Alertas'), h('p', { class: 't2' }, 'Reportes automáticos por WhatsApp')),
    liveEl,
    h('button', { class: 'btn icon out', title: 'Cerrar sesión', 'aria-label': 'Cerrar sesión', onclick: logout }, icon(I.out)));
  document.getElementById('root').replaceChildren(h('div', { class: 'app' }, top, h('div', { class: 'body' }, navEl, mainEl)));
  renderNav();
  renderLive();
}

function renderNav() {
  const running = state.overview?.running?.length || 0;
  navEl.replaceChildren(
    ...NAV.map(([id, label, d]) => h('button', {
      'aria-current': state.view === id ? 'page' : null,
      onclick: () => go(id),
    }, icon(d), label, id === 'envios' && running ? h('span', { class: 'badge', title: 'Enviando ahora' }, running) : null)),
    h('p', { class: 'foot' }, `Hora: ${state.timezone.replace('_', ' ')}`)
  );
}

function renderLive() {
  const sessions = state.overview?.sessions || state.sessions;
  const on = sessions.filter((s) => s.connected).length;
  liveEl.className = `live${on ? '' : ' off'}`;
  liveEl.replaceChildren(h('i'), h('span', {}, on ? `En línea · ${on} sesión${on > 1 ? 'es' : ''}` : 'Sin sesión conectada'));
}

function go(view) {
  state.view = view;
  history.replaceState(null, '', `#${view}`);
  renderNav();
  mainEl.scrollTop = 0;
  refresh(true);
}

async function logout() {
  try { await api('/logout', { method: 'POST' }); } catch {}
  state.user = null;
  renderLogin();
}

// ─── Carga periódica ─────────────────────────────────────────────────────────

let pollTimer = null;
let lastSig = '';
function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }

async function refresh(first = false) {
  stopPolling();
  try {
    const v = state.view;
    const tasks = [api('/overview').then((o) => { state.overview = o; state.sessions = o.sessions; })];
    if (v === 'programaciones') tasks.push(api('/schedules').then((r) => { state.schedules = r.schedules; }));
    if (v === 'envios') {
      const p = new URLSearchParams({ q: state.historyFilter.q, status: state.historyFilter.status, limit: 300 });
      tasks.push(api(`/history?${p}`).then((r) => { state.history = r.history; }));
    }
    await Promise.all(tasks);
    if (v === 'sesiones') {
      await Promise.all(state.sessions.filter((s) => !s.connected).map((s) =>
        api(`/sessions/${encodeURIComponent(s.id)}`).then((d) => { if (d.qr) qrCache.set(s.id, d.qr); }).catch(() => {})));
    }
    if (!state.user) return;
    // Solo se redibuja si algo cambió: así no se pierden clics ni lo que se está escribiendo.
    const sig = JSON.stringify([v, state.overview, state.schedules, state.history, [...qrCache], [...state.openRows]]);
    if (first || sig !== lastSig) {
      lastSig = sig;
      renderLive();
      renderNav();
      if (!document.querySelector('.drawer') || first) renderView();
    }
  } catch (err) {
    if (!(err instanceof ApiError) || state.user) console.warn(err);
  }
  if (state.user) pollTimer = setTimeout(refresh, document.hidden ? 30000 : state.view === 'sesiones' ? 3000 : 6000);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && state.user) refresh(); });

function renderView() {
  const view = { panel: viewPanel, programaciones: viewSchedules, envios: viewHistory, sesiones: viewSessions }[state.view] || viewPanel;
  // Conserva el foco y lo escrito en filtros al refrescar.
  const active = document.activeElement;
  const keep = active?.dataset?.keep;
  const caret = keep ? [active.selectionStart, active.selectionEnd] : null;
  mainEl.replaceChildren(view());
  if (keep) {
    const el = mainEl.querySelector(`[data-keep="${keep}"]`);
    if (el) { el.focus(); if (caret && el.setSelectionRange) el.setSelectionRange(...caret); }
  }
}

// ─── Vista: Panel ────────────────────────────────────────────────────────────

function viewPanel() {
  const o = state.overview;
  if (!o) return h('div', { class: 'page' }, h('p', { class: 'muted' }, 'Cargando…'));
  const connected = o.sessions.filter((s) => s.connected).length;

  const banners = [];
  if (!connected) {
    banners.push(h('div', { class: 'banner bad' }, icon(I.alert), 'No hay ninguna sesión de WhatsApp conectada. Los envíos van a fallar.',
      h('button', { class: 'btn sm ghost', onclick: () => go('sesiones') }, 'Conectar')));
  }
  if (o.pausedUntil) {
    banners.push(h('div', { class: 'banner warn' }, icon(I.alert), `Envíos en pausa por protección anti-bloqueo hasta las ${tzFmt({ hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(o.pausedUntil))}.`));
  }

  const rate = o.kpis.successRate;
  return h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, 'Panel'), h('p', {}, 'Lo que salió hoy y lo que viene.')),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => openEditor() }, icon(I.plus), 'Nueva programación'))),
    banners,
    h('section', { class: 'kpis' },
      h('div', { class: 'kpi' }, h('span', {}, 'Enviados hoy'), h('b', {}, o.kpis.sentToday)),
      h('div', { class: 'kpi' }, h('span', {}, 'Programaciones activas'), h('b', {}, o.kpis.activeSchedules, h('small', {}, ` / ${o.kpis.totalSchedules}`))),
      h('div', { class: 'kpi' }, h('span', {}, 'Sesiones conectadas'), h('b', {}, connected, h('small', {}, ` / ${o.sessions.length}`))),
      h('div', { class: 'kpi' }, h('span', {}, 'Entregados · 7 días'), h('b', { class: rate != null && rate >= 0.95 ? 'ok' : '' }, rate == null ? '—' : `${(rate * 100).toFixed(1).replace('.', ',')} %`))),
    h('div', { class: 'cols' },
      h('section', { class: 'card' },
        h('p', { class: 'h' }, 'Próximos envíos', h('button', { class: 'more', onclick: () => go('programaciones') }, 'Ver todas')),
        o.upcoming.length
          ? h('ul', { class: 'list' }, o.upcoming.map((s) => {
            const src = describeSource(s.source);
            return h('li', { class: 'row' },
              h('span', { class: 'ic' }, icon(src.icon)),
              h('div', { class: 'txt' }, h('b', {}, s.name), h('small', {}, `${describeTrigger(s.trigger)} · ${recipientsSummary(s.recipients)}`)),
              h('div', { class: 'when' }, h('b', {}, fmtWhen(s.nextRun)), fmtIn(s.nextRun)));
          }))
          : h('div', { class: 'empty' }, h('b', {}, 'No hay envíos programados'), 'Crea una programación para que el bot envíe reportes solo.',
            h('br'), h('button', { class: 'btn primary sm', onclick: () => openEditor() }, icon(I.plus), 'Nueva programación'))),
      h('section', { class: 'card' },
        h('p', { class: 'h' }, 'Sesiones', h('button', { class: 'more', onclick: () => go('sesiones') }, 'Administrar')),
        o.sessions.length
          ? h('ul', { class: 'list' }, o.sessions.map((s) => h('li', { class: 'row' },
            h('span', { class: 'av' }, s.id.slice(0, 2)),
            h('div', { class: 'txt' }, h('b', {}, s.id), h('small', {}, s.phone ? `+${s.phone}` : s.hasQr ? 'Escanea el QR para vincular' : 'Reconectando…')),
            sessionChip(s))))
          : h('div', { class: 'empty' }, h('b', {}, 'Sin sesiones'), 'Vincula un número de WhatsApp.'))),
    h('section', { class: 'card' },
      h('p', { class: 'h' }, 'Últimos envíos', h('button', { class: 'more', onclick: () => go('envios') }, 'Ver historial')),
      historyTable(o.recent, { compact: true })));
}

function sessionChip(s) {
  if (s.connected) return h('span', { class: 'chip ok' }, 'Conectada');
  if (s.hasQr) return h('span', { class: 'chip warn' }, 'Esperando QR');
  return h('span', { class: 'chip bad' }, 'Desconectada');
}

// ─── Vista: Envíos ───────────────────────────────────────────────────────────

function historyTable(list, { compact = false } = {}) {
  if (!list.length) return h('div', { class: 'empty' }, h('b', {}, 'Todavía no hay envíos'), 'Aquí aparecerá cada reporte que salga por WhatsApp.');
  const firstLoad = state.seenHistory.size === 0;
  const rows = [];
  for (const e of list) {
    const isNew = !firstLoad && !state.seenHistory.has(e.id);
    state.seenHistory.add(e.id);
    const open = state.openRows.has(e.id);
    const toggle = () => { open ? state.openRows.delete(e.id) : state.openRows.add(e.id); renderView(); };
    rows.push(h('tr', { class: `click${isNew ? ' row-in' : ''}`, onclick: toggle, 'aria-expanded': open ? 'true' : 'false' },
      h('td', { class: 'nowrap mono' }, fmtWhen(e.at)),
      h('td', {}, e.name, e.files?.length ? h('span', { class: 'sub' }, e.files.join(', ')) : null),
      compact ? null : h('td', { class: 'nowrap hide-sm' }, h('span', { class: 'chip' }, ORIGIN[e.origin] || e.origin)),
      h('td', { class: 'nowrap mono' }, `${e.sent}/${e.recipients}`),
      h('td', { class: 'nowrap' }, e.status === 'enviado' ? h('span', { class: 'ticks', title: 'Enviado' }, TICKS()) : statusChip(e.status))));
    if (open) {
      rows.push(h('tr', { class: 'detail' }, h('td', { colspan: compact ? 4 : 5 },
        e.details?.length
          ? h('div', { class: 'detail-list' }, e.details.map((d) => h('div', {},
            d.ok ? h('span', { class: 'ticks' }, TICKS()) : h('span', { class: 'chip bad' }, 'Falló'),
            h('span', {}, d.to), d.error ? h('em', {}, d.error) : null)))
          : null,
        e.error ? h('p', { class: 'err-line' }, e.error) : null,
        h('p', { class: 'muted' }, [e.session && `Sesión: ${e.session}`, ORIGIN[e.origin] && `Origen: ${ORIGIN[e.origin]}`].filter(Boolean).join(' · ')))));
    }
  }
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Fecha'), h('th', {}, 'Reporte'), compact ? null : h('th', { class: 'hide-sm' }, 'Origen'), h('th', {}, 'Enviados'), h('th', {}, 'Estado'))),
    h('tbody', {}, rows)));
}

let searchTimer;
function viewHistory() {
  const f = state.historyFilter;
  return h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h2', {}, 'Envíos'), h('p', {}, 'Cada reporte que salió, a quién y si llegó. Toca una fila para ver el detalle.'))),
    h('section', { class: 'card' },
      h('div', { class: 'filters' },
        h('input', {
          class: 'input search', type: 'search', placeholder: 'Buscar por reporte o destinatario', value: f.q, 'data-keep': 'q', 'aria-label': 'Buscar',
          oninput: (e) => { f.q = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(() => refresh(), 300); },
        }),
        h('select', { class: 'input', 'aria-label': 'Estado', onchange: (e) => { f.status = e.target.value; refresh(); } },
          [['', 'Todos'], ['enviado', 'Enviados'], ['parcial', 'Parciales'], ['error', 'Con error'], ['enviando', 'Enviando']]
            .map(([v, l]) => h('option', { value: v, selected: f.status === v }, l)))),
      h('div', { class: 'sr' }, `${state.history.length} envíos`)),
    h('section', { class: 'card' }, historyTable(state.history)));
}

// ─── Vista: Programaciones ───────────────────────────────────────────────────

function viewSchedules() {
  const list = state.schedules;
  return h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, 'Programaciones'), h('p', {}, 'Qué reporte sale, de dónde lo saca, cuándo y a quién.')),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => openEditor() }, icon(I.plus), 'Nueva programación'))),
    list.length
      ? h('div', { class: 'sched-grid' }, list.map(scheduleCard))
      : h('section', { class: 'card' }, h('div', { class: 'empty' },
        h('b', {}, 'Aún no hay programaciones'),
        'Conecta un reporte (una URL, un correo, un archivo o un mensaje) y elige cuándo enviarlo.',
        h('br'), h('button', { class: 'btn primary', onclick: () => openEditor() }, icon(I.plus), 'Crear la primera'))));
}

function scheduleCard(s) {
  const src = describeSource(s.source);
  const hookUrl = s.trigger?.type === 'webhook' ? `${location.origin}/hooks/${s.trigger.token}` : null;
  const last = s.lastRun;

  const sw = h('button', {
    class: 'switch', role: 'switch', 'aria-checked': s.enabled ? 'true' : 'false', 'aria-label': s.enabled ? 'Pausar' : 'Activar', title: s.enabled ? 'Activa' : 'Pausada',
    onclick: async () => {
      try {
        const r = await api(`/schedules/${s.id}/toggle`, { method: 'POST' });
        toast(r.enabled ? `“${s.name}” activada` : `“${s.name}” pausada`);
        refresh();
      } catch (e) { toast(e.message, true); }
    },
  });

  const runBtn = h('button', {
    class: 'btn sm ghost', disabled: s.running || null,
    onclick: async (e) => {
      const btn = e.currentTarget;
      await withBusy(btn, async () => {
        try {
          await api(`/schedules/${s.id}/run`, { method: 'POST' });
          toast(`Enviando “${s.name}”…`);
          refresh();
        } catch (err) { toast(err.message, true); }
      });
    },
  }, s.running ? h('span', { class: 'spin' }) : icon(I.play), s.running ? 'Enviando' : 'Enviar ahora');

  return h('article', { class: `sched${s.enabled ? '' : ' off'}` },
    h('div', { class: 'sched-top' },
      h('div', { class: 'grow' }, h('h3', {}, s.name), h('p', {}, describeTrigger(s.trigger))),
      sw),
    h('div', { class: 'facts' },
      fact(src.icon, src.kind || 'Origen', src.label),
      fact(I.users, 'Destinatarios', recipientsSummary(s.recipients)),
      fact(I.clock, 'Próximo envío', s.trigger?.type === 'webhook' ? 'Al recibir el webhook' : s.enabled ? (s.nextRun ? `${fmtWhen(s.nextRun)} (${fmtIn(s.nextRun)})` : '—') : 'En pausa'),
      fact(I.send, 'Último envío', last ? h('span', {}, `${fmtWhen(last.at)} `, statusChip(last.status)) : 'Nunca')),
    hookUrl ? h('div', { class: 'hook' }, h('code', { title: hookUrl }, hookUrl),
      h('button', { class: 'btn sm icon', title: 'Copiar URL', 'aria-label': 'Copiar URL del webhook', onclick: () => copy(hookUrl) }, icon(I.copy))) : null,
    h('div', { class: 'sched-foot' },
      runBtn,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm ghost', onclick: () => openEditor(s) }, icon(I.edit), 'Editar'),
      h('button', {
        class: 'btn sm icon danger', title: 'Eliminar', 'aria-label': `Eliminar ${s.name}`,
        onclick: async () => {
          if (!(await confirmDialog('¿Eliminar programación?', `“${s.name}” dejará de enviarse. El historial se conserva.`))) return;
          try { await api(`/schedules/${s.id}`, { method: 'DELETE' }); toast('Programación eliminada'); refresh(); } catch (e) { toast(e.message, true); }
        },
      }, icon(I.trash))));
}

function fact(d, label, value) {
  return h('div', { class: 'fact' }, icon(d), h('div', {}, h('small', {}, label), typeof value === 'string' ? h('span', { title: value }, value) : value));
}

// ─── Vista: Sesiones ─────────────────────────────────────────────────────────

function viewSessions() {
  const input = h('input', {
    class: 'input', placeholder: 'Nombre de la sesión, p. ej. bot-reportes', 'data-keep': 'newses', maxlength: 40, 'aria-label': 'Nombre de la nueva sesión',
    value: state.newSession || '', oninput: (e) => { state.newSession = e.target.value; },
  });
  const create = async (e) => {
    e.preventDefault();
    const id = input.value.trim().replace(/\s+/g, '-');
    if (!id) return input.focus();
    try {
      await api('/sessions', { method: 'POST', body: { id } });
      input.value = '';
      state.newSession = '';
      toast(`Sesión “${id}” creada. Escanea el QR.`);
      refresh();
    } catch (err) { toast(err.message, true); }
  };
  const sessions = state.sessions;
  return h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h2', {}, 'Sesiones'), h('p', {}, 'Números de WhatsApp vinculados al bot. Cada uno se vincula escaneando su QR.'))),
    h('section', { class: 'card' },
      h('p', { class: 'h' }, 'Vincular un número'),
      h('form', { class: 'new-ses', onsubmit: create }, input, h('button', { class: 'btn primary', type: 'submit' }, icon(I.qr), 'Generar QR')),
      h('p', { class: 'muted', style: null }, 'En el teléfono: WhatsApp → Dispositivos vinculados → Vincular un dispositivo.')),
    sessions.length
      ? h('div', { class: 'ses-grid' }, sessions.map(sessionCard))
      : h('section', { class: 'card' }, h('div', { class: 'empty' }, h('b', {}, 'No hay sesiones'), 'Crea una arriba para vincular el primer número.')));
}

const qrCache = new Map();
function sessionCard(s) {
  const qrBox = h('div', { class: 'qr' });
  if (!s.connected) {
    const cached = qrCache.get(s.id);
    qrBox.append(cached ? h('img', { src: cached, alt: `Código QR de ${s.id}` }) : h('div', { class: 'wait' }, h('span', { class: 'spin' })),
      s.hasQr ? 'Escanéalo desde el teléfono del bot. Se renueva solo.' : 'Generando QR…');
  } else qrCache.delete(s.id);

  return h('article', { class: 'ses' },
    h('div', { class: 'ses-top' },
      h('span', { class: 'av' }, s.id.slice(0, 2)),
      h('div', { class: 'txt' }, h('b', {}, s.id), h('small', {}, s.connected ? [s.phone && `+${s.phone}`, s.name].filter(Boolean).join(' · ') : s.reconnectAttempts ? `Reintento ${s.reconnectAttempts}` : 'Sin vincular')),
      sessionChip(s)),
    s.connected ? null : qrBox,
    h('div', { class: 'ses-actions' },
      s.connected ? h('button', { class: 'btn sm ghost', onclick: () => showGroups(s.id) }, icon(I.users), 'Ver grupos') : null,
      h('button', {
        class: 'btn sm danger',
        onclick: async () => {
          const ok = await confirmDialog('¿Eliminar sesión?', `Se desvincula “${s.id}” y se borran sus credenciales. Para volver a usarla habrá que escanear otro QR.`);
          if (!ok) return;
          try {
            const r = await api(`/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
            toast(r.schedulesAffected?.length ? `Sesión eliminada. Revisa: ${r.schedulesAffected.join(', ')}` : 'Sesión eliminada', !!r.schedulesAffected?.length);
            refresh();
          } catch (e) { toast(e.message, true); }
        },
      }, icon(I.trash), 'Eliminar')));
}

function showGroups(sessionId) {
  modal((close) => {
    const body = h('div', { class: 'scroll' }, h('p', { class: 'muted' }, 'Cargando grupos…'));
    api(`/sessions/${encodeURIComponent(sessionId)}/groups`).then(({ groups }) => {
      body.replaceChildren(groups.length
        ? h('ul', { class: 'list' }, groups.map((g) => h('li', { class: 'row' },
          h('span', { class: 'ic' }, icon(I.users)),
          h('div', { class: 'txt' }, h('b', {}, g.name), h('small', {}, `${g.participants} participantes · ${g.id}`)),
          h('button', { class: 'btn sm icon', title: 'Copiar ID', 'aria-label': `Copiar ID de ${g.name}`, onclick: () => copy(g.id) }, icon(I.copy)))))
        : h('p', { class: 'muted' }, 'Este número no está en ningún grupo.'));
    }).catch((e) => body.replaceChildren(h('p', { class: 'err-line' }, e.message)));
    return [h('h3', {}, `Grupos de ${sessionId}`), body, h('div', { class: 'modal-actions' }, h('button', { class: 'btn ghost', onclick: close }, 'Cerrar'))];
  }, { wide: true });
}

// ─── Editor de programación ──────────────────────────────────────────────────

const VARS = ['{fecha}', '{hora}', '{dia}', '{semana}', '{mes}', '{anio}', '{nombre}'];
const URL_VARS = ['{fecha_iso}', '{ayer_iso}', '{semana}', '{mes}', '{anio}'];

function blankSchedule() {
  return {
    name: '', enabled: true, session: '',
    trigger: { type: 'cron', mode: 'weekdays', time: '07:00', days: [1, 2, 3, 4, 5], every: 2, minute: 0, from: '08:00', to: '18:00', dom: 1, cron: '0 7 * * 1-5' },
    source: { type: 'url', url: '', method: 'GET', headers: '', body: '', filename: '', as: 'auto', subject: '', from: '', sinceHours: 24, onlyNew: true, includeBody: false },
    message: '📊 {nombre} · {fecha}',
    recipients: { groups: [], numbers: [] },
  };
}

function openEditor(existing) {
  const base = blankSchedule();
  const d = existing ? structuredClone(existing) : base;
  d.trigger = { ...base.trigger, ...(d.trigger || {}) };
  if (existing?.trigger?.type === 'webhook') d.trigger.type = 'webhook';
  d.source = { ...base.source, ...(d.source || {}) };
  d.recipients = { groups: [...(d.recipients?.groups || [])], numbers: [...(d.recipients?.numbers || [])] };
  let numbersText = d.recipients.numbers.join('\n');

  const err = h('p', { class: 'err', role: 'alert' });
  const body = h('div', { class: 'drawer-body' });
  const prevFocus = document.activeElement;

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); prevFocus?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal')) close(); };

  const saveBtn = h('button', { class: 'btn primary', onclick: (e) => withBusy(e.currentTarget, save) }, icon(I.check), existing ? 'Guardar cambios' : 'Crear programación');
  const panel = h('div', { class: 'drawer-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': existing ? 'Editar programación' : 'Nueva programación' },
    h('div', { class: 'drawer-head' }, h('h2', {}, existing ? 'Editar programación' : 'Nueva programación'),
      h('button', { class: 'btn icon ghost', 'aria-label': 'Cerrar', onclick: close }, icon(I.x))),
    body,
    h('div', { class: 'drawer-foot' }, err, h('button', { class: 'btn ghost', onclick: close }, 'Cancelar'), saveBtn));
  const overlay = h('div', { class: 'drawer', onclick: (e) => { if (e.target === overlay) close(); } }, panel);

  function payload() {
    return {
      name: d.name, enabled: d.enabled, session: d.session, message: d.message,
      trigger: d.trigger, source: d.source,
      recipients: { groups: d.recipients.groups, numbers: numbersText.split(/[\s,;]+/).filter(Boolean) },
    };
  }

  async function save() {
    err.textContent = '';
    try {
      if (existing) await api(`/schedules/${existing.id}`, { method: 'PUT', body: payload() });
      else await api('/schedules', { method: 'POST', body: payload() });
      toast(existing ? 'Cambios guardados' : 'Programación creada');
      close();
      if (state.view !== 'programaciones') go('programaciones'); else refresh(true);
    } catch (e) { err.textContent = e.message; }
  }

  // Paso 1: nombre y sesión
  const step1 = () => h('section', { class: 'step' },
    h('p', { class: 'step-h' }, h('i', {}, '1'), 'Reporte'),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, h('span', {}, 'Nombre'),
        h('input', { class: 'input', value: d.name, maxlength: 80, placeholder: 'Producción diaria', oninput: (e) => { d.name = e.target.value; } })),
      h('label', { class: 'field' }, h('span', {}, 'Enviar desde'),
        h('select', { class: 'input', onchange: (e) => { d.session = e.target.value; loadGroups(); } },
          h('option', { value: '' }, 'Cualquier sesión conectada'),
          state.sessions.map((s) => h('option', { value: s.id, selected: d.session === s.id }, `${s.id}${s.connected ? '' : ' (desconectada)'}`))))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: d.enabled, onchange: (e) => { d.enabled = e.target.checked; } }), 'Activa'));

  // Paso 2: cuándo
  const whenBox = h('div', { class: 'field' });
  const MODES = [['daily', 'Diario'], ['weekdays', 'Lun – Vie'], ['weekly', 'Días'], ['hourly', 'Cada X horas'], ['monthly', 'Mensual'], ['custom', 'Cron'], ['webhook', 'Webhook']];
  const currentMode = () => (d.trigger.type === 'webhook' ? 'webhook' : d.trigger.mode);
  const setMode = (m) => {
    if (m === 'webhook') d.trigger.type = 'webhook';
    else { d.trigger.type = 'cron'; d.trigger.mode = m; }
    renderWhen();
  };
  const timeInput = (key, label) => h('label', { class: 'field' }, h('span', {}, label),
    h('input', { class: 'input', type: 'time', value: d.trigger[key], onchange: (e) => { d.trigger[key] = e.target.value; } }));
  const daysPicker = () => h('div', { class: 'days', role: 'group', 'aria-label': 'Días' },
    [1, 2, 3, 4, 5, 6, 0].map((n) => h('button', {
      type: 'button', 'aria-pressed': d.trigger.days.includes(n) ? 'true' : 'false',
      onclick: (e) => {
        d.trigger.days = d.trigger.days.includes(n) ? d.trigger.days.filter((x) => x !== n) : [...d.trigger.days, n];
        e.currentTarget.setAttribute('aria-pressed', d.trigger.days.includes(n) ? 'true' : 'false');
      },
    }, DAYS[n])));

  function renderWhen() {
    const m = currentMode();
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Frecuencia' },
      MODES.map(([id, label]) => h('button', { type: 'button', 'aria-pressed': m === id ? 'true' : 'false', onclick: () => setMode(id) }, label)));
    let fields;
    switch (m) {
      case 'daily': case 'weekdays': fields = h('div', { class: 'grid3' }, timeInput('time', 'Hora')); break;
      case 'weekly': fields = [daysPicker(), h('div', { class: 'grid3' }, timeInput('time', 'Hora'))]; break;
      case 'monthly': fields = h('div', { class: 'grid3' },
        h('label', { class: 'field' }, h('span', {}, 'Día del mes'), h('input', { class: 'input', type: 'number', min: 1, max: 28, value: d.trigger.dom, oninput: (e) => { d.trigger.dom = e.target.value; } })),
        timeInput('time', 'Hora')); break;
      case 'hourly': fields = [h('div', { class: 'grid3' },
        h('label', { class: 'field' }, h('span', {}, 'Cada (horas)'), h('input', { class: 'input', type: 'number', min: 1, max: 12, value: d.trigger.every, oninput: (e) => { d.trigger.every = e.target.value; } })),
        timeInput('from', 'Desde'), timeInput('to', 'Hasta')), daysPicker(), h('small', {}, 'Sin días marcados = todos los días.')]; break;
      case 'custom': fields = [h('label', { class: 'field' }, h('span', {}, 'Expresión cron (min hora día mes díaSemana)'),
        h('input', { class: 'input mono', value: d.trigger.cron, placeholder: '0 7 * * 1-5', oninput: (e) => { d.trigger.cron = e.target.value; } }))]; break;
      case 'webhook': {
        const url = existing?.trigger?.type === 'webhook' ? `${location.origin}/hooks/${existing.trigger.token}` : null;
        fields = h('div', { class: 'hint' },
          'Se envía cuando otro sistema llama a una URL propia de esta programación (Power Automate, un script, otro servidor). ',
          'Si la llamada trae un archivo, se envía ese; si viene vacía, se usa el origen de abajo.',
          url ? [h('br'), h('br'), h('code', {}, `POST ${url}`)] : [h('br'), h('br'), 'La URL aparece al guardar.']);
        break;
      }
    }
    whenBox.replaceChildren(seg, ...[fields].flat());
  }
  const step2 = () => {
    renderWhen();
    return h('section', { class: 'step' }, h('p', { class: 'step-h' }, h('i', {}, '2'), 'Cuándo', h('small', {}, `Hora de ${state.timezone.replace('_', ' ')}`)), whenBox);
  };

  // Paso 3: origen
  const srcBox = h('div', { class: 'field' });
  const testOut = h('div');
  const SOURCES = [['url', 'URL / API', I.link], ['email', 'Correo', I.mail], ['file', 'Archivo', I.file], ['text', 'Solo mensaje', I.text]];
  const setSrc = (t) => { d.source.type = t; testOut.replaceChildren(); renderSrc(); };
  const varButtons = (list, target, key) => h('div', { class: 'vars' }, list.map((v) => h('button', {
    type: 'button', title: `Insertar ${v}`,
    onclick: () => {
      const el = target();
      const s = el.selectionStart ?? el.value.length;
      el.value = el.value.slice(0, s) + v + el.value.slice(el.selectionEnd ?? s);
      el.dispatchEvent(new Event('input'));
      el.focus();
      el.setSelectionRange(s + v.length, s + v.length);
    },
  }, v)));

  function renderSrc() {
    const t = d.source.type;
    const s = d.source;
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Origen' },
      SOURCES.map(([id, label]) => h('button', { type: 'button', 'aria-pressed': t === id ? 'true' : 'false', onclick: () => setSrc(id) }, label)));
    let fields = [];
    if (t === 'url') {
      const urlInput = h('input', { class: 'input mono', value: s.url, placeholder: 'https://servidor/reportes/produccion?fecha={fecha_iso}', oninput: (e) => { s.url = e.target.value; } });
      fields = [
        h('div', { class: 'grid2' },
          h('label', { class: 'field' }, h('span', {}, 'Método'),
            h('select', { class: 'input', onchange: (e) => { s.method = e.target.value; renderSrc(); } }, ['GET', 'POST'].map((m) => h('option', { value: m, selected: s.method === m }, m)))),
          h('label', { class: 'field' }, h('span', {}, 'Nombre del archivo (opcional)'),
            h('input', { class: 'input', value: s.filename, placeholder: 'Reporte_{fecha_iso}.pdf', oninput: (e) => { s.filename = e.target.value; } }))),
        h('label', { class: 'field' }, h('span', {}, 'URL'), urlInput),
        varButtons(URL_VARS, () => urlInput),
        h('label', { class: 'field' }, h('span', {}, 'Cabeceras (una por línea)'),
          h('textarea', { class: 'input mono', rows: 2, placeholder: 'Authorization: Bearer …', oninput: (e) => { s.headers = e.target.value; } }, s.headers),
          h('small', {}, 'Para APIs con token o clave. Se guardan en el servidor.')),
        s.method === 'POST' ? h('label', { class: 'field' }, h('span', {}, 'Cuerpo (JSON)'),
          h('textarea', { class: 'input mono', rows: 3, oninput: (e) => { s.body = e.target.value; } }, s.body)) : null,
        h('small', {}, 'Si la URL devuelve un PDF, imagen, Excel o CSV se envía como archivo; si devuelve texto o JSON, va dentro del mensaje.'),
      ];
    } else if (t === 'email') {
      fields = [
        state.emailConfigured ? null : h('div', { class: 'banner warn' }, icon(I.alert), 'El correo no está configurado en el servidor (IMAP_USER / IMAP_PASS).'),
        h('div', { class: 'grid2' },
          h('label', { class: 'field' }, h('span', {}, 'Asunto contiene'), h('input', { class: 'input', value: s.subject, placeholder: 'Reporte de producción', oninput: (e) => { s.subject = e.target.value; } })),
          h('label', { class: 'field' }, h('span', {}, 'Remitente contiene'), h('input', { class: 'input', value: s.from, placeholder: 'powerbi@', oninput: (e) => { s.from = e.target.value; } }))),
        h('div', { class: 'grid3' },
          h('label', { class: 'field' }, h('span', {}, 'Buscar en las últimas (h)'), h('input', { class: 'input', type: 'number', min: 1, max: 720, value: s.sinceHours, oninput: (e) => { s.sinceHours = e.target.value; } }))),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.onlyNew, onchange: (e) => { s.onlyNew = e.target.checked; } }), 'Solo correos nuevos (no reenviar el mismo)'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.includeBody, onchange: (e) => { s.includeBody = e.target.checked; } }), 'Incluir el texto del correo en el mensaje'),
      ];
    } else if (t === 'file') {
      const fileInput = h('input', { type: 'file', class: 'sr', accept: '.pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls,.csv,.docx,.zip', onchange: upload });
      const label = s.fileId
        ? h('div', { class: 'grow' }, h('b', {}, s.filename), h('br'), h('small', { class: 'muted' }, s.size ? fmtSize(s.size) : 'Subido'))
        : h('div', { class: 'grow' }, h('b', {}, 'Sube el archivo que se enviará'), h('br'), h('small', { class: 'muted' }, 'PDF, imagen, Excel, CSV… hasta 30 MB'));
      fields = [h('label', { class: `upload${s.fileId ? ' has' : ''}` }, icon(I.file), label, fileInput,
        h('span', { class: 'btn sm ghost', role: 'button' }, s.fileId ? 'Cambiar' : 'Elegir archivo'))];
    } else {
      fields = [h('small', {}, 'Se envía solo el mensaje del paso 4. Útil para recordatorios o avisos.')];
    }
    const testBtn = t === 'text' ? null : h('button', { type: 'button', class: 'btn sm ghost', onclick: (e) => withBusy(e.currentTarget, testSource) }, icon(I.test), 'Probar origen');
    srcBox.replaceChildren(seg, ...fields.filter(Boolean), h('div', {}, testBtn), testOut);
  }

  async function upload(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 30 * 1048576) return toast('El archivo supera los 30 MB', true);
    const content = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    try {
      const up = await api('/uploads', { method: 'POST', body: { filename: file.name, content } });
      Object.assign(d.source, { fileId: up.fileId, filename: up.filename, size: up.size });
      renderSrc();
    } catch (err2) { toast(err2.message, true); }
  }

  async function testSource() {
    testOut.replaceChildren(h('div', { class: 'test-out' }, h('span', { class: 'spin' })));
    try {
      const r = await api('/test-source', { method: 'POST', body: { source: d.source, message: d.message, name: d.name } });
      testOut.replaceChildren(h('div', { class: 'test-out' },
        h('b', {}, '✓ Origen correcto. Se enviaría:'),
        r.files.map((f) => h('span', {}, `📎 ${f.filename} · ${fmtSize(f.size)}`)),
        r.text ? h('pre', {}, r.text) : null,
        !r.files.length && !r.text ? h('span', {}, 'Nada (vacío)') : null,
        r.message ? h('span', { class: 'muted' }, `Mensaje: ${r.message}`) : null));
    } catch (e) {
      testOut.replaceChildren(h('div', { class: 'test-out bad' }, e.message));
    }
  }

  const step3 = () => {
    renderSrc();
    return h('section', { class: 'step' }, h('p', { class: 'step-h' }, h('i', {}, '3'), 'De dónde sale el reporte'), srcBox);
  };

  // Paso 4: mensaje
  const step4 = () => {
    const ta = h('textarea', { class: 'input', rows: 3, maxlength: 3000, oninput: (e) => { d.message = e.target.value; } }, d.message);
    return h('section', { class: 'step' },
      h('p', { class: 'step-h' }, h('i', {}, '4'), 'Mensaje', h('small', {}, 'Va como pie del archivo')),
      ta, varButtons(VARS, () => ta));
  };

  // Paso 5: destinatarios
  const groupsBox = h('div', { class: 'groups' });
  const pickedBox = h('div', { class: 'picked' });
  let groupList = [];
  let groupQuery = '';

  function renderPicked() {
    pickedBox.replaceChildren(...d.recipients.groups.map((g) => h('span', { class: 'chip wa' }, g.name,
      h('button', { type: 'button', 'aria-label': `Quitar ${g.name}`, onclick: () => { d.recipients.groups = d.recipients.groups.filter((x) => x.id !== g.id); renderPicked(); renderGroupList(); } }, '×'))));
  }

  const listEl = h('div', { class: 'group-list' });
  function renderGroupList() {
    const q = groupQuery.toLowerCase();
    const items = groupList.filter((g) => g.name.toLowerCase().includes(q));
    listEl.replaceChildren(...(items.length ? items.map((g) => h('label', {},
      h('input', {
        type: 'checkbox', checked: d.recipients.groups.some((x) => x.id === g.id),
        onchange: (e) => {
          if (e.target.checked) d.recipients.groups.push({ id: g.id, name: g.name });
          else d.recipients.groups = d.recipients.groups.filter((x) => x.id !== g.id);
          renderPicked();
        },
      }),
      h('span', { class: 'grow' }, g.name), h('small', { class: 'muted' }, g.participants))) : [h('p', { class: 'muted empty' }, groupList.length ? 'Ningún grupo coincide' : 'Sin grupos')]));
  }

  async function loadGroups() {
    const sid = d.session || state.sessions.find((s) => s.connected)?.id;
    if (!sid || !state.sessions.find((s) => s.id === sid)?.connected) {
      groupsBox.replaceChildren(h('p', { class: 'muted' }, 'Conecta una sesión para elegir grupos de la lista. Los ya elegidos se conservan.'), pickedBox);
      renderPicked();
      return;
    }
    groupsBox.replaceChildren(h('p', { class: 'muted' }, 'Cargando grupos…'));
    try {
      groupList = (await api(`/sessions/${encodeURIComponent(sid)}/groups`)).groups;
      const search = h('input', { class: 'input', type: 'search', placeholder: `Buscar entre ${groupList.length} grupos de ${sid}`, 'aria-label': 'Buscar grupo', oninput: (e) => { groupQuery = e.target.value; renderGroupList(); } });
      groupsBox.replaceChildren(search, listEl, pickedBox);
      renderGroupList();
      renderPicked();
    } catch (e) {
      groupsBox.replaceChildren(h('p', { class: 'err-line' }, e.message), pickedBox);
      renderPicked();
    }
  }

  const step5 = () => {
    loadGroups();
    return h('section', { class: 'step' },
      h('p', { class: 'step-h' }, h('i', {}, '5'), 'A quién'),
      h('div', { class: 'field' }, h('span', {}, 'Grupos'), groupsBox),
      h('label', { class: 'field' }, h('span', {}, 'Números (uno por línea, con código de país)'),
        h('textarea', { class: 'input mono', rows: 2, placeholder: '51987654321', oninput: (e) => { numbersText = e.target.value; } }, numbersText)),
      h('small', {}, 'Entre cada destinatario el bot espera unos segundos para no ser bloqueado por WhatsApp.'));
  };

  body.append(step1(), step2(), step3(), step4(), step5());
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  body.querySelector('input')?.focus();
}

// ─── Arranque ────────────────────────────────────────────────────────────────

async function boot() {
  try {
    const me = await api('/me');
    Object.assign(state, { user: me.user, timezone: me.timezone, emailConfigured: me.emailConfigured });
  } catch {
    return renderLogin();
  }
  renderShell();
  refresh(true);
}

window.addEventListener('hashchange', () => {
  const v = location.hash.slice(1);
  if (state.user && v && v !== state.view && NAV.some(([id]) => id === v)) go(v);
});

boot();
