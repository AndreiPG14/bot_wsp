# 📊 PowerBI → WhatsApp Bot

Bot Node.js que recibe automáticamente correos de Power Automate con PDFs de Power BI y los reenvía por WhatsApp a contactos individuales y grupos.

## Arquitectura

```
Power Automate
    ↓ Exporta PDF de Power BI
    ↓ Envía correo a Outlook
Node.js Bot
    ↓ IMAP detecta nuevo correo
    ↓ Descarga adjunto PDF
    ↓ Baileys envía por WhatsApp
    ├── Números individuales
    └── Grupos de WhatsApp
```

---

## Requisitos

- Node.js >= 20
- Cuenta de Outlook con IMAP habilitado
- Número de WhatsApp activo para el bot
- Railway (para despliegue en la nube)

---

## Instalación local

### 1. Clonar y entrar al proyecto

```bash
git clone https://github.com/tuusuario/powerbi-whatsapp-bot.git
cd powerbi-whatsapp-bot
```

### 2. Instalar dependencias

```bash
npm install
```

### 3. Configurar variables de entorno

```bash
cp .env.example .env
```

Edita el archivo `.env` con tus datos:

```env
# Outlook IMAP
IMAP_USER=tucorreo@empresa.com
IMAP_PASS=tu_contraseña_de_app

# Destinatarios WhatsApp
WHATSAPP_NUMBERS=51999999999,51988888888
WHATSAPP_GROUPS=1203634XXXXXXXX@g.us

# Filtros opcionales
EMAIL_SUBJECT_FILTER=Reporte Power BI
EMAIL_FROM_FILTER=powerautomate@empresa.com
```

> ⚠️ **Contraseña de App en Outlook**: Si tienes autenticación de dos factores activada, debes generar una "Contraseña de Aplicación" en la configuración de seguridad de tu cuenta Microsoft.

---

## Primer inicio y escaneo de QR

Al iniciar por primera vez, el bot mostrará un código QR en la consola.

```bash
npm start
```

Verás algo como:

```
⚡ Escanea el código QR con tu WhatsApp para iniciar sesión:
▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
█ ▄▄▄▄▄ █▄█▀█ ▄▄▄▄▄ █
█ █   █ █  ▀▄ █   █ █
...
```

**Pasos para escanear:**
1. Abre WhatsApp en tu teléfono.
2. Ve a `Configuración → Dispositivos vinculados → Vincular un dispositivo`.
3. Escanea el QR que aparece en la consola.
4. Espera el mensaje `✅ WhatsApp conectado exitosamente`.

La sesión se guarda en la carpeta `auth/` y **no necesitarás escanear el QR nuevamente** mientras esa carpeta exista.

---

## Cómo obtener IDs de grupos

Los grupos de WhatsApp tienen un ID especial con formato `XXXXXXXXXXXXXXXXXX@g.us`.

Para obtener los IDs, inicia el bot y visita el endpoint:

```
http://localhost:3000/groups
```

O revisa los logs al iniciar, donde se listan todos los grupos disponibles:

```
  📱 [120363XXXXXXXXXX@g.us] Mi Grupo Empresarial (15 participantes)
  📱 [120363YYYYYYYYYY@g.us] Reportes Power BI (8 participantes)
```

Copia el ID del grupo que quieras y agrégalo a `WHATSAPP_GROUPS` en tu `.env`.

---

## Cómo agregar contactos

Edita la variable `WHATSAPP_NUMBERS` en tu `.env`:

```env
# Formato: código de país + número, sin espacios ni guiones
WHATSAPP_NUMBERS=51999999999,51988888888,51977777777
```

- El código de país de Perú es `51`.
- No uses `+`, espacios ni guiones.

---

## Cómo agregar grupos

```env
WHATSAPP_GROUPS=120363XXXXXXXXXX@g.us,120363YYYYYYYYYY@g.us
```

---

## Filtros de correo

Para que el bot solo procese correos específicos de Power Automate:

```env
# Solo procesa correos cuyo asunto contenga este texto
EMAIL_SUBJECT_FILTER=Reporte Power BI

# Solo procesa correos de este remitente
EMAIL_FROM_FILTER=powerautomate@empresa.com
```

Deja vacíos para procesar todos los correos con PDFs adjuntos.

---

## Despliegue en Railway

### Opción 1: Via CLI de Railway

```bash
# Instalar Railway CLI
npm install -g @railway/cli

# Login
railway login

# Crear proyecto
railway init

# Configurar variables de entorno
railway variables set IMAP_USER=tucorreo@empresa.com
railway variables set IMAP_PASS=tu_contraseña
railway variables set WHATSAPP_NUMBERS=51999999999
railway variables set WHATSAPP_GROUPS=120363XXXXXXXXXX@g.us
railway variables set EMAIL_SUBJECT_FILTER="Reporte Power BI"
railway variables set NODE_ENV=production

# Desplegar
railway up
```

### Opción 2: Via interfaz web de Railway

1. Entra a [railway.app](https://railway.app) y crea un nuevo proyecto.
2. Conecta tu repositorio de GitHub.
3. Railway detectará el `Dockerfile` automáticamente.
4. Ve a `Variables` y agrega todas las variables del `.env.example`.
5. Railway desplegará automáticamente.

### Primer escaneo de QR en Railway

En Railway no tienes acceso directo a la consola para escanear el QR. Sigue estos pasos:

1. Escanea el QR **localmente** primero con `npm start`.
2. La sesión se guarda en `auth/`.
3. Sube la carpeta `auth/` al repositorio **de forma privada** o usa un volumen persistente de Railway.

**Alternativa recomendada con Railway Volumes:**
1. En Railway, crea un volumen y móntalo en `/app/auth`.
2. Inicia el bot localmente, escanea el QR.
3. Copia el contenido de `auth/` al volumen de Railway mediante Railway CLI:
   ```bash
   railway run -- cp -r ./auth/* /app/auth/
   ```

---

## Reiniciar sesión de WhatsApp

Si necesitas vincular otro número o la sesión expiró:

```bash
# Local
rm -rf auth/
npm start
# Escanea el nuevo QR

# En Railway
railway run -- rm -rf /app/auth/
# Reinicia el servicio
```

---

## Healthcheck y monitoreo

El bot expone un endpoint HTTP:

```
GET /health
```

Respuesta:
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "whatsapp": {
    "connected": true,
    "reconnectAttempts": 0
  }
}
```

```
GET /groups
```

Lista todos los grupos de WhatsApp disponibles.

---

## Cómo probar

### Prueba local completa

1. Inicia el bot: `npm start`
2. Escanea el QR de WhatsApp.
3. Envíate un correo a `IMAP_USER` con un PDF adjunto.
4. Espera hasta 60 segundos (el polling de respaldo verifica cada minuto).
5. El PDF debe llegar por WhatsApp a los destinatarios configurados.

### Verificar que IMAP funciona

Revisa los logs:
```
✅ Conexión IMAP establecida
Escuchando nuevos correos con IMAP IDLE...
```

### Forzar verificación de correos

Reinicia el bot para forzar una verificación inmediata de correos no leídos.

---

## Solución de errores comunes

### ❌ `Variable de entorno requerida no definida: IMAP_USER`
**Solución:** Crea el archivo `.env` a partir de `.env.example` y completa todos los campos requeridos.

### ❌ `Authentication failed` en IMAP
**Posibles causas:**
- Contraseña incorrecta.
- No estás usando una "Contraseña de App" (necesaria con MFA habilitado).
- IMAP no está habilitado en tu cuenta de Outlook.

**Para habilitar IMAP en Outlook:**
1. Ve a `outlook.com → Configuración → Correo → Sincronizar correo electrónico`.
2. Activa "Permitir dispositivos y aplicaciones que usen IMAP".

### ❌ QR no aparece o sesión expirada
```bash
rm -rf auth/
npm start
```

### ❌ `Connection refused` o `ECONNREFUSED`
El servidor IMAP no está accesible. Verifica:
- `IMAP_HOST=outlook.office365.com`
- `IMAP_PORT=993`
- `IMAP_SECURE=true`

### ❌ WhatsApp se desconecta constantemente
- Asegúrate de que el número no esté siendo usado en WhatsApp Web desde otro lugar.
- Los dispositivos vinculados se pueden gestionar desde `WhatsApp → Dispositivos vinculados`.

### ❌ El correo llega pero no se envía el PDF
- Revisa los filtros `EMAIL_SUBJECT_FILTER` y `EMAIL_FROM_FILTER`.
- Asegúrate de que el adjunto sea un PDF real (no imagen o Word).
- Revisa los logs para ver el error específico.

### ❌ `No se puede mover el correo` (carpeta Procesados)
El bot intentará crear la carpeta automáticamente. Si falla:
1. Crea manualmente la carpeta "Procesados" en Outlook.
2. O cambia `IMAP_PROCESSED_FOLDER` a una carpeta existente como `Archive`.

---

## Estructura del proyecto

```
├── src/
│   ├── index.js          # Punto de entrada
│   ├── config.js         # Configuración y validación de env vars
│   ├── logger.js         # Logger centralizado (Pino)
│   ├── imap.js           # Cliente IMAP (ImapFlow)
│   ├── baileys.js        # Cliente WhatsApp (Baileys)
│   ├── processEmail.js   # Lógica de procesamiento de correos
│   ├── sendWhatsapp.js   # Orquestador de envíos WhatsApp
│   └── utils.js          # Funciones de utilidad
├── auth/                 # Sesión de WhatsApp (generada automáticamente)
├── attachments/          # PDFs temporales (se limpian automáticamente)
├── processed/            # Directorio de trabajo
├── .env.example          # Plantilla de variables de entorno
├── .gitignore
├── Dockerfile
├── railway.json
└── package.json
```

---

## Licencia

MIT
