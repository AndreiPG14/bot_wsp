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

function authPath(sessionId) {
  return path.join(config.paths.auth, sessionId);
}

export function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

export function listSessions() {
  return Array.from(sessions.entries()).map(([id, s]) => ({
    id,
    connected: s.isConnected,
    hasQr: !!s.qrDataUrl,
    reconnectAttempts: s.reconnectAttempts,
  }));
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
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

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
    browser: ['PowerBI Bot', 'Chrome', '120.0.0'],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 30_000,
    keepAliveIntervalMs: 15_000,
    retryRequestDelayMs: 500,
  });

  s.sock = sock;
  sock.ev.on('creds.update', saveCreds);

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

export async function sendDocumentVia(sessionId, jid, fileBuffer, filename, caption) {
  const s = sessions.get(sessionId);
  if (!s?.isConnected) throw new Error(`Sesión "${sessionId}" no está conectada`);
  logger.info({ sessionId, jid, filename }, 'Enviando documento');
  await s.sock.sendMessage(jid, {
    document: fileBuffer,
    mimetype: 'application/pdf',
    fileName: filename,
    caption,
  });
  logger.info({ sessionId, jid }, '✅ Documento enviado');
}

export async function sendImageVia(sessionId, jid, imageBuffer, mimetype, caption) {
  const s = sessions.get(sessionId);
  if (!s?.isConnected) throw new Error(`Sesión "${sessionId}" no está conectada`);
  logger.info({ sessionId, jid, mimetype }, 'Enviando imagen');
  await s.sock.sendMessage(jid, { image: imageBuffer, mimetype, caption });
  logger.info({ sessionId, jid }, '✅ Imagen enviada');
}

export async function listGroupsVia(sessionId) {
  const s = sessions.get(sessionId);
  if (!s?.isConnected) {
    logger.warn({ sessionId }, 'No conectado. No se pueden listar grupos.');
    return [];
  }
  const groups = await s.sock.groupFetchAllParticipating();
  return Object.values(groups).map((g) => ({
    id: g.id,
    name: g.subject,
    participants: g.participants?.length || 0,
  }));
}
