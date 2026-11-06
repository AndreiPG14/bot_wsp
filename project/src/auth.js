/**
 * auth.js
 * Login del panel (usuario y contraseña desde variables de entorno) con una
 * cookie firmada, y clave de API opcional para los endpoints de envío.
 */

import crypto from 'crypto';
import config from './config.js';
import logger from './logger.js';
import { safeEqual } from './store.js';

const COOKIE = 'bot_panel';
const secret = config.panel.sessionSecret || crypto.randomBytes(32).toString('hex');

if (!config.panel.password) {
  logger.warn('ADMIN_PASSWORD no está definido: el panel web no permitirá iniciar sesión.');
}
if (!config.apiKey) {
  logger.warn('API_KEY no está definido: /send, /send-image y /send-text quedan abiertos (modo antiguo).');
}

const sign = (payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

function makeToken(user) {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + config.panel.sessionHours * 3600e3 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!safeEqual(sig, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

const isHttps = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';

export function panelUser(req) {
  return readToken(getCookie(req, COOKIE))?.u || null;
}

// Límite de intentos de login por IP: 5 por cada 5 minutos.
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 5 * 60e3);
  attempts.set(ip, list);
  return list.length >= 5;
}

export function login(req, res) {
  const ip = req.ip;
  if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  if (!config.panel.password) return res.status(503).json({ error: 'El panel no tiene contraseña configurada (ADMIN_PASSWORD).' });

  const { user, password } = req.body || {};
  const ok = safeEqual(user || '', config.panel.user) & safeEqual(password || '', config.panel.password);
  if (!ok) {
    attempts.get(ip).push(Date.now());
    logger.warn({ ip }, 'Intento de login fallido en el panel');
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }
  attempts.delete(ip);
  res.cookie(COOKIE, makeToken(config.panel.user), {
    httpOnly: true,
    sameSite: 'strict',
    secure: isHttps(req),
    maxAge: config.panel.sessionHours * 3600e3,
    path: '/',
  });
  res.json({ user: config.panel.user });
}

export function logout(req, res) {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
}

/** Solo para el panel: exige la cookie de sesión. */
export function requirePanel(req, res, next) {
  if (panelUser(req)) return next();
  res.status(401).json({ error: 'Sesión expirada. Vuelve a iniciar sesión.' });
}

function hasValidKey(req) {
  if (!config.apiKey) return false;
  const header = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return !!header && safeEqual(header, config.apiKey);
}

/** Acciones de administración (sesiones): cookie del panel o API key. Sin API key, solo el panel. */
export function requirePanelOrKey(req, res, next) {
  if (panelUser(req) || hasValidKey(req)) return next();
  if (req.accepts('html') && req.method === 'GET') return res.redirect('/');
  res.status(401).json({ error: 'No autorizado. Inicia sesión en el panel o envía la API key.' });
}

/** Para integraciones: acepta la cookie del panel o la API key (si está configurada). */
export function requireApiKey(req, res, next) {
  if (!config.apiKey || panelUser(req) || hasValidKey(req)) return next();
  res.status(401).json({ error: 'Falta la API key (cabecera x-api-key).' });
}
