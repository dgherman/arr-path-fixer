FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application
COPY index.js ./

# Create mount point for NzbDAV content
RUN mkdir -p /mnt/nzbdav/content

# Run as non-root user
USER node

CMD ["node", "index.js"]
