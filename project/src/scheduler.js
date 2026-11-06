/**
 * scheduler.js
 * Programaciones de envío: arma la expresión cron desde las opciones del panel,
 * calcula el próximo envío, ejecuta cada programación y la deja en el historial.
 */

import cron from 'node-cron';
import config from './config.js';
import logger from './logger.js';
import { getFirstConnectedSession, getSession } from './baileys.js';
import { sendFiles } from './sendWhatsapp.js';
import { fetchSource, render, templateVars } from './sources.js';
import { addHistory, getSchedule, listSchedules, newId, patchSchedule, updateHistory } from './store.js';

// ─── Cron ────────────────────────────────────────────────────────────────────

function parseTime(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time || '');
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error('La hora debe tener el formato HH:MM');
  return { h: +m[1], m: +m[2] };
}

/** Convierte la frecuencia elegida en el panel en una expresión cron de 5 campos. */
export function buildCron(trigger) {
  if (trigger.mode === 'custom') {
    const expr = String(trigger.cron || '').trim();
    if (expr.split(/\s+/).length !== 5 || !cron.validate(expr)) throw new Error('La expresión cron no es válida (usa 5 campos)');
    return expr;
  }
  if (trigger.mode === 'hourly') {
    const every = Math.min(Math.max(parseInt(trigger.every, 10) || 1, 1), 12);
    const minute = Math.min(Math.max(parseInt(trigger.minute, 10) || 0, 0), 59);
    const from = parseTime(trigger.from || '00:00').h;
    const to = parseTime(trigger.to || '23:59').h;
    if (to < from) throw new Error('La hora final debe ser posterior a la inicial');
    return `${minute} ${from}-${to}/${every} * * ${daysField(trigger.days)}`;
  }
  const { h, m } = parseTime(trigger.time);
  switch (trigger.mode) {
    case 'daily': return `${m} ${h} * * *`;
    case 'weekdays': return `${m} ${h} * * 1-5`;
    case 'weekly': {
      if (!trigger.days?.length) throw new Error('Elige al menos un día de la semana');
      return `${m} ${h} * * ${daysField(trigger.days)}`;
    }
    case 'monthly': {
      const dom = Math.min(Math.max(parseInt(trigger.dom, 10) || 1, 1), 28);
      return `${m} ${h} ${dom} * *`;
    }
    default: throw new Error('Frecuencia no reconocida');
  }
}

function daysField(days) {
  const list = [...new Set((days || []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
  return list.length && list.length < 7 ? list.join(',') : '*';
}

function parseField(field, min, max) {
  const set = new Set();
  for (const part of field.split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? parseInt(stepRaw, 10) : 1;
    let [a, b] = range === '*' ? [min, max] : range.split('-').map(Number);
    if (b === undefined) b = stepRaw ? max : a;
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return set;
}

function parseCron(expr) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const dow = parseField(f[4], 0, 7);
  if (dow.has(7)) dow.add(0);
  return {
    minute: parseField(f[0], 0, 59), hour: parseField(f[1], 0, 23),
    dom: parseField(f[2], 1, 31), month: parseField(f[3], 1, 12), dow,
    domStar: f[2] === '*', dowStar: f[4] === '*',
  };
}

/** Diferencia en minutos entre la hora local de la zona y UTC. */
function tzOffset(at) {
  const date = new Date(Math.floor(at.getTime() / 60000) * 60000);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - date.getTime()) / 60000);
}

/** Próxima fecha en que se cumple la expresión cron, en la zona horaria configurada. */
export function nextRun(expr, from = new Date()) {
  const f = expr && parseCron(expr);
  if (!f) return null;
  const off = tzOffset(from);
  // Se trabaja con la "hora de pared" de la zona expresada como UTC.
  let t = Math.floor(from.getTime() / 60000) * 60000 + 60000 + off * 60000;
  for (let i = 0; i < 200_000; i++) {
    const d = new Date(t);
    if (!f.month.has(d.getUTCMonth() + 1)) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      continue;
    }
    const domOk = f.dom.has(d.getUTCDate());
    const dowOk = f.dow.has(d.getUTCDay());
    const dayOk = f.domStar || f.dowStar ? domOk && dowOk : domOk || dowOk;
    if (!dayOk) { t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); continue; }
    if (!f.hour.has(d.getUTCHours())) { t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1); continue; }
    if (!f.minute.has(d.getUTCMinutes())) { t += 60000; continue; }
    return new Date(t - off * 60000);
  }
  return null;
}

// ─── Trabajos ────────────────────────────────────────────────────────────────

const jobs = new Map();
const running = new Set();

export function isRunning(id) {
  return running.has(id);
}

export function scheduleJob(s) {
  jobs.get(s.id)?.stop();
  jobs.delete(s.id);
  if (!s.enabled || s.trigger?.type !== 'cron' || !s.trigger.cron) return;
  const task = cron.schedule(
    s.trigger.cron,
    () => {
      runSchedule(s.id, { origin: 'programado' }).catch((err) =>
        logger.error({ schedule: s.name, err: err.message }, 'Error en envío programado'));
    },
    { timezone: config.timezone }
  );
  jobs.set(s.id, task);
}

export function unscheduleJob(id) {
  jobs.get(id)?.stop();
  jobs.delete(id);
}

export function startScheduler() {
  for (const s of listSchedules()) scheduleJob(s);
  logger.info({ jobs: jobs.size, timezone: config.timezone }, '⏰ Programador de envíos iniciado');
}

// ─── Ejecución ───────────────────────────────────────────────────────────────

function pickSession(preferred) {
  if (preferred) {
    if (!getSession(preferred)?.isConnected) throw new Error(`La sesión "${preferred}" no está conectada`);
    return preferred;
  }
  const first = getFirstConnectedSession();
  if (!first) throw new Error('No hay ninguna sesión de WhatsApp conectada');
  return first;
}

function recipientsOf(s) {
  const groups = (s.recipients?.groups || []).map((g) => ({ id: g.id, label: g.name || g.id, kind: 'grupo' }));
  const numbers = (s.recipients?.numbers || []).map((n) => ({ id: n, label: `+${n}`, kind: 'número' }));
  return [...groups, ...numbers];
}

/**
 * Ejecuta una programación ahora.
 * @param {string} id
 * @param {{origin: string, payload?: {files: object[], text: string}}} opts
 *   payload: contenido recibido por webhook (reemplaza al origen configurado)
 * @returns {Promise<object>} entrada de historial (se resuelve cuando termina el envío)
 */
export async function runSchedule(id, { origin, payload } = {}) {
  const s = getSchedule(id);
  if (!s) throw new Error('Programación no encontrada');
  if (running.has(id)) throw new Error('Esta programación ya se está enviando');

  const targets = recipientsOf(s);
  const entry = {
    id: newId(),
    at: new Date().toISOString(),
    scheduleId: s.id,
    name: s.name,
    origin,
    source: payload ? 'webhook' : s.source?.type,
    status: 'enviando',
    recipients: targets.length,
    sent: 0,
    failed: 0,
    files: payload ? payload.files.map((f) => f.filename) : [],
  };
  running.add(id);
  await addHistory(entry);

  try {
    if (!targets.length) throw new Error('La programación no tiene destinatarios');
    const sessionId = pickSession(s.session);
    const vars = templateVars(new Date(), { nombre: s.name });
    const content = payload || (await fetchSource(s.source, vars, s.sourceState || {}));
    const text = [render(s.message, vars), content.text].filter((x) => x && x.trim()).join('\n\n');

    await updateHistory(entry.id, { session: sessionId, files: content.files.map((f) => f.filename) });
    const results = await sendFiles(sessionId, targets.map((t) => t.id), content.files, text);

    const byId = new Map(targets.map((t) => [t.id, t]));
    const patch = {
      status: results.failed === 0 ? 'enviado' : results.sent === 0 ? 'error' : 'parcial',
      sent: results.sent,
      failed: results.failed,
      finishedAt: new Date().toISOString(),
      details: results.details.map((d) => ({ to: byId.get(d.recipient)?.label || d.recipient, kind: byId.get(d.recipient)?.kind, ok: d.ok, error: d.error })),
    };
    if (patch.status === 'error') patch.error = results.details.find((d) => d.error)?.error;
    await updateHistory(entry.id, patch);
    await patchSchedule(id, {
      lastRun: { at: entry.at, status: patch.status, historyId: entry.id },
      ...(content.state && results.sent > 0 ? { sourceState: { ...(s.sourceState || {}), ...content.state } } : {}),
    });
    return { ...entry, ...patch };
  } catch (err) {
    logger.error({ schedule: s.name, err: err.message }, 'Programación fallida');
    const patch = { status: 'error', error: err.message, finishedAt: new Date().toISOString() };
    await updateHistory(entry.id, patch);
    await patchSchedule(id, { lastRun: { at: entry.at, status: 'error', historyId: entry.id } });
    return { ...entry, ...patch };
  } finally {
    running.delete(id);
  }
}

/** Registra en el historial un envío hecho por la API antigua (/send, /send-image, /send-text). */
export async function trackApiSend({ name, session, recipients, files }, resultsPromise) {
  const entry = {
    id: newId(), at: new Date().toISOString(), name, origin: 'api', source: 'api', session,
    status: 'enviando', recipients: recipients.length, sent: 0, failed: 0, files,
  };
  await addHistory(entry);
  try {
    const r = await resultsPromise;
    await updateHistory(entry.id, {
      status: r.failed === 0 ? 'enviado' : r.sent === 0 ? 'error' : 'parcial',
      sent: r.sent, failed: r.failed, finishedAt: new Date().toISOString(),
      details: r.details.map((d) => ({ to: d.recipient, kind: d.recipient.endsWith('@g.us') ? 'grupo' : 'número', ok: d.ok, error: d.error })),
      ...(r.sent === 0 ? { error: r.details.find((d) => d.error)?.error } : {}),
    });
  } catch (err) {
    await updateHistory(entry.id, { status: 'error', error: err.message, finishedAt: new Date().toISOString() });
    throw err;
  }
}
