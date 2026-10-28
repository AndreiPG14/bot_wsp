/**
 * sendWhatsapp.js
 * Orquesta el envío de archivos a una lista de destinatarios via una sesión específica.
 */

import path from 'path';
import fse from 'fs-extra';
import logger from './logger.js';
import { sendDocumentVia, sendImageVia, sendTextVia } from './baileys.js';
import { toWhatsAppJid, sleep } from './utils.js';

export const IMAGE_MIMETYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Cola global para serializar todos los envíos y respetar el rate limit.
// La cadena de cola nunca queda en rejected — cada tarea mantiene su propio
// resultado/error independiente para que un fallo no bloquee las siguientes.
let sendQueue = Promise.resolve();
function enqueue(fn) {
  const task = sendQueue.then(fn);
  sendQueue = task.catch(() => {}); // mantiene la cola viva aunque fn falle
  return task;               // devuelve la promesa real con el resultado/error
}

// Delay con jitter humano: entre min y max ms
function humanDelay(minMs = 10000, maxMs = 15000) {
  return sleep(minMs + Math.floor(Math.random() * (maxMs - minMs)));
}

// Protección anti-ban: si fallan 3 mensajes seguidos, pausa 5 minutos
const CONSECUTIVE_FAIL_LIMIT = 3;
const PAUSE_MS = 5 * 60 * 1000;
let consecutiveFails = 0;
let pausedUntil = 0;

function checkPause() {
  if (Date.now() < pausedUntil) {
    const remaining = Math.ceil((pausedUntil - Date.now()) / 1000);
    logger.warn({ remainingSecs: remaining }, '⛔ Envío pausado por protección anti-ban');
    return true;
  }
  return false;
}

function recordSuccess() {
  consecutiveFails = 0;
}

function recordFail() {
  consecutiveFails++;
  if (consecutiveFails >= CONSECUTIVE_FAIL_LIMIT) {
    pausedUntil = Date.now() + PAUSE_MS;
    logger.error(
      { consecutiveFails, pauseMinutes: 5 },
      '🚨 3 fallos seguidos detectados — pausando envíos 5 minutos para evitar ban'
    );
    consecutiveFails = 0;
  }
}

/**
 * Convierte un destinatario a JID de WhatsApp.
 * Acepta:
 *   - Número de teléfono: "5491112345678" → "5491112345678@s.whatsapp.net"
 *   - JID de grupo:       "120363408590737180@g.us" → se usa tal cual
 *   - JID completo:       "5491112345678@s.whatsapp.net" → se usa tal cual
 */
export function resolveJid(recipient) {
  if (recipient.includes('@')) return recipient;
  return toWhatsAppJid(recipient);
}

/**
 * Envía un PDF a una lista de destinatarios via la sesión indicada.
 *
 * @param {string} sessionId
 * @param {string[]} recipients - Números o IDs de grupo
 * @param {string} filePath
 * @param {string} [caption]
 * @returns {Promise<{sent: number, failed: number, details: object[]}>}
 */
export async function sendPdf(sessionId, recipients, filePath, caption = '') {
  const filename = path.basename(filePath);
  let fileBuffer;
  try {
    fileBuffer = await fse.readFile(filePath);
  } catch (err) {
    logger.error({ filePath, err: err.message }, 'No se pudo leer el PDF');
    throw err;
  }

  const results = { sent: 0, failed: 0, details: [] };

  return enqueue(async () => {
    for (const recipient of recipients) {
      if (checkPause()) {
        results.failed += recipients.length - results.sent - results.failed;
        results.details.push({ recipient, ok: false, error: 'Envío pausado por protección anti-ban' });
        break;
      }
      const jid = resolveJid(recipient);
      try {
        await sendDocumentVia(sessionId, jid, fileBuffer, filename, caption);
        results.sent++;
        results.details.push({ recipient, jid, ok: true });
        recordSuccess();
        await humanDelay();
      } catch (err) {
        results.failed++;
        results.details.push({ recipient, jid, ok: false, error: err.message });
        logger.error({ sessionId, jid, err: err.message }, 'Error al enviar PDF');
        recordFail();
      }
    }
    logger.info(
      { sessionId, sent: results.sent, failed: results.failed },
      `Envío completado: ${results.sent} exitosos, ${results.failed} fallidos`
    );
    return results;
  });
}

/**
 * Envía un mensaje de texto a una lista de destinatarios via la sesión indicada.
 *
 * @param {string} sessionId
 * @param {string[]} recipients
 * @param {string} text
 * @returns {Promise<{sent: number, failed: number, details: object[]}>}
 */
export async function sendText(sessionId, recipients, text) {
  const results = { sent: 0, failed: 0, details: [] };

  return enqueue(async () => {
    for (const recipient of recipients) {
      if (checkPause()) {
        results.failed += recipients.length - results.sent - results.failed;
        results.details.push({ recipient, ok: false, error: 'Envío pausado por protección anti-ban' });
        break;
      }
      const jid = resolveJid(recipient);
      try {
        await sendTextVia(sessionId, jid, text);
        results.sent++;
        results.details.push({ recipient, jid, ok: true });
        recordSuccess();
        await humanDelay();
      } catch (err) {
        results.failed++;
        results.details.push({ recipient, jid, ok: false, error: err.message });
        logger.error({ sessionId, jid, err: err.message }, 'Error al enviar texto');
        recordFail();
      }
    }
    logger.info({ sessionId, sent: results.sent, failed: results.failed }, 'Envío de texto completado');
    return results;
  });
}

/**
 * Envía una imagen a una lista de destinatarios via la sesión indicada.
 *
 * @param {string} sessionId
 * @param {string[]} recipients
 * @param {string} filePath
 * @param {string} mimetype
 * @param {string} [caption]
 * @returns {Promise<{sent: number, failed: number, details: object[]}>}
 */
export async function sendImage(sessionId, recipients, filePath, mimetype, caption = '') {
  let fileBuffer;
  try {
    fileBuffer = await fse.readFile(filePath);
  } catch (err) {
    logger.error({ filePath, err: err.message }, 'No se pudo leer la imagen');
    throw err;
  }

  const results = { sent: 0, failed: 0, details: [] };

  return enqueue(async () => {
    for (const recipient of recipients) {
      if (checkPause()) {
        results.failed += recipients.length - results.sent - results.failed;
        results.details.push({ recipient, ok: false, error: 'Envío pausado por protección anti-ban' });
        break;
      }
      const jid = resolveJid(recipient);
      try {
        await sendImageVia(sessionId, jid, fileBuffer, mimetype, caption);
        results.sent++;
        results.details.push({ recipient, jid, ok: true });
        recordSuccess();
        await humanDelay();
      } catch (err) {
        results.failed++;
        results.details.push({ recipient, jid, ok: false, error: err.message });
        logger.error({ sessionId, jid, err: err.message }, 'Error al enviar imagen');
        recordFail();
      }
    }
    logger.info(
      { sessionId, sent: results.sent, failed: results.failed },
      `Envío completado: ${results.sent} exitosos, ${results.failed} fallidos`
    );
    return results;
  });
}
