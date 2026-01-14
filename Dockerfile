FROM node:20-alpine

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install dependencies (including native modules)
RUN npm install --production

# Copy application
COPY index.js ./

# Create mount points
RUN mkdir -p /mnt/nzbdav/content /config/sonarr

# Run as non-root user
USER node

CMD ["node", "index.js"]
