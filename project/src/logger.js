/**
 * logger.js
 * Logger centralizado con Pino.
 * En desarrollo muestra output bonito con pino-pretty.
 * En producción emite JSON puro (óptimo para Railway logs).
 */

import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

const transport = isDev
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
      },
    }
  : undefined;

const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    base: { service: 'powerbi-whatsapp-bot' },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transport ? pino.transport(transport) : undefined
);

export default logger;
