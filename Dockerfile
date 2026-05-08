FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

RUN npm prune --omit=dev

EXPOSE 3000

CMD ["npm", "start"]