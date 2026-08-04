/**
 * index.js
 * Punto de entrada principal del bot.
 *
 * Secuencia de inicio:
 * 1. Crear carpetas necesarias.
 * 2. Iniciar servidor HTTP (para el health check de Railway).
 * 3. Cargar sesiones existentes en segundo plano.
 */

import 'dotenv/config';
import fse from 'fs-extra';
import config from './config.js';
import logger from './logger.js';
import { loadExistingSessions } from './baileys.js';
import { startServer } from './server.js';

async function main() {
  logger.info('🚀 Iniciando PowerBI → WhatsApp Bot...');
  logger.info({ env: config.nodeEnv }, 'Entorno de ejecución');

  await fse.ensureDir(config.paths.auth);
  await fse.ensureDir(config.paths.attachments);
  await fse.ensureDir(config.paths.processed);
  logger.info('Carpetas verificadas/creadas');

  await startServer();

  loadExistingSessions().catch((err) => {
    logger.error({ err: err.message }, 'Error al cargar sesiones existentes');
  });
}

process.on('SIGTERM', () => { logger.info('SIGTERM'); process.exit(0); });
process.on('SIGINT',  () => { logger.info('SIGINT');  process.exit(0); });

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
