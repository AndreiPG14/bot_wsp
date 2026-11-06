/**
 * sources.js
 * Obtiene el contenido de un reporte según el origen configurado:
 *   url   → descarga desde cualquier URL (API, link de exportación, servidor interno)
 *   email → toma el último correo que coincida y usa sus adjuntos
 *   file  → archivo subido desde el panel
 *   text  → solo mensaje, sin archivo
 *
 * Devuelve { files: [{buffer, filename, mimetype}], text } donde text es
 * contenido extra (p. ej. una URL que devuelve texto o JSON).
 */

import dns from 'dns/promises';
import net from 'net';
import path from 'path';
import axios from 'axios';
import mime from 'mime-types';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import config from './config.js';
import logger from './logger.js';
import { readUpload } from './store.js';

export const MAX_BYTES = 30 * 1024 * 1024;
const SENDABLE = /^(application\/(pdf|zip|vnd\.|msword|octet-stream)|image\/(jpeg|png|gif|webp)|text\/csv)/;

// ─── Variables del mensaje ───────────────────────────────────────────────────

function partsIn(date, tz) {
  const fmt = new Intl.DateTimeFormat('es-PE', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'long', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { ...p, hour: p.hour === '24' ? '00' : p.hour };
}

function isoWeek(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 86400e3 + 1) / 7);
}

/** Variables disponibles: {fecha} {fecha_iso} {hora} {dia} {semana} {mes} {anio} {nombre} */
export function templateVars(date = new Date(), extra = {}) {
  const p = partsIn(date, config.timezone);
  const prev = partsIn(new Date(date.getTime() - 86400e3), config.timezone);
  return {
    fecha: `${p.day}/${p.month}/${p.year}`,
    fecha_iso: `${p.year}-${p.month}-${p.day}`,
    ayer_iso: `${prev.year}-${prev.month}-${prev.day}`,
    hora: `${p.hour}:${p.minute}`,
    dia: p.weekday.charAt(0).toUpperCase() + p.weekday.slice(1),
    semana: String(isoWeek(+p.year, +p.month, +p.day)),
    mes: p.month,
    anio: p.year,
    ...extra,
  };
}

export function render(text, vars) {
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// ─── Utilidades ──────────────────────────────────────────────────────────────

/** Bloquea el servicio de metadatos de la nube (credenciales de AWS/ECS). */
async function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('La URL no es válida'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Solo se permiten URLs http o https');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (ips.some(isBlockedIp)) throw new Error('Esa dirección está bloqueada por seguridad');
  return u;
}

const isBlockedIp = (ip) => /^(::ffff:)?169\.254\./i.test(ip) || /^fd00:ec2::/i.test(ip);

/** Las redirecciones también se revisan (solo IPs literales; el host ya se validó arriba). */
function checkRedirect(options) {
  const host = String(options.hostname || '').replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedIp(host)) throw new Error('Redirección bloqueada por seguridad');
}

function parseHeaders(text) {
  const headers = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return headers;
}

function filenameFrom(disposition, url, mimetype, fallback) {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition || '');
  let name = m ? decodeURIComponent(m[1]) : fallback || path.basename(new URL(url).pathname) || 'reporte';
  if (!path.extname(name)) name += `.${mime.extension(mimetype) || 'bin'}`;
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}

const isTextual = (mt) => /^(text\/(plain|html)|application\/json)/.test(mt);

// ─── Orígenes ────────────────────────────────────────────────────────────────

async function fromUrl(src, vars) {
  const url = render(src.url, vars);
  await assertSafeUrl(url);
  const headers = parseHeaders(render(src.headers, vars));
  const method = (src.method || 'GET').toUpperCase();
  const res = await axios.request({
    url,
    method,
    headers,
    data: method === 'POST' && src.body ? render(src.body, vars) : undefined,
    responseType: 'arraybuffer',
    timeout: 90_000,
    maxContentLength: MAX_BYTES,
    maxRedirects: 3,
    beforeRedirect: checkRedirect,
    validateStatus: () => true,
  });
  if (res.status >= 400) throw new Error(`La URL respondió ${res.status}`);

  const buffer = Buffer.from(res.data);
  const mimetype = String(res.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
  if (!buffer.length) throw new Error('La URL respondió vacío');

  if (isTextual(mimetype) && src.as !== 'file') {
    let text = buffer.toString('utf8');
    if (mimetype === 'application/json') {
      try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {}
    }
    return { files: [], text: text.slice(0, 4000) };
  }
  const filename = filenameFrom(res.headers['content-disposition'], url, mimetype, render(src.filename, vars));
  return { files: [{ buffer, filename, mimetype: mimetype === 'application/octet-stream' ? mime.lookup(filename) || mimetype : mimetype }], text: '' };
}

export const emailConfigured = () => !!(config.imap.user && config.imap.pass);

async function fromEmail(src, state = {}) {
  if (!emailConfigured()) throw new Error('El correo no está configurado en el servidor (IMAP_USER / IMAP_PASS)');
  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.pass },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock(src.mailbox || config.imap.mailbox);
  try {
    const criteria = { since: new Date(Date.now() - (Number(src.sinceHours) || 24) * 3600e3) };
    if (src.subject) criteria.subject = src.subject;
    if (src.from) criteria.from = src.from;
    let uids = (await client.search(criteria, { uid: true })) || [];
    if (src.onlyNew && state.lastUid) uids = uids.filter((u) => u > state.lastUid);
    if (!uids.length) throw new Error(src.onlyNew ? 'No llegó ningún correo nuevo que coincida' : 'No hay correos que coincidan');

    const uid = Math.max(...uids);
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    const parsed = await simpleParser(msg.source);
    // Se omiten las imágenes incrustadas en el cuerpo (firmas, logos).
    const files = (parsed.attachments || [])
      .filter((a) => !a.related && SENDABLE.test(a.contentType))
      .map((a) => ({ buffer: a.content, filename: a.filename || `adjunto.${mime.extension(a.contentType) || 'bin'}`, mimetype: a.contentType }));
    const text = src.includeBody ? (parsed.text || '').trim().slice(0, 3000) : '';
    if (!files.length && !text) throw new Error(`El correo "${parsed.subject || ''}" no tiene adjuntos que enviar`);
    logger.info({ uid, subject: parsed.subject, files: files.length }, 'Correo tomado como origen');
    return { files, text, state: { lastUid: uid, lastSubject: parsed.subject || '' } };
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

async function fromFile(src) {
  if (!src.fileId) throw new Error('No se ha subido ningún archivo');
  const f = await readUpload(src.fileId);
  return { files: [{ buffer: f.buffer, filename: f.filename, mimetype: f.mimetype }], text: '' };
}

/**
 * @param {object} src  Origen de la programación
 * @param {object} vars Variables para las plantillas
 * @param {object} state Estado guardado del origen (p. ej. último correo usado)
 */
export async function fetchSource(src, vars, state) {
  switch (src?.type) {
    case 'url': return fromUrl(src, vars);
    case 'email': return fromEmail(src, state);
    case 'file': return fromFile(src);
    case 'text': return { files: [], text: '' };
    default: throw new Error('Origen no reconocido');
  }
}
