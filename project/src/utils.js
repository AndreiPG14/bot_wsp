/**
 * utils.js
 * Funciones de utilidad general compartidas por el resto de módulos.
 */

import path from 'path';
import crypto from 'crypto';
import fse from 'fs-extra';
import mime from 'mime-types';
import logger from './logger.js';

/**
 * Genera un nombre de archivo único basado en timestamp + UUID corto.
 * @param {string} originalName - Nombre original del adjunto.
 * @returns {string} Nombre de archivo seguro y único.
 */
export function generateSafeFilename(originalName) {
  const ext = path.extname(originalName) || '.pdf';
  const base = path
    .basename(originalName, ext)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 50);
  const uid = crypto.randomBytes(4).toString('hex');
  const ts = Date.now();
  return `${base}_${ts}_${uid}${ext}`;
}

/**
 * Guarda un Buffer como archivo en el directorio dado.
 * @param {Buffer} buffer - Contenido del archivo.
 * @param {string} filename - Nombre del archivo destino.
 * @param {string} dir - Directorio donde guardar.
 * @returns {Promise<string>} Ruta absoluta del archivo guardado.
 */
export async function saveAttachment(buffer, filename, dir) {
  await fse.ensureDir(dir);
  const filePath = path.join(dir, filename);
  await fse.writeFile(filePath, buffer);
  logger.debug({ filePath, sizeBytes: buffer.length }, 'Adjunto guardado');
  return filePath;
}

/**
 * Elimina un archivo de forma segura (sin lanzar error si no existe).
 * @param {string} filePath - Ruta al archivo a eliminar.
 */
export async function removeFile(filePath) {
  try {
    await fse.remove(filePath);
    logger.debug({ filePath }, 'Archivo temporal eliminado');
  } catch (err) {
    logger.warn({ filePath, err: err.message }, 'No se pudo eliminar el archivo temporal');
  }
}

/**
 * Detecta si un adjunto es un PDF válido basándose en su mimetype o nombre.
 * @param {string} filename - Nombre del archivo.
 * @param {string} contentType - MIME type reportado por el correo.
 * @returns {boolean}
 */
export function isPdf(filename, contentType) {
  const mimeFromName = mime.lookup(filename);
  const isPdfMime =
    contentType === 'application/pdf' ||
    mimeFromName === 'application/pdf';
  return isPdfMime;
}

/**
 * Espera un tiempo determinado.
 * @param {number} ms - Milisegundos a esperar.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Formatea un número de WhatsApp al formato JID esperado por Baileys.
 * El número debe contener el código de país sin el signo +.
 * @param {string} number - Número de teléfono.
 * @returns {string} JID de WhatsApp.
 */
export function toWhatsAppJid(number) {
  const clean = number.replace(/\D/g, '');
  return `${clean}@s.whatsapp.net`;
}

/**
 * Formatea bytes a un string legible.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
