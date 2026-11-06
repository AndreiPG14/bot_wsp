/**
 * panelApi.js
 * API JSON que usa el panel web (/api/*). Todas las rutas, salvo login, exigen sesión.
 *
 *   POST   /api/login · /api/logout · GET /api/me
 *   GET    /api/overview
 *   GET    /api/sessions · POST /api/sessions · GET/DELETE /api/sessions/:id
 *   GET    /api/sessions/:id/groups
 *   GET    /api/schedules · POST /api/schedules
 *   PUT    /api/schedules/:id · DELETE /api/schedules/:id
 *   POST   /api/schedules/:id/run · /api/schedules/:id/toggle
 *   POST   /api/test-source            → prueba un origen sin enviar nada
 *   POST   /api/uploads                → sube un archivo para usarlo como origen
 *   GET    /api/history
 */

import express from 'express';
import mime from 'mime-types';
import config from './config.js';
import logger from './logger.js';
import { login, logout, panelUser, requirePanel } from './auth.js';
import {
  createSession, deleteSession, getSessionQr, isValidSessionId, listGroupsVia, listSessions,
} from './baileys.js';
import { sendStatus } from './sendWhatsapp.js';
import { emailConfigured, fetchSource, MAX_BYTES, render, templateVars } from './sources.js';
import { buildCron, isRunning, nextRun, runSchedule, scheduleJob, unscheduleJob } from './scheduler.js';
import {
  getSchedule, listHistory, listSchedules, newId, patchSchedule, readUpload, removeSchedule,
  removeUpload, saveSchedule, saveUpload,
} from './store.js';

const router = express.Router();

router.post('/login', login);
router.post('/logout', logout);
router.get('/me', (req, res) => {
  const user = panelUser(req);
  if (!user) return res.status(401).json({ error: 'Sin sesión' });
  res.json({ user, timezone: config.timezone, emailConfigured: emailConfigured() });
});

router.use(requirePanel);

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    const status = err.status || 400;
    if (status >= 500) logger.error({ err: err.message }, 'Error en API del panel');
    res.status(status).json({ error: err.message });
  });

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ─── Resumen ─────────────────────────────────────────────────────────────────

const dayKey = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date(iso));

function view(s) {
  const next = s.enabled && s.trigger?.type === 'cron' ? nextRun(s.trigger.cron) : null;
  return { ...s, nextRun: next?.toISOString() || null, running: isRunning(s.id) };
}

router.get('/overview', (req, res) => {
  const history = listHistory();
  const today = dayKey(new Date().toISOString());
  const weekAgo = Date.now() - 7 * 86400e3;
  const week = history.filter((h) => new Date(h.at).getTime() >= weekAgo);
  const okW = week.reduce((a, h) => a + (h.sent || 0), 0);
  const badW = week.reduce((a, h) => a + (h.failed || 0), 0);
  const schedules = listSchedules().map(view);

  res.json({
    sessions: listSessions(),
    kpis: {
      sentToday: history.filter((h) => dayKey(h.at) === today).reduce((a, h) => a + (h.sent || 0), 0),
      activeSchedules: schedules.filter((s) => s.enabled).length,
      totalSchedules: schedules.length,
      successRate: okW + badW ? okW / (okW + badW) : null,
    },
    upcoming: schedules.filter((s) => s.nextRun).sort((a, b) => a.nextRun.localeCompare(b.nextRun)).slice(0, 6),
    running: schedules.filter((s) => s.running).map((s) => s.name),
    recent: history.slice(0, 8),
    pausedUntil: sendStatus().pausedUntil,
    emailConfigured: emailConfigured(),
    timezone: config.timezone,
  });
});

// ─── Sesiones ────────────────────────────────────────────────────────────────

router.get('/sessions', (req, res) => res.json({ sessions: listSessions() }));

router.post('/sessions', wrap(async (req, res) => {
  const id = String(req.body?.id || '').trim();
  if (!isValidSessionId(id)) throw fail('Usa solo letras, números, guion o guion bajo (máx. 40).');
  if (listSessions().some((s) => s.id === id)) throw fail('Ya existe una sesión con ese nombre.');
  createSession(id).catch((err) => logger.error({ sessionId: id, err: err.message }, 'Error al crear sesión'));
  res.status(201).json({ id });
}));

router.get('/sessions/:id', wrap(async (req, res) => {
  const s = listSessions().find((x) => x.id === req.params.id);
  if (!s) throw fail('Sesión no encontrada', 404);
  res.json({ ...s, qr: s.connected ? null : getSessionQr(s.id) });
}));

router.delete('/sessions/:id', wrap(async (req, res) => {
  if (!isValidSessionId(req.params.id)) throw fail('Sesión no válida');
  const inUse = listSchedules().filter((s) => s.session === req.params.id).map((s) => s.name);
  await deleteSession(req.params.id);
  res.json({ ok: true, schedulesAffected: inUse });
}));

router.get('/sessions/:id/groups', wrap(async (req, res) => {
  if (!isValidSessionId(req.params.id)) throw fail('Sesión no válida');
  res.json({ groups: await listGroupsVia(req.params.id, { fresh: req.query.fresh === '1' }) });
}));

// ─── Validación de programaciones ────────────────────────────────────────────

const str = (v, max, label, required = false) => {
  const s = String(v ?? '').trim();
  if (required && !s) throw fail(`Falta ${label}`);
  if (s.length > max) throw fail(`${label} es demasiado largo (máx. ${max})`);
  return s;
};

function cleanTrigger(t, existing) {
  if (t?.type === 'webhook') {
    const token = existing?.trigger?.type === 'webhook' && existing.trigger.token ? existing.trigger.token : newId(18);
    return { type: 'webhook', token };
  }
  const trigger = {
    type: 'cron',
    mode: str(t?.mode, 20, 'la frecuencia', true),
    time: str(t?.time, 5, 'la hora'),
    days: Array.isArray(t?.days) ? t.days.map(Number).filter((d) => d >= 0 && d <= 6) : [],
    every: parseInt(t?.every, 10) || 1,
    minute: parseInt(t?.minute, 10) || 0,
    from: str(t?.from, 5, 'la hora inicial'),
    to: str(t?.to, 5, 'la hora final'),
    dom: parseInt(t?.dom, 10) || 1,
    cron: str(t?.cron, 100, 'la expresión cron'),
  };
  trigger.cron = buildCron(trigger);
  return trigger;
}

async function cleanSource(src) {
  const type = src?.type;
  switch (type) {
    case 'url': {
      const url = str(src.url, 2000, 'la URL', true);
      if (!/^https?:\/\//i.test(url)) throw fail('La URL debe empezar con http:// o https://');
      return {
        type, url,
        method: src.method === 'POST' ? 'POST' : 'GET',
        headers: str(src.headers, 3000, 'las cabeceras'),
        body: str(src.body, 5000, 'el cuerpo'),
        filename: str(src.filename, 120, 'el nombre de archivo'),
        as: src.as === 'file' ? 'file' : 'auto',
      };
    }
    case 'email':
      return {
        type,
        subject: str(src.subject, 200, 'el asunto'),
        from: str(src.from, 200, 'el remitente'),
        sinceHours: Math.min(Math.max(parseInt(src.sinceHours, 10) || 24, 1), 720),
        onlyNew: src.onlyNew !== false,
        includeBody: !!src.includeBody,
      };
    case 'file': {
      const fileId = str(src.fileId, 16, 'el archivo', true);
      const f = await readUpload(fileId).catch(() => null);
      if (!f) throw fail('El archivo subido ya no existe; vuelve a subirlo');
      return { type, fileId, filename: f.filename, size: f.buffer.length };
    }
    case 'text':
      return { type };
    default:
      throw fail('Elige de dónde sale el reporte');
  }
}

function cleanRecipients(r) {
  const groups = (Array.isArray(r?.groups) ? r.groups : [])
    .filter((g) => /^[\d-]+@g\.us$/.test(g?.id || ''))
    .map((g) => ({ id: g.id, name: str(g.name, 120, 'el nombre del grupo') }));
  const numbers = [...new Set((Array.isArray(r?.numbers) ? r.numbers : String(r?.numbers || '').split(/[\s,;]+/))
    .map((n) => String(n).replace(/\D/g, ''))
    .filter(Boolean))];
  const bad = numbers.find((n) => n.length < 8 || n.length > 15);
  if (bad) throw fail(`El número ${bad} no es válido. Usa el código de país, p. ej. 51987654321`);
  if (groups.length + numbers.length === 0) throw fail('Agrega al menos un grupo o número');
  if (groups.length + numbers.length > 60) throw fail('Máximo 60 destinatarios por programación');
  return { groups, numbers };
}

async function cleanSchedule(body, existing) {
  const session = str(body.session, 40, 'la sesión');
  if (session && !isValidSessionId(session)) throw fail('Sesión no válida');
  const source = await cleanSource(body.source);
  const message = str(body.message, 3000, 'el mensaje');
  if (source.type === 'text' && !message) throw fail('Escribe el mensaje que se enviará');

  const sameSource = existing && JSON.stringify(existing.source) === JSON.stringify(source);
  if (existing?.source?.type === 'file' && existing.source.fileId !== source.fileId) {
    await removeUpload(existing.source.fileId);
  }
  const now = new Date().toISOString();
  return {
    id: existing?.id || newId(),
    name: str(body.name, 80, 'el nombre', true),
    enabled: body.enabled !== false,
    session,
    trigger: cleanTrigger(body.trigger, existing),
    source,
    message,
    recipients: cleanRecipients(body.recipients),
    sourceState: sameSource ? existing.sourceState || {} : {},
    lastRun: existing?.lastRun || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

// ─── Programaciones ──────────────────────────────────────────────────────────

router.get('/schedules', (req, res) => res.json({ schedules: listSchedules().map(view) }));

router.post('/schedules', wrap(async (req, res) => {
  const s = await saveSchedule(await cleanSchedule(req.body || {}));
  scheduleJob(s);
  logger.info({ name: s.name }, 'Programación creada');
  res.status(201).json(view(s));
}));

router.put('/schedules/:id', wrap(async (req, res) => {
  const existing = getSchedule(req.params.id);
  if (!existing) throw fail('Programación no encontrada', 404);
  const s = await saveSchedule(await cleanSchedule(req.body || {}, existing));
  scheduleJob(s);
  res.json(view(s));
}));

router.delete('/schedules/:id', wrap(async (req, res) => {
  if (!getSchedule(req.params.id)) throw fail('Programación no encontrada', 404);
  unscheduleJob(req.params.id);
  await removeSchedule(req.params.id);
  res.json({ ok: true });
}));

router.post('/schedules/:id/toggle', wrap(async (req, res) => {
  const s = getSchedule(req.params.id);
  if (!s) throw fail('Programación no encontrada', 404);
  await patchSchedule(s.id, { enabled: !s.enabled, updatedAt: new Date().toISOString() });
  scheduleJob(s);
  res.json(view(s));
}));

router.post('/schedules/:id/run', wrap(async (req, res) => {
  const s = getSchedule(req.params.id);
  if (!s) throw fail('Programación no encontrada', 404);
  if (isRunning(s.id)) throw fail('Ya se está enviando, espera a que termine', 409);
  runSchedule(s.id, { origin: 'manual' }).catch((err) => logger.error({ err: err.message }, 'Error en envío manual'));
  res.status(202).json({ ok: true });
}));

/** Prueba el origen: descarga el reporte y dice qué se enviaría, sin enviar nada. */
router.post('/test-source', wrap(async (req, res) => {
  const source = await cleanSource(req.body?.source);
  const vars = templateVars(new Date(), { nombre: str(req.body?.name, 80, 'el nombre') || 'Reporte' });
  const content = await fetchSource({ ...source, onlyNew: false }, vars, {});
  res.json({
    files: content.files.map((f) => ({ filename: f.filename, mimetype: f.mimetype, size: f.buffer.length })),
    text: content.text ? content.text.slice(0, 600) : '',
    message: render(req.body?.message, vars),
  });
}));

// ─── Archivos ────────────────────────────────────────────────────────────────

router.post('/uploads', wrap(async (req, res) => {
  const filename = str(req.body?.filename, 120, 'el nombre del archivo', true).replace(/[\\/:*?"<>|]/g, '_');
  const buffer = Buffer.from(String(req.body?.content || ''), 'base64');
  if (!buffer.length) throw fail('El archivo está vacío');
  if (buffer.length > MAX_BYTES) throw fail('El archivo supera los 30 MB');
  const mimetype = mime.lookup(filename) || 'application/octet-stream';
  const fileId = await saveUpload(buffer, { filename, mimetype, uploadedAt: new Date().toISOString() });
  res.status(201).json({ fileId, filename, size: buffer.length, mimetype });
}));

// ─── Historial ───────────────────────────────────────────────────────────────

router.get('/history', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const status = String(req.query.status || '');
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const list = listHistory()
    .filter((h) => !status || h.status === status)
    .filter((h) => !q || (h.name || '').toLowerCase().includes(q) || (h.details || []).some((d) => String(d.to).toLowerCase().includes(q)))
    .slice(0, limit);
  res.json({ history: list });
});

export default router;
