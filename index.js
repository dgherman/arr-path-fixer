#!/usr/bin/env node

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Configuration from environment variables
const CONFIG = {
  radarr: {
    enabled: process.env.RADARR_ENABLED === 'true',
    url: process.env.RADARR_URL,
    apiKey: process.env.RADARR_API_KEY,
    mountPath: process.env.RADARR_MOUNT_PATH || '/mnt/nzbdav/content/movies'
  },
  sonarr: {
    enabled: process.env.SONARR_ENABLED === 'true',
    url: process.env.SONARR_URL,
    apiKey: process.env.SONARR_API_KEY,
    mountPath: process.env.SONARR_MOUNT_PATH || '/mnt/nzbdav/content/tv'
  },
  lidarr: {
    enabled: process.env.LIDARR_ENABLED === 'true',
    url: process.env.LIDARR_URL,
    apiKey: process.env.LIDARR_API_KEY,
    mountPath: process.env.LIDARR_MOUNT_PATH || '/mnt/nzbdav/content/music'
  },
  pollInterval: parseInt(process.env.POLL_INTERVAL_SECONDS || '60') * 1000,
  dryRun: process.env.DRY_RUN === 'true'
};

const log = (service, message) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${service}] ${message}`);
};

// Generic API client for *arr services
class ArrClient {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.axios = axios.create({
      baseURL: config.url,
      headers: { 'X-Api-Key': config.apiKey }
    });
  }

  async getQueue() {
    try {
      const response = await this.axios.get('/api/v3/queue');
      return response.data.records || [];
    } catch (error) {
      log(this.name, `Error fetching queue: ${error.message}`);
      return [];
    }
  }

  async getItem(id, endpoint) {
    try {
      const response = await this.axios.get(`/api/v3/${endpoint}/${id}`);
      return response.data;
    } catch (error) {
      log(this.name, `Error fetching item ${id}: ${error.message}`);
      return null;
    }
  }

  async updateItem(id, endpoint, data) {
    try {
      const response = await this.axios.put(`/api/v3/${endpoint}/${id}?moveFiles=false`, data);
      return response.data;
    } catch (error) {
      log(this.name, `Error updating item ${id}: ${error.message}`);
      return null;
    }
  }

  async triggerCommand(command) {
    try {
      await this.axios.post('/api/v3/command', command);
      return true;
    } catch (error) {
      log(this.name, `Error triggering command: ${error.message}`);
      return false;
    }
  }

  async removeFromQueue(id) {
    try {
      await this.axios.delete(`/api/v3/queue/${id}?removeFromClient=false&blocklist=false`);
      return true;
    } catch (error) {
      log(this.name, `Error removing from queue: ${error.message}`);
      return false;
    }
  }

  findActualPath(expectedTitle, mountPath) {
    try {
      if (!fs.existsSync(mountPath)) {
        log(this.name, `Mount path doesn't exist: ${mountPath}`);
        return null;
      }

      const directories = fs.readdirSync(mountPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      // Try to find directory that contains the title (case-insensitive)
      const titleLower = expectedTitle.toLowerCase().replace(/[^a-z0-9]/g, '');

      for (const dir of directories) {
        const dirLower = dir.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (dirLower.includes(titleLower) || titleLower.includes(dirLower)) {
          const fullPath = path.join(mountPath, dir);

          // Verify it has media files
          const files = fs.readdirSync(fullPath);
          const hasMedia = files.some(f =>
            /\.(mkv|mp4|avi|mov|flac|mp3|m4a)$/i.test(f)
          );

          if (hasMedia) {
            log(this.name, `Found actual path: ${fullPath}`);
            return fullPath;
          }
        }
      }

      log(this.name, `No matching directory found for: ${expectedTitle}`);
      return null;
    } catch (error) {
      log(this.name, `Error finding actual path: ${error.message}`);
      return null;
    }
  }
}

// Radarr-specific handler
class RadarrMonitor extends ArrClient {
  async processQueue() {
    const queue = await this.getQueue();
    const completed = queue.filter(item =>
      item.status === 'completed' &&
      item.trackedDownloadState === 'importBlocked'
    );

    for (const queueItem of completed) {
      log(this.name, `Processing: ${queueItem.title}`);

      const movie = await this.getItem(queueItem.movieId, 'movie');
      if (!movie) continue;

      if (movie.hasFile) {
        log(this.name, `Movie already has file, removing from queue: ${movie.title}`);
        if (!CONFIG.dryRun) {
          await this.removeFromQueue(queueItem.id);
        }
        continue;
      }

      const actualPath = this.findActualPath(movie.title, this.config.mountPath);
      if (!actualPath) continue;

      if (actualPath === movie.path) {
        log(this.name, `Path already correct: ${movie.title}`);
        continue;
      }

      log(this.name, `Updating path from ${movie.path} to ${actualPath}`);

      if (!CONFIG.dryRun) {
        movie.path = actualPath;
        const updated = await this.updateItem(movie.id, 'movie', movie);

        if (updated) {
          log(this.name, `Triggering refresh for: ${movie.title}`);
          await this.triggerCommand({ name: 'RefreshMovie', movieIds: [movie.id] });

          // Wait a bit for refresh, then check if file detected
          setTimeout(async () => {
            const refreshed = await this.getItem(movie.id, 'movie');
            if (refreshed && refreshed.hasFile) {
              log(this.name, `✅ Successfully imported: ${movie.title}`);
              await this.removeFromQueue(queueItem.id);
            }
          }, 5000);
        }
      } else {
        log(this.name, `[DRY RUN] Would update path and refresh`);
      }
    }
  }
}

// Sonarr-specific handler
class SonarrMonitor extends ArrClient {
  async processQueue() {
    const queue = await this.getQueue();
    const completed = queue.filter(item =>
      item.status === 'completed' &&
      item.trackedDownloadState === 'importPending'
    );

    for (const queueItem of completed) {
      log(this.name, `Processing: ${queueItem.title}`);

      const series = await this.getItem(queueItem.seriesId, 'series');
      if (!series) continue;

      const actualPath = this.findActualPath(series.title, this.config.mountPath);
      if (!actualPath) continue;

      if (actualPath === series.path) {
        log(this.name, `Path already correct: ${series.title}`);
        continue;
      }

      log(this.name, `Updating path from ${series.path} to ${actualPath}`);

      if (!CONFIG.dryRun) {
        series.path = actualPath;
        const updated = await this.updateItem(series.id, 'series', series);

        if (updated) {
          log(this.name, `Triggering refresh for: ${series.title}`);
          await this.triggerCommand({ name: 'RefreshSeries', seriesId: series.id });

          setTimeout(async () => {
            log(this.name, `✅ Path updated for: ${series.title}`);
            await this.removeFromQueue(queueItem.id);
          }, 5000);
        }
      } else {
        log(this.name, `[DRY RUN] Would update path and refresh`);
      }
    }
  }
}

// Lidarr-specific handler
class LidarrMonitor extends ArrClient {
  async processQueue() {
    const queue = await this.getQueue();
    const completed = queue.filter(item =>
      item.status === 'completed' &&
      item.trackedDownloadState === 'importPending'
    );

    for (const queueItem of completed) {
      log(this.name, `Processing: ${queueItem.title}`);

      const artist = await this.getItem(queueItem.artistId, 'artist');
      if (!artist) continue;

      const actualPath = this.findActualPath(artist.artistName, this.config.mountPath);
      if (!actualPath) continue;

      if (actualPath === artist.path) {
        log(this.name, `Path already correct: ${artist.artistName}`);
        continue;
      }

      log(this.name, `Updating path from ${artist.path} to ${actualPath}`);

      if (!CONFIG.dryRun) {
        artist.path = actualPath;
        const updated = await this.updateItem(artist.id, 'artist', artist);

        if (updated) {
          log(this.name, `Triggering refresh for: ${artist.artistName}`);
          await this.triggerCommand({ name: 'RefreshArtist', artistId: artist.id });

          setTimeout(async () => {
            log(this.name, `✅ Path updated for: ${artist.artistName}`);
            await this.removeFromQueue(queueItem.id);
          }, 5000);
        }
      } else {
        log(this.name, `[DRY RUN] Would update path and refresh`);
      }
    }
  }
}

// Main monitoring loop
async function monitorAll() {
  const monitors = [];

  if (CONFIG.radarr.enabled) {
    monitors.push(new RadarrMonitor('Radarr', CONFIG.radarr));
  }
  if (CONFIG.sonarr.enabled) {
    monitors.push(new SonarrMonitor('Sonarr', CONFIG.sonarr));
  }
  if (CONFIG.lidarr.enabled) {
    monitors.push(new LidarrMonitor('Lidarr', CONFIG.lidarr));
  }

  if (monitors.length === 0) {
    log('Main', 'No services enabled! Check environment variables.');
    process.exit(1);
  }

  log('Main', `Starting monitors: ${monitors.map(m => m.name).join(', ')}`);
  log('Main', `Poll interval: ${CONFIG.pollInterval / 1000}s`);
  log('Main', `Dry run: ${CONFIG.dryRun}`);

  async function poll() {
    for (const monitor of monitors) {
      try {
        await monitor.processQueue();
      } catch (error) {
        log(monitor.name, `Error in monitor: ${error.message}`);
      }
    }
  }

  // Initial poll
  await poll();

  // Schedule recurring polls
  setInterval(poll, CONFIG.pollInterval);
}

// Start the service
monitorAll().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
