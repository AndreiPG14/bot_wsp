/**
 * server.js
 * Endpoints HTTP para gestionar sesiones de WhatsApp y enviar archivos.
 *
 * Sesiones:
 *   GET  /sessions                  → lista todas las sesiones y su estado
 *   GET  /sessions/:id/qr           → muestra el QR de una sesión (la crea si no existe)
 *   DELETE /sessions/:id            → elimina una sesión y borra sus credenciales
 *   GET  /sessions/:id/groups       → lista los grupos de una sesión
 *
 * Envío:
 *   POST /send                      → envía PDF
 *   POST /send-image                → envía imagen
 *
 * Otros:
 *   GET  /health                    → estado general del bot
 */

import express from 'express';
import path from 'path';
import fse from 'fs-extra';
import config from './config.js';
import logger from './logger.js';
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  getFirstConnectedSession,
  listGroupsVia,
} from './baileys.js';
import { sendPdf, sendImage, IMAGE_MIMETYPES } from './sendWhatsapp.js';
import { generateSafeFilename, removeFile } from './utils.js';

const app = express();
app.use(express.json({ limit: '50mb' }));

// ─── GET /sessions ────────────────────────────────────────────────────────────

app.get('/sessions', (req, res) => {
  res.json({ sessions: listSessions() });
});

// ─── GET /sessions/:id/qr ─────────────────────────────────────────────────────

app.get('/sessions/:id/qr', async (req, res) => {
  const { id } = req.params;

  // Crear sesión si no existe
  if (!getSession(id)) {
    logger.info({ sessionId: id }, 'Creando nueva sesión...');
    createSession(id).catch((err) =>
      logger.error({ sessionId: id, err: err.message }, 'Error al crear sesión')
    );
  }

  const s = getSession(id);

  if (s?.isConnected) {
    return res.send(`<h2>✅ Sesión <b>${id}</b> ya está conectada</h2>`);
  }

  if (!s?.qrDataUrl) {
    return res.send(
      `<h2>⏳ Esperando QR para <b>${id}</b>... recargá en unos segundos</h2>` +
      `<script>setTimeout(()=>location.reload(),3000)</script>`
    );
  }

  res.send(`<!DOCTYPE html><html><body style="display:flex;flex-direction:column;align-items:center;font-family:sans-serif;padding:40px">
    <h2>Sesión: <b>${id}</b></h2>
    <p>Escaneá con WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
    <img src="${s.qrDataUrl}" style="width:300px;height:300px"/>
    <script>setTimeout(()=>location.reload(),30000)</script>
  </body></html>`);
});

// ─── DELETE /sessions/:id ─────────────────────────────────────────────────────

app.delete('/sessions/:id', async (req, res) => {
  const { id } = req.params;
  await deleteSession(id);
  res.json({ success: true, message: `Sesión "${id}" eliminada` });
});

// ─── GET /sessions/:id/groups ─────────────────────────────────────────────────

app.get('/sessions/:id/groups', async (req, res) => {
  const { id } = req.params;
  try {
    const groups = await listGroupsVia(id);
    res.json({ sessionId: id, groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /send ───────────────────────────────────────────────────────────────
//
// Body:
// {
//   "from": "mi-sesion",                          ← sessionId (opcional si hay una sola sesión conectada)
//   "to": ["5491112345678", "120363...@g.us"],    ← números y/o IDs de grupo
//   "filename": "reporte.pdf",
//   "fileContent": "<base64>",
//   "caption": "Reporte Power BI"
// }

app.post('/send', async (req, res) => {
  const { from, to, filename, fileContent, caption } = req.body;

  if (!fileContent) {
    return res.status(400).json({ error: 'El campo fileContent es requerido (PDF en base64)' });
  }

  const sessionId = from || getFirstConnectedSession();
  if (!sessionId) {
    return res.status(503).json({ error: 'No hay sesiones conectadas. Escaneá un QR en /sessions/:id/qr' });
  }

  const recipients = normalizeRecipients(to);
  if (recipients.length === 0) {
    return res.status(400).json({ error: 'El campo "to" debe tener al menos un destinatario (número o ID de grupo)' });
  }

  logger.info({ sessionId, recipients, filename }, '📨 PDF recibido');

  let filePath = null;
  try {
    const buffer = Buffer.from(fileContent, 'base64');
    const safeName = generateSafeFilename(filename || 'reporte.pdf');
    filePath = path.join(config.paths.attachments, safeName);
    await fse.ensureDir(config.paths.attachments);
    await fse.writeFile(filePath, buffer);

    const result = await sendPdf(sessionId, recipients, filePath, caption);
    res.json({ success: true, sessionId, whatsapp: result });
  } catch (err) {
    logger.error({ err: err.message }, 'Error al procesar /send');
    res.status(500).json({ error: err.message });
  } finally {
    if (filePath) await removeFile(filePath);
  }
});

// ─── POST /send-image ─────────────────────────────────────────────────────────
//
// Body:
// {
//   "from": "mi-sesion",
//   "to": ["5491112345678", "120363...@g.us"],
//   "filename": "foto.png",
//   "fileContent": "<base64>",
//   "mimetype": "image/png",                      ← opcional, se deduce del filename
//   "caption": "Texto"
// }

app.post('/send-image', async (req, res) => {
  const { from, to, filename, fileContent, mimetype: mimetypeParam, caption } = req.body;

  if (!fileContent) {
    return res.status(400).json({ error: 'El campo fileContent es requerido (imagen en base64)' });
  }

  const sessionId = from || getFirstConnectedSession();
  if (!sessionId) {
    return res.status(503).json({ error: 'No hay sesiones conectadas. Escaneá un QR en /sessions/:id/qr' });
  }

  const recipients = normalizeRecipients(to);
  if (recipients.length === 0) {
    return res.status(400).json({ error: 'El campo "to" debe tener al menos un destinatario' });
  }

  const ext = (filename || '').split('.').pop().toLowerCase();
  const extMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
  const mimetype = mimetypeParam || extMap[ext] || 'image/jpeg';

  if (!IMAGE_MIMETYPES.has(mimetype)) {
    return res.status(400).json({ error: `Mimetype no soportado: ${mimetype}` });
  }

  logger.info({ sessionId, recipients, filename, mimetype }, '🖼️ Imagen recibida');

  let filePath = null;
  try {
    const buffer = Buffer.from(fileContent, 'base64');
    const safeName = generateSafeFilename(filename || `imagen.${ext || 'jpg'}`);
    filePath = path.join(config.paths.attachments, safeName);
    await fse.ensureDir(config.paths.attachments);
    await fse.writeFile(filePath, buffer);

    const result = await sendImage(sessionId, recipients, filePath, mimetype, caption);
    res.json({ success: true, sessionId, whatsapp: result });
  } catch (err) {
    logger.error({ err: err.message }, 'Error al procesar /send-image');
    res.status(500).json({ error: err.message });
  } finally {
    if (filePath) await removeFile(filePath);
  }
});

// ─── GET /health ──────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    sessions: listSessions(),
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normaliza el campo "to" a un array de strings.
 * Acepta string, array de strings, o undefined.
 */
function normalizeRecipients(to) {
  if (!to) return [];
  if (Array.isArray(to)) return to.map(String).filter(Boolean);
  return String(to).split(',').map((s) => s.trim()).filter(Boolean);
}

// ─── Iniciar servidor ─────────────────────────────────────────────────────────

export function startServer() {
  return new Promise((resolve) => {
    app.listen(config.port, () => {
      logger.info({ port: config.port }, 'Servidor HTTP iniciado — esperando PDFs en POST /send');
      resolve();
    });
  });
}
