FROM node:22-trixie-slim

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends bind9-utils openssl \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build && chmod +x docker/entrypoint.sh

EXPOSE 8080 8443
ENTRYPOINT ["./docker/entrypoint.sh"]
