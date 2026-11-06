/**
 * sendWhatsapp.js
 * Orquesta el envío de archivos a una lista de destinatarios via una sesión específica.
 * Todos los envíos pasan por una sola cola con pausas "humanas" y protección anti-ban.
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

/** Estado de la protección anti-ban, para mostrarlo en el panel. */
export function sendStatus() {
  return { pausedUntil: pausedUntil > Date.now() ? new Date(pausedUntil).toISOString() : null };
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
 * Recorre los destinatarios dentro de la cola, aplicando pausas y anti-ban.
 * @param {(jid: string) => Promise<void>} sendOne
 */
function sendToAll(sessionId, recipients, sendOne, label) {
  const results = { sent: 0, failed: 0, details: [] };

  return enqueue(async () => {
    for (const recipient of recipients) {
      if (checkPause()) {
        const pending = recipients.slice(results.sent + results.failed);
        for (const r of pending) results.details.push({ recipient: r, ok: false, error: 'Envío pausado por protección anti-ban' });
        results.failed += pending.length;
        break;
      }
      const jid = resolveJid(recipient);
      try {
        await sendOne(jid);
        results.sent++;
        results.details.push({ recipient, jid, ok: true });
        recordSuccess();
        await humanDelay();
      } catch (err) {
        results.failed++;
        results.details.push({ recipient, jid, ok: false, error: err.message });
        logger.error({ sessionId, jid, err: err.message }, `Error al enviar ${label}`);
        recordFail();
      }
    }
    logger.info(
      { sessionId, sent: results.sent, failed: results.failed },
      `Envío de ${label} completado: ${results.sent} exitosos, ${results.failed} fallidos`
    );
    return results;
  });
}

async function readFileOrThrow(filePath, label) {
  try {
    return await fse.readFile(filePath);
  } catch (err) {
    logger.error({ filePath, err: err.message }, `No se pudo leer ${label}`);
    throw err;
  }
}

/**
 * Envía un PDF a una lista de destinatarios via la sesión indicada.
 * @returns {Promise<{sent: number, failed: number, details: object[]}>}
 */
export async function sendPdf(sessionId, recipients, filePath, caption = '') {
  const filename = path.basename(filePath);
  const buffer = await readFileOrThrow(filePath, 'el PDF');
  return sendToAll(sessionId, recipients, (jid) => sendDocumentVia(sessionId, jid, buffer, filename, caption), 'PDF');
}

/**
 * Envía un mensaje de texto a una lista de destinatarios via la sesión indicada.
 */
export async function sendText(sessionId, recipients, text) {
  return sendToAll(sessionId, recipients, (jid) => sendTextVia(sessionId, jid, text), 'texto');
}

/**
 * Envía una imagen a una lista de destinatarios via la sesión indicada.
 */
export async function sendImage(sessionId, recipients, filePath, mimetype, caption = '') {
  const buffer = await readFileOrThrow(filePath, 'la imagen');
  return sendToAll(sessionId, recipients, (jid) => sendImageVia(sessionId, jid, buffer, mimetype, caption), 'imagen');
}

/**
 * Envía un mensaje con varios archivos (o solo texto) a cada destinatario.
 * El texto va como pie del primer archivo; si no hay archivos, se envía como mensaje.
 *
 * @param {{buffer: Buffer, filename: string, mimetype: string}[]} files
 */
export async function sendFiles(sessionId, recipients, files, text = '') {
  if (!files.length && !text.trim()) throw new Error('No hay nada que enviar: ni archivos ni mensaje');

  return sendToAll(sessionId, recipients, async (jid) => {
    if (!files.length) return sendTextVia(sessionId, jid, text);
    for (const [i, f] of files.entries()) {
      const caption = i === 0 ? text : '';
      if (IMAGE_MIMETYPES.has(f.mimetype)) await sendImageVia(sessionId, jid, f.buffer, f.mimetype, caption);
      else await sendDocumentVia(sessionId, jid, f.buffer, f.filename, caption, f.mimetype);
      if (i < files.length - 1) await humanDelay(2000, 4000);
    }
  }, 'reporte');
}
