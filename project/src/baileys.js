/**
 * baileys.js
 * Gestiona la conexión a WhatsApp usando @whiskeysockets/baileys.
 *
 * Responsabilidades:
 * - Iniciar y mantener la sesión de WhatsApp.
 * - Persistir credenciales en la carpeta auth/.
 * - Reconectar automáticamente ante desconexiones.
 * - Mostrar QR en consola cuando sea necesario.
 * - Exponer una función sendDocument() para enviar PDFs.
 */

import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidGroup,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import fse from 'fs-extra';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import config from './config.js';
import logger from './logger.js';
import { sleep } from './utils.js';

// Logger silencioso para Baileys (evita flood de logs internos)
const baileysLogger = pino({ level: 'silent' });

let sock = null;
let isConnected = false;
let reconnectAttempts = 0;
let connectionResolve = null;

// Promesa que se resuelve cuando WhatsApp está listo para enviar mensajes
let connectionReadyPromise = null;

/**
 * Inicializa la conexión de WhatsApp.
 * Retorna una promesa que se resuelve cuando la sesión está lista.
 */
export async function initWhatsApp() {
  connectionReadyPromise = new Promise((resolve) => {
    connectionResolve = resolve;
  });

  await connect();

  return connectionReadyPromise;
}

/**
 * Función interna de conexión. Se llama también en reconexiones.
 */
async function connect() {
  await fse.ensureDir(config.paths.auth);

  const { state, saveCreds } = await useMultiFileAuthState(config.paths.auth);
  const { version } = await fetchLatestBaileysVersion();

  logger.info({ version }, 'Iniciando Baileys con versión de WhatsApp Web');

  sock = makeWASocket({
    version,
    logger: baileysLogger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    printQRInTerminal: false, // Lo manejamos manualmente
    browser: ['PowerBI Bot', 'Chrome', '120.0.0'],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 30_000,
    keepAliveIntervalMs: 15_000,
    retryRequestDelayMs: 500,
  });

  // Guardar credenciales cuando cambien
  sock.ev.on('creds.update', saveCreds);

  // Manejar actualizaciones de conexión
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Mostrar QR cuando sea necesario
    if (qr) {
      logger.info('⚡ Escanea el código QR con tu WhatsApp para iniciar sesión:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      isConnected = true;
      reconnectAttempts = 0;
      logger.info('✅ WhatsApp conectado exitosamente');

      // Resolver la promesa de conexión lista
      if (connectionResolve) {
        connectionResolve();
        connectionResolve = null;
      }
    }

    if (connection === 'close') {
      isConnected = false;
      const boom = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error
        : null;
      const statusCode = boom?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn(
        { statusCode, shouldReconnect },
        'Conexión de WhatsApp cerrada'
      );

      if (shouldReconnect) {
        await handleReconnect();
      } else {
        logger.error(
          'Sesión cerrada (logged out). Elimina la carpeta auth/ y reinicia para escanear QR nuevamente.'
        );
        process.exit(1);
      }
    }
  });
}

/**
 * Maneja la lógica de reconexión con backoff exponencial.
 */
async function handleReconnect() {
  reconnectAttempts++;

  if (reconnectAttempts > config.reconnect.maxAttempts) {
    logger.error(
      { maxAttempts: config.reconnect.maxAttempts },
      'Se superó el máximo de reintentos de reconexión. Reiniciando proceso...'
    );
    process.exit(1);
  }

  const delay = Math.min(
    config.reconnect.delayMs * Math.pow(2, reconnectAttempts - 1),
    60_000
  );

  logger.info(
    { attempt: reconnectAttempts, delayMs: delay },
    'Reconectando WhatsApp...'
  );

  await sleep(delay);
  await connect();
}

/**
 * Envía un documento PDF a un JID de WhatsApp.
 * @param {string} jid - ID del destinatario (número@s.whatsapp.net o grupo@g.us)
 * @param {Buffer} fileBuffer - Buffer del archivo PDF.
 * @param {string} filename - Nombre del archivo para mostrar.
 * @param {string} caption - Texto que acompaña el documento.
 */
export async function sendDocument(jid, fileBuffer, filename, caption) {
  if (!sock || !isConnected) {
    throw new Error('WhatsApp no está conectado. No se puede enviar el documento.');
  }

  logger.info({ jid, filename, sizeBytes: fileBuffer.length }, 'Enviando documento por WhatsApp');

  await sock.sendMessage(jid, {
    document: fileBuffer,
    mimetype: 'application/pdf',
    fileName: filename,
    caption: caption,
  });

  logger.info({ jid, filename }, '✅ Documento enviado exitosamente');
}

/**
 * Envía una imagen a un JID de WhatsApp.
 * @param {string} jid - ID del destinatario (número@s.whatsapp.net o grupo@g.us)
 * @param {Buffer} imageBuffer - Buffer de la imagen.
 * @param {string} mimetype - MIME type (image/jpeg, image/png, etc.)
 * @param {string} caption - Texto que acompaña la imagen.
 */
export async function sendImage(jid, imageBuffer, mimetype, caption) {
  if (!sock || !isConnected) {
    throw new Error('WhatsApp no está conectado. No se puede enviar la imagen.');
  }

  logger.info({ jid, mimetype, sizeBytes: imageBuffer.length }, 'Enviando imagen por WhatsApp');

  await sock.sendMessage(jid, {
    image: imageBuffer,
    mimetype,
    caption: caption,
  });

  logger.info({ jid }, '✅ Imagen enviada exitosamente');
}

/**
 * Retorna si WhatsApp está actualmente conectado.
 */
export function getConnectionStatus() {
  return {
    connected: isConnected,
    reconnectAttempts,
  };
}

/**
 * Obtiene todos los grupos a los que pertenece el bot.
 * Útil para descubrir los IDs de grupo (@g.us).
 */
export async function listGroups() {
  if (!sock || !isConnected) {
    logger.warn('WhatsApp no conectado. No se pueden listar grupos.');
    return [];
  }

  const groups = await sock.groupFetchAllParticipating();
  const list = Object.values(groups).map((g) => ({
    id: g.id,
    name: g.subject,
    participants: g.participants?.length || 0,
  }));

  logger.info({ total: list.length }, 'Grupos disponibles:');
  list.forEach((g) => {
    logger.info(`  📱 [${g.id}] ${g.name} (${g.participants} participantes)`);
  });

  return list;
}
