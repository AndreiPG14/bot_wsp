FROM node:20-alpine

# Instalar dependencias del sistema necesarias para Baileys
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    pango-dev \
    jpeg-dev \
    giflib-dev \
    librsvg-dev

WORKDIR /app

# Copiar manifiestos de dependencias primero (mejor cache de Docker)
COPY package*.json ./

# Instalar dependencias de producción
RUN npm install --omit=dev

# Copiar el resto del código fuente
COPY . .

# Crear carpetas necesarias (persisten dentro del contenedor)
RUN mkdir -p auth processed attachments

# Exponer puerto para el healthcheck HTTP
EXPOSE 3000

# Comando de inicio
CMD ["node", "src/index.js"]
