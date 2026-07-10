/**
 * sendWhatsapp.js
 * Orquesta el envío de un PDF a todos los destinatarios configurados.
 *
 * Lee los números y grupos desde config y delega el envío a baileys.js.
 * Incluye manejo de errores por destinatario para que un fallo individual
 * no impida el envío al resto.
 */

import fse from 'fs-extra';
import path from 'path';
import config from './config.js';
import logger from './logger.js';
import { sendDocument, sendImage } from './baileys.js';

const IMAGE_MIMETYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
import { toWhatsAppJid, sleep } from './utils.js';

/**
 * Envía un PDF a todos los destinatarios (números individuales + grupos).
 *
 * @param {string} filePath - Ruta absoluta al archivo PDF en disco.
 * @param {string} [customCaption] - Caption opcional. Usa el de config si no se pasa.
 * @returns {Promise<{sent: number, failed: number}>} Resumen del envío.
 */
export async function sendPdfToAll(filePath, customCaption) {
  const caption = customCaption || config.whatsapp.caption;
  const filename = path.basename(filePath);

  if (config.whatsapp.numbers.length === 0 && config.whatsapp.groups.length === 0) {
    logger.warn(
      'No hay destinatarios configurados. Agrega WHATSAPP_NUMBERS o WHATSAPP_GROUPS al .env y reinicia el bot.'
    );
    return { sent: 0, failed: 0 };
  }

  logger.info(
    {
      filePath,
      filename,
      numbers: config.whatsapp.numbers.length,
      groups: config.whatsapp.groups.length,
    },
    'Iniciando envío de PDF a todos los destinatarios'
  );

  // Leer el archivo una sola vez para no hacer I/O por cada destinatario
  let fileBuffer;
  try {
    fileBuffer = await fse.readFile(filePath);
  } catch (err) {
    logger.error({ filePath, err: err.message }, 'No se pudo leer el archivo PDF');
    throw err;
  }

  const results = { sent: 0, failed: 0 };
  const allRecipients = buildRecipientList();

  for (const recipient of allRecipients) {
    try {
      await sendDocument(recipient.jid, fileBuffer, filename, caption);
      results.sent++;

      // Pausa entre envíos para evitar ban por spam
      await sleep(1500);
    } catch (err) {
      results.failed++;
      logger.error(
        { jid: recipient.jid, label: recipient.label, err: err.message },
        'Error al enviar a este destinatario'
      );
    }
  }

  logger.info(
    results,
    `Envío completado: ${results.sent} exitosos, ${results.failed} fallidos`
  );

  return results;
}

/**
 * Envía una imagen a todos los destinatarios (números individuales + grupos).
 *
 * @param {string} filePath - Ruta absoluta a la imagen en disco.
 * @param {string} mimetype - MIME type de la imagen.
 * @param {string} [customCaption] - Caption opcional.
 * @returns {Promise<{sent: number, failed: number}>}
 */
export async function sendImageToAll(filePath, mimetype, customCaption) {
  const caption = customCaption || config.whatsapp.caption;

  if (config.whatsapp.numbers.length === 0 && config.whatsapp.groups.length === 0) {
    logger.warn('No hay destinatarios configurados.');
    return { sent: 0, failed: 0 };
  }

  logger.info({ filePath, mimetype }, 'Iniciando envío de imagen a todos los destinatarios');

  let fileBuffer;
  try {
    fileBuffer = await fse.readFile(filePath);
  } catch (err) {
    logger.error({ filePath, err: err.message }, 'No se pudo leer la imagen');
    throw err;
  }

  const results = { sent: 0, failed: 0 };
  const allRecipients = buildRecipientList();

  for (const recipient of allRecipients) {
    try {
      await sendImage(recipient.jid, fileBuffer, mimetype, caption);
      results.sent++;
      await sleep(1500);
    } catch (err) {
      results.failed++;
      logger.error({ jid: recipient.jid, err: err.message }, 'Error al enviar imagen');
    }
  }

  logger.info(results, `Envío completado: ${results.sent} exitosos, ${results.failed} fallidos`);
  return results;
}

export { IMAGE_MIMETYPES };

/**
 * Construye la lista unificada de destinatarios (números + grupos).
 * @returns {{ jid: string, label: string, type: 'number'|'group' }[]}
 */
function buildRecipientList() {
  const recipients = [];

  // Números individuales
  for (const number of config.whatsapp.numbers) {
    if (!number) continue;
    const jid = toWhatsAppJid(number);
    recipients.push({ jid, label: number, type: 'number' });
  }

  // Grupos (ya tienen formato @g.us)
  for (const groupId of config.whatsapp.groups) {
    if (!groupId) continue;
    // Asegurarse de que tiene el sufijo correcto
    const jid = groupId.includes('@g.us') ? groupId : `${groupId}@g.us`;
    recipients.push({ jid, label: groupId, type: 'group' });
  }

  logger.debug(
    { total: recipients.length, recipients: recipients.map((r) => r.label) },
    'Lista de destinatarios construida'
  );

  return recipients;
}