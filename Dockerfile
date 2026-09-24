# POC image for the Streamable HTTP transport (run it next to spatial-service, behind the same proxy).
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY reference ./reference
ENV HOST=0.0.0.0 PORT=3920
EXPOSE 3920
USER node
CMD ["node", "--import", "tsx", "src/http.ts"]
