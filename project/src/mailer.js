/**
 * mailer.js
 * Envía correos con adjuntos usando nodemailer via SMTP de Outlook.
 */

import nodemailer from 'nodemailer';
import fse from 'fs-extra';
import path from 'path';
import config from './config.js';
import logger from './logger.js';

const transporter = nodemailer.createTransport({
  host: 'smtp.office365.com',
  port: 587,
  secure: false,
  auth: {
    user: config.imap.user,
    pass: config.imap.pass,
  },
  tls: { ciphers: 'SSLv3' },
});

/**
 * Envía un archivo (PDF o imagen) por correo a los destinatarios configurados.
 * @param {string} filePath - Ruta absoluta al archivo.
 * @param {string} caption - Texto del cuerpo del correo.
 * @param {string} subject - Asunto del correo.
 */
export async function sendEmailToAll(filePath, caption, subject) {
  const recipients = config.email.recipients;

  if (!recipients || recipients.length === 0) {
    logger.warn('No hay destinatarios de correo configurados (EMAIL_RECIPIENTS).');
    return { sent: 0, failed: 0 };
  }

  const filename = path.basename(filePath);
  const fileBuffer = await fse.readFile(filePath);

  logger.info({ recipients, filename }, 'Enviando correo con adjunto');

  try {
    await transporter.sendMail({
      from: `"PowerBI Bot" <${config.imap.user}>`,
      to: recipients.join(','),
      subject: subject || caption || '📊 Reporte Power BI',
      text: caption || '📊 Reporte Power BI actualizado',
      attachments: [{ filename, content: fileBuffer }],
    });

    logger.info({ recipients, filename }, '✅ Correo enviado exitosamente');
    return { sent: recipients.length, failed: 0 };
  } catch (err) {
    logger.error({ err: err.message }, '❌ Error al enviar correo');
    return { sent: 0, failed: recipients.length };
  }
}
