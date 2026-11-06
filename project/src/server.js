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
 * Envío (API key si API_KEY está definido):
 *   POST /send                      → envía PDF
 *   POST /send-image                → envía imagen
 *   POST /send-text                 → envía texto
 *   POST /hooks/:token              → dispara una programación de tipo webhook
 *
 * Panel:
 *   GET  /                          → panel web (public/)
 *   /api/*                          → API del panel (ver panelApi.js)
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
  isValidSessionId,
} from './baileys.js';
import { sendPdf, sendImage, sendText, IMAGE_MIMETYPES } from './sendWhatsapp.js';
import { generateSafeFilename, removeFile } from './utils.js';
import { requireApiKey, requirePanelOrKey } from './auth.js';
import panelApi from './panelApi.js';
import { isRunning, runSchedule, trackApiSend } from './scheduler.js';
import { getScheduleByToken } from './store.js';
import { MAX_BYTES } from './sources.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '50mb' }));

// ─── Panel web ────────────────────────────────────────────────────────────────

app.use('/api', panelApi);
app.use(express.static(config.paths.public, {
  index: 'index.html',
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'");
  },
}));

// ─── POST /hooks/:token ───────────────────────────────────────────────────────
//
// Dispara una programación de tipo "webhook". Acepta:
//   - Cuerpo vacío                      → usa el origen configurado (URL, correo, archivo…)
//   - JSON { fileContent (base64), filename, text }
//   - El archivo directo en el cuerpo   (Content-Type: application/pdf, image/png, …)
//     con ?filename=reporte.pdf opcional

app.post('/hooks/:token', express.raw({ type: (req) => !req.is('application/json'), limit: MAX_BYTES }), async (req, res) => {
  const s = getScheduleByToken(req.params.token);
  if (!s) return res.status(404).json({ error: 'Webhook no encontrado' });
  if (!s.enabled) return res.status(409).json({ error: 'La programación está pausada' });
  if (isRunning(s.id)) return res.status(409).json({ error: 'Ya se está enviando' });

  let payload;
  const ctype = String(req.headers['content-type'] || '').split(';')[0];
  if (Buffer.isBuffer(req.body) && req.body.length) {
    const filename = String(req.query.filename || `reporte.${ctype.split('/')[1] || 'bin'}`).replace(/[\\/:*?"<>|]/g, '_');
    payload = { files: [{ buffer: req.body, filename, mimetype: ctype || 'application/octet-stream' }], text: '' };
  } else if (req.body && (req.body.fileContent || req.body.text)) {
    const files = [];
    if (req.body.fileContent) {
      const filename = String(req.body.filename || 'reporte.pdf').replace(/[\\/:*?"<>|]/g, '_');
      const ext = filename.split('.').pop().toLowerCase();
      const map = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv' };
      files.push({ buffer: Buffer.from(req.body.fileContent, 'base64'), filename, mimetype: req.body.mimetype || map[ext] || 'application/octet-stream' });
    }
    payload = { files, text: String(req.body.text || '').slice(0, 3000) };
  }

  runSchedule(s.id, { origin: 'webhook', payload }).catch((err) => logger.error({ err: err.message }, 'Error en webhook'));
  res.status(202).json({ ok: true, message: `Envío "${s.name}" en proceso` });
});

// ─── Rutas antiguas de sesiones (panel o API key) ─────────────────────────────

app.use('/sessions/:id', (req, res, next) => {
  if (!isValidSessionId(req.params.id)) return res.status(400).json({ error: 'Nombre de sesión no válido' });
  next();
});
app.use(['/sessions', '/check-numbers'], requirePanelOrKey);
app.use(['/send', '/send-image', '/send-text'], requireApiKey);

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

  // Responder inmediatamente para evitar timeout del caller y reintentos duplicados
  res.status(202).json({ success: true, message: 'Envío en proceso', sessionId, recipients: recipients.length });

  // Procesar en background
  (async () => {
    let filePath = null;
    try {
      const buffer = Buffer.from(fileContent, 'base64');
      const safeName = generateSafeFilename(filename || 'reporte.pdf');
      filePath = path.join(config.paths.attachments, safeName);
      await fse.ensureDir(config.paths.attachments);
      await fse.writeFile(filePath, buffer);
      await trackApiSend(
        { name: caption || filename || 'PDF por API', session: sessionId, recipients, files: [filename || 'reporte.pdf'] },
        sendPdf(sessionId, recipients, filePath, caption)
      );
    } catch (err) {
      logger.error({ err: err.message }, 'Error al procesar /send');
    } finally {
      if (filePath) await removeFile(filePath);
    }
  })();
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

  if (!fileContent && !caption) {
    return res.status(400).json({ error: 'Se requiere fileContent (imagen) o caption (texto)' });
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

  logger.info({ sessionId, recipients, filename, mimetype, hasFile: !!fileContent }, '🖼️ Imagen recibida');

  // Responder inmediatamente para evitar timeout del caller y reintentos duplicados
  res.status(202).json({ success: true, message: 'Envío en proceso', sessionId, recipients: recipients.length });

  // Procesar en background
  (async () => {
    if (!fileContent) {
      try {
        await trackApiSend({ name: 'Mensaje por API', session: sessionId, recipients, files: [] }, sendText(sessionId, recipients, caption));
      } catch (err) {
        logger.error({ err: err.message }, 'Error al enviar texto en /send-image');
      }
      return;
    }

    let filePath = null;
    try {
      const buffer = Buffer.from(fileContent, 'base64');
      const safeName = generateSafeFilename(filename || `imagen.${ext || 'jpg'}`);
      filePath = path.join(config.paths.attachments, safeName);
      await fse.ensureDir(config.paths.attachments);
      await fse.writeFile(filePath, buffer);
      await trackApiSend(
        { name: caption || filename || 'Imagen por API', session: sessionId, recipients, files: [filename || 'imagen'] },
        sendImage(sessionId, recipients, filePath, mimetype, caption)
      );
    } catch (err) {
      logger.error({ err: err.message }, 'Error al procesar /send-image');
    } finally {
      if (filePath) await removeFile(filePath);
    }
  })();
});

// ─── POST /send-text ──────────────────────────────────────────────────────────
//
// Body:
// {
//   "from": "mi-sesion",
//   "to": ["5491112345678", "120363...@g.us"],
//   "text": "Hola! Este es un mensaje de texto"
// }

app.post('/send-text', async (req, res) => {
  const { from, to, text } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'El campo text es requerido' });
  }

  const sessionId = from || getFirstConnectedSession();
  if (!sessionId) {
    return res.status(503).json({ error: 'No hay sesiones conectadas. Escaneá un QR en /sessions/:id/qr' });
  }

  const recipients = normalizeRecipients(to);
  if (recipients.length === 0) {
    return res.status(400).json({ error: 'El campo "to" debe tener al menos un destinatario' });
  }

  // Responder inmediatamente para evitar timeout del caller y reintentos duplicados
  res.status(202).json({ success: true, message: 'Envío en proceso', sessionId, recipients: recipients.length });

  (async () => {
    try {
      await trackApiSend({ name: 'Mensaje por API', session: sessionId, recipients, files: [] }, sendText(sessionId, recipients, text));
    } catch (err) {
      logger.error({ err: err.message }, 'Error al procesar /send-text');
    }
  })();
});

// ─── POST /check-numbers ─────────────────────────────────────────────────────
// Verifica cuáles números están registrados en WhatsApp
// Body: { "from": "SESSION_ID", "numbers": ["51974616900", "51962704710"] }

app.post('/check-numbers', async (req, res) => {
  const { from, numbers } = req.body;
  if (!numbers?.length) return res.status(400).json({ error: 'El campo numbers es requerido' });

  const sessionId = from || getFirstConnectedSession();
  if (!sessionId) return res.status(503).json({ error: 'No hay sesiones conectadas' });

  const s = getSession(sessionId);
  if (!s?.isConnected) return res.status(503).json({ error: 'Sesión no conectada' });

  try {
    const jids = numbers.map(n => (n.includes('@') ? n : n.replace(/\D/g, '') + '@s.whatsapp.net'));
    const result = await s.sock.onWhatsApp(...jids);
    const found = new Set((result || []).map(r => r.jid));
    const details = numbers.map((n, i) => ({
      number: n,
      jid: jids[i],
      onWhatsApp: found.has(jids[i]),
    }));
    res.json({ sessionId, details });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
