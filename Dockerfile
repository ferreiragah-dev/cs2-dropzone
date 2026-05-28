# ── Build stage ───────────────────────────────────────────────────
FROM node:20-alpine

# Diretório de trabalho dentro do container
WORKDIR /app

# Copia package.json primeiro (cache de layers)
COPY package*.json ./

# Instala dependências de produção
RUN npm install --omit=dev

# Copia o restante do projeto
COPY . .

# Expõe a porta (Easypanel vai mapear automaticamente)
EXPOSE 3000

# Inicia o servidor
CMD ["node", "server.js"]
