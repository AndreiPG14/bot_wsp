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
import { sendPdf, sendImage, sendText, IMAGE_MIMETYPES } from './sendWhatsapp.js';
import { generateSafeFilename, removeFile } from './utils.js';

const app = express();
app.use(express.json({ limit: '50mb' }));

// ─── GET / (panel web) ───────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>WhatsApp Bot — Sesiones</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: sans-serif; background: #f0f2f5; min-height: 100vh; padding: 32px 16px; }
    h1 { color: #128C7E; margin-bottom: 24px; }
    .card { background: white; border-radius: 12px; padding: 24px; margin-bottom: 20px; box-shadow: 0 1px 4px rgba(0,0,0,.1); }
    .sessions { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .session { background: white; border-radius: 12px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,.1); position: relative; }
    .badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
    .badge.ok  { background: #dcfce7; color: #166534; }
    .badge.qr  { background: #fef9c3; color: #854d0e; }
    .badge.off { background: #fee2e2; color: #991b1b; }
    .session h3 { margin-bottom: 8px; font-size: 16px; }
    .btn { display: inline-block; padding: 8px 16px; border-radius: 8px; border: none; cursor: pointer; font-size: 14px; font-weight: 600; text-decoration: none; }
    .btn-green  { background: #25D366; color: white; }
    .btn-red    { background: #ef4444; color: white; margin-left: 8px; }
    .btn-gray   { background: #e5e7eb; color: #374151; }
    input { width: 100%; padding: 10px 14px; border: 1.5px solid #d1d5db; border-radius: 8px; font-size: 15px; margin-bottom: 12px; outline: none; }
    input:focus { border-color: #25D366; }
    .row { display: flex; gap: 8px; align-items: center; }
    #msg { margin-top: 12px; font-size: 14px; color: #6b7280; }
    .empty { color: #9ca3af; font-size: 14px; }
  </style>
</head>
<body>
  <h1>📱 WhatsApp Bot — Sesiones</h1>

  <div class="card">
    <h2 style="margin-bottom:16px;font-size:16px;color:#374151;">Nueva sesión</h2>
    <div class="row">
      <input id="newId" placeholder='Nombre de sesión (ej: andrei, empresa)' style="margin:0"/>
      <button class="btn btn-green" onclick="crearSesion()">Generar QR</button>
    </div>
    <div id="msg"></div>
  </div>

  <div id="sessions" class="sessions"></div>

  <script>
    async function cargar() {
      const r = await fetch('/sessions');
      const { sessions } = await r.json();
      const el = document.getElementById('sessions');
      if (!sessions.length) {
        el.innerHTML = '<p class="empty">No hay sesiones aún. Creá una arriba.</p>';
        return;
      }
      el.innerHTML = sessions.map(s => {
        const badge = s.connected ? '<span class="badge ok">✅ Conectado</span>'
                    : s.hasQr    ? '<span class="badge qr">⚡ Esperando QR</span>'
                    :              '<span class="badge off">⭕ Desconectado</span>';
        const qrBtn = !s.connected
          ? \`<a class="btn btn-green" href="/sessions/\${s.id}/qr" target="_blank">Ver QR</a>\`
          : \`<a class="btn btn-gray" href="/sessions/\${s.id}/groups" target="_blank">Ver grupos</a>\`;
        return \`<div class="session">
          <h3>\${s.id}</h3>
          \${badge}
          <div style="margin-top:14px">
            \${qrBtn}
            <button class="btn btn-red" onclick="eliminar('\${s.id}')">Eliminar</button>
          </div>
        </div>\`;
      }).join('');
    }

    async function crearSesion() {
      const id = document.getElementById('newId').value.trim().replace(/[^a-zA-Z0-9_-]/g, '-');
      if (!id) { document.getElementById('msg').textContent = 'Ingresá un nombre.'; return; }
      document.getElementById('msg').textContent = 'Creando sesión...';
      window.open('/sessions/' + id + '/qr', '_blank');
      document.getElementById('newId').value = '';
      document.getElementById('msg').textContent = 'Escaneá el QR que se abrió en la nueva pestaña.';
      setTimeout(cargar, 2000);
    }

    async function eliminar(id) {
      if (!confirm('¿Eliminar la sesión "' + id + '"?')) return;
      await fetch('/sessions/' + id, { method: 'DELETE' });
      cargar();
    }

    cargar();
    setInterval(cargar, 5000);
  </script>
</body>
</html>`);
});

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
      await sendPdf(sessionId, recipients, filePath, caption);
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
      try { await sendText(sessionId, recipients, caption); } catch (err) {
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
      await sendImage(sessionId, recipients, filePath, mimetype, caption);
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
      await sendText(sessionId, recipients, text);
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
