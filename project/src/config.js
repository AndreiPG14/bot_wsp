/**
 * config.js
 * Centraliza y valida todas las variables de entorno.
 * El proceso falla inmediatamente si falta alguna variable crítica.
 */

import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * Lee una variable de entorno. Si es requerida y no existe, lanza error.
 */
function env(key, defaultValue = undefined, required = false) {
  const value = process.env[key] ?? defaultValue;
  if (required && (value === undefined || value === '')) {
    throw new Error(`Variable de entorno requerida no definida: ${key}`);
  }
  return value;
}

/**
 * Parsea una lista CSV de la variable de entorno.
 * Elimina espacios y entradas vacías.
 */
function envList(key, defaultValue = '') {
  const raw = process.env[key] || defaultValue;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const config = {
  // --- General ---
  nodeEnv: env('NODE_ENV', 'development'),
  port: parseInt(env('PORT', '3000'), 10),
  isDev: env('NODE_ENV', 'development') !== 'production',

  // --- IMAP ---
  imap: {
    host: env('IMAP_HOST', 'outlook.office365.com'),
    port: parseInt(env('IMAP_PORT', '993'), 10),
    secure: env('IMAP_SECURE', 'true') === 'true',
    user: env('IMAP_USER', undefined, true),
    pass: env('IMAP_PASS', undefined, true),
    mailbox: env('IMAP_MAILBOX', 'INBOX'),
    processedFolder: env('IMAP_PROCESSED_FOLDER', 'Procesados'),
  },

  // --- Filtros de correo ---
  email: {
    subjectFilter: env('EMAIL_SUBJECT_FILTER', ''),
    fromFilter: env('EMAIL_FROM_FILTER', ''),
  },

  // --- WhatsApp ---
  whatsapp: {
    numbers: envList('WHATSAPP_NUMBERS'),
    groups: envList('WHATSAPP_GROUPS'),
    caption: env('WHATSAPP_CAPTION', '📊 Reporte Power BI actualizado'),
  },


  // --- Reconexión ---
  reconnect: {
    maxAttempts: parseInt(env('MAX_RECONNECT_ATTEMPTS', '10'), 10),
    delayMs: parseInt(env('RECONNECT_DELAY_MS', '5000'), 10),
  },

  // --- Polling de respaldo ---
  pollingIntervalSeconds: parseInt(env('POLLING_INTERVAL_SECONDS', '60'), 10),

  // --- Rutas ---
  paths: {
    auth: path.join(ROOT, 'auth'),
    attachments: path.join(ROOT, 'attachments'),
    processed: path.join(ROOT, 'processed'),
  },
};

// Validación de destinatarios WhatsApp
if (config.whatsapp.numbers.length === 0 && config.whatsapp.groups.length === 0) {
  console.warn(
    '[WARN] No hay destinatarios configurados. El bot arrancará igual — usa GET /groups para obtener los IDs.'
  );
}
export default config;
