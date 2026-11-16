FROM node:24-slim AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
FROM base AS test
RUN chown -R node:node /app
USER node
CMD ["npm","run","integration"]
FROM base AS api
RUN npm prune --omit=dev
USER node
EXPOSE 8080
CMD ["node","server/main.ts"]
FROM base AS web-build
RUN npm run build
FROM nginxinc/nginx-unprivileged:stable-alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/dist/web /usr/share/nginx/html
EXPOSE 8080
