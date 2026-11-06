/**
 * baileys.js
 * Gestiona múltiples sesiones de WhatsApp usando @whiskeysockets/baileys.
 * Cada sesión tiene su propia carpeta auth/<sessionId> y su propio socket.
 */

import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import fse from 'fs-extra';
import QRCode from 'qrcode';
import pino from 'pino';
import path from 'path';
import config from './config.js';
import logger from './logger.js';
import { sleep } from './utils.js';

const baileysLogger = pino({ level: 'silent' });

/**
 * sessions: Map<sessionId, SessionState>
 * SessionState: { sock, isConnected, qrDataUrl, reconnectAttempts, readyResolve }
 */
const sessions = new Map();

// Solo letras, números, guion y guion bajo. Evita rutas como ".." que borrarían fuera de auth/.
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;
export const isValidSessionId = (id) => typeof id === 'string' && SESSION_ID.test(id);

function authPath(sessionId) {
  if (!isValidSessionId(sessionId)) throw new Error(`Nombre de sesión no válido: ${sessionId}`);
  return path.join(config.paths.auth, sessionId);
}

export function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

/** Número vinculado a la sesión, sin el sufijo de dispositivo. */
function sessionPhone(s) {
  const raw = s.sock?.user?.id;
  return raw ? raw.split(':')[0].split('@')[0] : null;
}

export function listSessions() {
  return Array.from(sessions.entries()).map(([id, s]) => ({
    id,
    connected: s.isConnected,
    hasQr: !!s.qrDataUrl,
    reconnectAttempts: s.reconnectAttempts,
    phone: s.isConnected ? sessionPhone(s) : null,
    name: s.isConnected ? s.sock?.user?.name || null : null,
  }));
}

export function getSessionQr(sessionId) {
  return sessions.get(sessionId)?.qrDataUrl || null;
}

export function getFirstConnectedSession() {
  for (const [id, s] of sessions.entries()) {
    if (s.isConnected) return id;
  }
  return null;
}

/**
 * Crea una nueva sesión o retorna la existente.
 * @param {string} sessionId
 */
export async function createSession(sessionId) {
  if (!isValidSessionId(sessionId)) throw new Error(`Nombre de sesión no válido: ${sessionId}`);
  if (sessions.has(sessionId)) return sessions.get(sessionId);

  const s = {
    sock: null,
    isConnected: false,
    qrDataUrl: null,
    reconnectAttempts: 0,
    readyResolve: null,
  };
  sessions.set(sessionId, s);
  await connect(sessionId);
  return s;
}

/**
 * Elimina una sesión: cierra el socket y borra la carpeta auth/<sessionId>.
 * @param {string} sessionId
 */
export async function deleteSession(sessionId) {
  if (!isValidSessionId(sessionId)) throw new Error(`Nombre de sesión no válido: ${sessionId}`);
  groupCache.delete(sessionId);
  const s = sessions.get(sessionId);
  if (s) {
    try { s.sock?.end(); } catch {}
    sessions.delete(sessionId);
  }
  await fse.remove(authPath(sessionId));
  logger.info({ sessionId }, 'Sesión eliminada');
}

/**
 * Carga las sesiones existentes en auth/ al arrancar el proceso.
 */
export async function loadExistingSessions() {
  await fse.ensureDir(config.paths.auth);
  const entries = await fse.readdir(config.paths.auth, { withFileTypes: true });
  // Carpetas que no son sesiones (p. ej. _panel con los datos del panel) se ignoran.
  const dirs = entries.filter((e) => e.isDirectory() && isValidSessionId(e.name)).map((e) => e.name);

  if (dirs.length === 0) {
    logger.info('No hay sesiones previas. Creá una en GET /sessions/:id/qr');
    return;
  }

  logger.info({ sessions: dirs }, 'Cargando sesiones existentes...');
  for (const id of dirs) {
    await createSession(id);
  }
}

async function connect(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;

  // Cerrar socket anterior si existe para evitar conexiones duplicadas
  if (s.sock) {
    try { s.sock.end(); } catch {}
    s.sock = null;
  }

  const ap = authPath(sessionId);
  await fse.ensureDir(ap);

  const { state, saveCreds } = await useMultiFileAuthState(ap);
  const { version } = await fetchLatestBaileysVersion();

  logger.info({ sessionId, version }, 'Iniciando Baileys');

  const sock = makeWASocket({
    version,
    logger: baileysLogger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    printQRInTerminal: false,
    browser: ['Chrome (Linux)', 'Chrome', '124.0.6367.207'],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 30_000,
    keepAliveIntervalMs: 15_000,
    retryRequestDelayMs: 500,
  });

  s.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      if (!u.update?.status) continue;
      const status = { 2: 'enviado', 3: 'entregado', 4: 'leído' }[u.update.status];
      if (status) logger.info({ sessionId, jid: u.key.remoteJid, status }, `📬 Mensaje ${status}`);
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      s.qrDataUrl = await QRCode.toDataURL(qr);
      logger.info({ sessionId }, `⚡ QR listo — abrí /sessions/${sessionId}/qr en el navegador`);
    }

    if (connection === 'open') {
      s.isConnected = true;
      s.qrDataUrl = null;
      s.reconnectAttempts = 0;
      logger.info({ sessionId }, '✅ WhatsApp conectado');
      if (s.readyResolve) {
        s.readyResolve();
        s.readyResolve = null;
      }
    }

    if (connection === 'close') {
      s.isConnected = false;
      const boom = lastDisconnect?.error instanceof Boom ? lastDisconnect.error : null;
      const statusCode = boom?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn({ sessionId, statusCode, shouldReconnect }, 'Conexión cerrada');

      if (shouldReconnect) {
        await handleReconnect(sessionId);
      } else {
        logger.warn({ sessionId }, 'Logged out. Borrando auth y mostrando nuevo QR...');
        s.qrDataUrl = null;
        s.reconnectAttempts = 0;
        await fse.emptyDir(ap);
        // Esperar antes de reconectar para no ser detectado como bot
        await sleep(8000);
        await connect(sessionId);
      }
    }
  });
}

async function handleReconnect(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.reconnectAttempts++;

  if (s.reconnectAttempts > config.reconnect.maxAttempts) {
    logger.error({ sessionId }, 'Máximo de reintentos superado. Sesión eliminada.');
    sessions.delete(sessionId);
    return;
  }

  const delay = Math.min(
    config.reconnect.delayMs * Math.pow(2, s.reconnectAttempts - 1),
    60_000
  );

  logger.info({ sessionId, attempt: s.reconnectAttempts, delayMs: delay }, 'Reconectando...');
  await sleep(delay);
  await connect(sessionId);
}

// ─── Envío ───────────────────────────────────────────────────────────────────

export async function sendDocumentVia(sessionId, jid, fileBuffer, filename, caption, mimetype = 'application/pdf') {
  const s = sessions.get(sessionId);
  if (!s?.isConnected) throw new Error(`Sesión "${sessionId}" no está conectada`);
  logger.info({ sessionId, jid, filename }, 'Enviando documento');
  const result = await s.sock.sendMessage(jid, {
    document: fileBuffer,
    mimetype,
    fileName: filename,
    caption,
  });
  logger.info({ sessionId, jid, msgId: result?.key?.id, status: result?.status }, '✅ Documento enviado');
}

export async function sendImageVia(sessionId, jid, imageBuffer, mimetype, caption) {
  const s = sessions.get(sessionId);
  if (!s?.isConnected) throw new Error(`Sesión "${sessionId}" no está conectada`);
  logger.info({ sessionId, jid, mimetype }, 'Enviando imagen');
  const result = await s.sock.sendMessage(jid, { image: imageBuffer, mimetype, caption });
  logger.info({ sessionId, jid, msgId: result?.key?.id, status: result?.status }, '✅ Imagen enviada');
}

export async function sendTextVia(sessionId, jid, text) {
  const s = sessions.get(sessionId);
  if (!s?.isConnected) throw new Error(`Sesión "${sessionId}" no está conectada`);
  logger.info({ sessionId, jid }, 'Enviando texto');
  const result = await s.sock.sendMessage(jid, { text });
  logger.info({ sessionId, jid, msgId: result?.key?.id, status: result?.status }, '✅ Texto enviado');
}

// groupFetchAllParticipating es pesado y WhatsApp lo limita: se guarda 5 minutos.
const groupCache = new Map();
const GROUP_TTL = 5 * 60e3;

export async function listGroupsVia(sessionId, { fresh = false } = {}) {
  const s = sessions.get(sessionId);
  if (!s?.isConnected) {
    logger.warn({ sessionId }, 'No conectado. No se pueden listar grupos.');
    return [];
  }
  const cached = groupCache.get(sessionId);
  if (!fresh && cached && Date.now() - cached.at < GROUP_TTL) return cached.groups;

  const groups = await s.sock.groupFetchAllParticipating();
  const list = Object.values(groups)
    .map((g) => ({ id: g.id, name: g.subject || g.id, participants: g.participants?.length || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  groupCache.set(sessionId, { at: Date.now(), groups: list });
  return list;
}
