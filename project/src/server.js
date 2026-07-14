/**
 * server.js
 * Reemplaza el IMAP. Expone endpoints HTTP para recibir PDFs
 * directamente desde Power Automate y enviarlos por WhatsApp.
 *
 * Endpoints:
 *   GET  /health        → estado del bot
 *   GET  /groups        → lista grupos de WhatsApp disponibles
 *   POST /send          → recibe PDF en base64 y lo envía por WhatsApp
 */

import express from 'express';
import path from 'path';
import fse from 'fs-extra';
import config from './config.js';
import logger from './logger.js';
import { getConnectionStatus, listGroups } from './baileys.js';
import { sendPdfToAll, sendImageToAll, IMAGE_MIMETYPES } from './sendWhatsapp.js';
import { generateSafeFilename, removeFile } from './utils.js';

const app = express();

// Aumentar límite para recibir PDFs grandes en base64 (50MB)
app.use(express.json({ limit: '50mb' }));

// ─── GET /health ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  const wa = getConnectionStatus();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    whatsapp: wa,
  });
});

// ─── GET /groups ──────────────────────────────────────────────────────────────

app.get('/groups', async (req, res) => {
  try {
    const groups = await listGroups();
    res.json({ groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /send ───────────────────────────────────────────────────────────────
//
// Body JSON esperado desde Power Automate:
// {
//   "filename": "reporte_enero.pdf",       ← nombre del archivo (opcional)
//   "fileContent": "<base64 del PDF>",     ← contenido en base64
//   "caption": "Reporte enero 2025"        ← mensaje opcional
// }

app.post('/send', async (req, res) => {
  const { filename, fileContent, caption } = req.body;

  // Validar que llegó el contenido
  if (!fileContent) {
    logger.warn('POST /send recibido sin fileContent');
    return res.status(400).json({ error: 'El campo fileContent es requerido (PDF en base64)' });
  }

  logger.info({ filename }, '📨 PDF recibido desde Power Automate');

  let filePath = null;

  try {
    // Decodificar base64 a Buffer
    const buffer = Buffer.from(fileContent, 'base64');

    // Guardar temporalmente en disco
    const safeName = generateSafeFilename(filename || 'reporte.pdf');
    filePath = path.join(config.paths.attachments, safeName);
    await fse.ensureDir(config.paths.attachments);
    await fse.writeFile(filePath, buffer);

    logger.info({ filePath, sizeKB: Math.round(buffer.length / 1024) }, 'PDF guardado temporalmente');

    // Enviar por WhatsApp
    const result = await sendPdfToAll(filePath, caption);

    res.json({
      success: true,
      whatsapp: result,
      filename: safeName,
    });

  } catch (err) {
    logger.error({ err: err.message }, 'Error al procesar PDF recibido');
    res.status(500).json({ error: err.message });
  } finally {
    // Siempre limpiar el archivo temporal
    if (filePath) await removeFile(filePath);
  }
});

// ─── POST /send-image ─────────────────────────────────────────────────────────
//
// Body JSON:
// {
//   "filename": "foto.jpg",              ← nombre del archivo (opcional, para detectar mimetype)
//   "fileContent": "<base64 imagen>",    ← contenido en base64
//   "mimetype": "image/jpeg",            ← opcional, se deduce del filename si no se pasa
//   "caption": "Texto del mensaje"       ← mensaje opcional
// }

app.post('/send-image', async (req, res) => {
  const { filename, fileContent, mimetype: mimetypeParam, caption } = req.body;

  if (!fileContent) {
    return res.status(400).json({ error: 'El campo fileContent es requerido (imagen en base64)' });
  }

  // Detectar mimetype por extensión si no viene explícito
  const ext = (filename || '').split('.').pop().toLowerCase();
  const extMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
  const mimetype = mimetypeParam || extMap[ext] || 'image/jpeg';

  if (!IMAGE_MIMETYPES.has(mimetype)) {
    return res.status(400).json({ error: `Mimetype no soportado: ${mimetype}. Usa jpeg, png, gif o webp.` });
  }

  logger.info({ filename, mimetype }, '🖼️ Imagen recibida');

  let filePath = null;

  try {
    const buffer = Buffer.from(fileContent, 'base64');
    const safeName = generateSafeFilename(filename || `imagen.${ext || 'jpg'}`);
    filePath = path.join(config.paths.attachments, safeName);
    await fse.ensureDir(config.paths.attachments);
    await fse.writeFile(filePath, buffer);

    const result = await sendImageToAll(filePath, mimetype, caption);

    res.json({ success: true, whatsapp: result, filename: safeName });
  } catch (err) {
    logger.error({ err: err.message }, 'Error al procesar imagen');
    res.status(500).json({ error: err.message });
  } finally {
    if (filePath) await removeFile(filePath);
  }
});

// ─── Iniciar servidor ─────────────────────────────────────────────────────────

export function startServer() {
  return new Promise((resolve) => {
    app.listen(config.port, () => {
      logger.info({ port: config.port }, `Servidor HTTP iniciado — esperando PDFs en POST /send`);
      resolve();
    });
  });
}