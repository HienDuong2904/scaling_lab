# Build from the repo root: docker build -f shared/fake-partner/Dockerfile .
FROM node:24-alpine
WORKDIR /lab
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY shared/node-common/package.json shared/node-common/
COPY shared/fake-partner/package.json shared/fake-partner/
RUN npm ci --omit=dev --workspace shared/fake-partner --no-audit --no-fund
COPY shared/node-common shared/node-common
COPY shared/fake-partner shared/fake-partner
USER node
EXPOSE 8080
CMD ["node", "shared/fake-partner/src/server.ts"]
