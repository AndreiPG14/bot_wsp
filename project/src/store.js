/**
 * store.js
 * Persistencia simple en archivos JSON dentro de DATA_DIR:
 *   schedules.json  → programaciones
 *   history.json    → historial de envíos
 *   uploads/        → archivos subidos desde el panel
 *
 * Las escrituras son atómicas (archivo temporal + rename) y se serializan
 * para que dos cambios simultáneos no se pisen.
 */

import path from 'path';
import crypto from 'crypto';
import fse from 'fs-extra';
import config from './config.js';
import logger from './logger.js';

const files = {
  schedules: () => path.join(config.paths.data, 'schedules.json'),
  history: () => path.join(config.paths.data, 'history.json'),
};
export const uploadsDir = () => path.join(config.paths.data, 'uploads');

const state = { schedules: [], history: [] };
const chains = { schedules: Promise.resolve(), history: Promise.resolve() };

export async function initStore() {
  await fse.ensureDir(config.paths.data);
  await fse.ensureDir(uploadsDir());
  for (const key of Object.keys(files)) {
    try {
      state[key] = (await fse.readJson(files[key]())) || [];
    } catch (err) {
      if (err.code !== 'ENOENT') logger.error({ key, err: err.message }, 'No se pudo leer el almacén; se inicia vacío');
      state[key] = [];
    }
  }
  logger.info({ dir: config.paths.data, schedules: state.schedules.length }, 'Almacén del panel listo');
}

function persist(key) {
  const run = async () => {
    const target = files[key]();
    const tmp = `${target}.${process.pid}.tmp`;
    await fse.writeJson(tmp, state[key], { spaces: 2 });
    await fse.move(tmp, target, { overwrite: true });
  };
  chains[key] = chains[key].then(run).catch((err) => logger.error({ key, err: err.message }, 'Error al guardar'));
  return chains[key];
}

export const newId = (bytes = 6) => crypto.randomBytes(bytes).toString('hex');

// ─── Programaciones ──────────────────────────────────────────────────────────

export const listSchedules = () => state.schedules;
export const getSchedule = (id) => state.schedules.find((s) => s.id === id) || null;
export const getScheduleByToken = (token) =>
  state.schedules.find((s) => s.trigger?.type === 'webhook' && s.trigger.token && safeEqual(s.trigger.token, token)) || null;

export async function saveSchedule(schedule) {
  const i = state.schedules.findIndex((s) => s.id === schedule.id);
  if (i === -1) state.schedules.push(schedule);
  else state.schedules[i] = schedule;
  await persist('schedules');
  return schedule;
}

export async function patchSchedule(id, patch) {
  const s = getSchedule(id);
  if (!s) return null;
  Object.assign(s, patch);
  await persist('schedules');
  return s;
}

export async function removeSchedule(id) {
  const s = getSchedule(id);
  state.schedules = state.schedules.filter((x) => x.id !== id);
  await persist('schedules');
  if (s?.source?.type === 'file' && s.source.fileId) await removeUpload(s.source.fileId);
}

// ─── Historial ───────────────────────────────────────────────────────────────

export const listHistory = () => state.history;

export async function addHistory(entry) {
  state.history.unshift(entry);
  if (state.history.length > config.historyLimit) state.history.length = config.historyLimit;
  await persist('history');
  return entry;
}

export async function updateHistory(id, patch) {
  const h = state.history.find((x) => x.id === id);
  if (!h) return;
  Object.assign(h, patch);
  await persist('history');
}

// ─── Archivos subidos ────────────────────────────────────────────────────────

const UPLOAD_ID = /^[a-f0-9]{16}$/;

export async function saveUpload(buffer, meta) {
  const id = newId(8);
  await fse.writeFile(path.join(uploadsDir(), id), buffer);
  await fse.writeJson(path.join(uploadsDir(), `${id}.json`), meta);
  return id;
}

export async function readUpload(id) {
  if (!UPLOAD_ID.test(id)) throw new Error('Archivo no válido');
  const buffer = await fse.readFile(path.join(uploadsDir(), id));
  const meta = await fse.readJson(path.join(uploadsDir(), `${id}.json`));
  return { buffer, ...meta };
}

export async function removeUpload(id) {
  if (!UPLOAD_ID.test(id)) return;
  await fse.remove(path.join(uploadsDir(), id));
  await fse.remove(path.join(uploadsDir(), `${id}.json`));
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
