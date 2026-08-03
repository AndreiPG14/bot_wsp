/**
 * index.js
 * Punto de entrada principal del bot.
 *
 * Secuencia de inicio:
 * 1. Crear carpetas necesarias.
 * 2. Iniciar WhatsApp (Baileys) y esperar a que esté listo.
 * 3. Iniciar servidor HTTP que recibe PDFs desde Power Automate.
 * 4. Registrar manejadores de señales de cierre.
 */

import 'dotenv/config';
import fse from 'fs-extra';
import config from './config.js';
import logger from './logger.js';
import { initWhatsApp, listGroups } from './baileys.js';
import { startServer } from './server.js';

async function main() {
  logger.info('🚀 Iniciando PowerBI → WhatsApp Bot...');
  logger.info({ env: config.nodeEnv }, 'Entorno de ejecución');

  // 1. Crear carpetas necesarias
  await fse.ensureDir(config.paths.auth);
  await fse.ensureDir(config.paths.attachments);
  await fse.ensureDir(config.paths.processed);
  logger.info('Carpetas verificadas/creadas');

  // 2. Iniciar servidor HTTP primero para que Railway pueda hacer health check
  await startServer();

  // 3. Conectar WhatsApp en segundo plano (no bloqueamos el servidor)
  logger.info('Conectando a WhatsApp...');
  logger.info('Si es la primera vez, escanea el QR que aparecerá a continuación.');
  initWhatsApp().then(async () => {
    logger.info('WhatsApp listo. Listando grupos disponibles...');
    await listGroups();
    logger.info('✅ Bot listo. Esperando PDFs en POST /send');
  }).catch((err) => {
    logger.error({ err: err.message }, 'Error al conectar WhatsApp');
  });
}

// ─── Señales de cierre graceful ──────────────────────────────────────────────

async function shutdown(signal) {
  logger.info({ signal }, 'Señal de cierre recibida. Cerrando...');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, 'Error no capturado');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Promesa rechazada no manejada');
});

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'Error fatal al iniciar');
  process.exit(1);
});