#!/usr/bin/env node

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Configuration from environment variables
const CONFIG = {
  nzbdav: {
    url: process.env.NZBDAV_URL,
    apiKey: process.env.NZBDAV_API_KEY,
    historyLimit: parseInt(process.env.NZBDAV_HISTORY_LIMIT || '50')
  },
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
  constructor(name, config, apiVersion = 'v3') {
    this.name = name;
    this.config = config;
    this.apiVersion = apiVersion;
    this.axios = axios.create({
      baseURL: config.url,
      headers: { 'X-Api-Key': config.apiKey }
    });
  }

  async getQueue() {
    try {
      const response = await this.axios.get(`/api/${this.apiVersion}/queue`);
      return response.data.records || [];
    } catch (error) {
      log(this.name, `Error fetching queue: ${error.message}`);
      return [];
    }
  }

  async getItem(id, endpoint) {
    try {
      const response = await this.axios.get(`/api/${this.apiVersion}/${endpoint}/${id}`);
      return response.data;
    } catch (error) {
      log(this.name, `Error fetching item ${id}: ${error.message}`);
      return null;
    }
  }

  async updateItem(id, endpoint, data) {
    try {
      const response = await this.axios.put(`/api/${this.apiVersion}/${endpoint}/${id}?moveFiles=false`, data);
      return response.data;
    } catch (error) {
      log(this.name, `Error updating item ${id}: ${error.message}`);
      return null;
    }
  }

  async triggerCommand(command) {
    try {
      await this.axios.post(`/api/${this.apiVersion}/command`, command);
      return true;
    } catch (error) {
      log(this.name, `Error triggering command: ${error.message}`);
      return false;
    }
  }

  async removeFromQueue(id) {
    try {
      await this.axios.delete(`/api/${this.apiVersion}/queue/${id}?removeFromClient=false&blocklist=false`);
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

  normalizeTitle(title) {
    // Remove special characters, year, quality tags, etc. for matching
    return title
      .toLowerCase()
      .replace(/\b(19|20)\d{2}\b/g, '') // Remove years
      .replace(/\b(480|720|1080|2160)p?\b/gi, '') // Remove resolutions
      .replace(/\b(bluray|webrip|webdl|hdtv|brrip|dvdrip|remux|avc|hevc|x264|x265)\b/gi, '')
      .replace(/\b(dts|ac3|aac|ma|flac|mp3|m4a)\b/gi, '') // Remove audio codecs
      .replace(/[^a-z0-9]/g, '')
      .trim();
  }
}

// NzbDAV history fetcher
async function fetchNzbdavHistory() {
  try {
    const params = {
      mode: 'history',
      apikey: CONFIG.nzbdav.apiKey,
      start: '0',
      limit: String(CONFIG.nzbdav.historyLimit),
      output: 'json'
    };

    const headers = {};
    if (CONFIG.nzbdav.apiKey) {
      headers['x-api-key'] = CONFIG.nzbdav.apiKey;
    }

    const response = await axios.get(`${CONFIG.nzbdav.url}/api`, {
      params,
      headers,
      timeout: 10000
    });

    const history = response.data?.history || response.data?.History;
    const slots = history?.slots || history?.Slots || [];

    // Only return completed items
    return slots.filter(slot => {
      const status = (slot?.status || slot?.Status || '').toString().toLowerCase();
      return status === 'completed';
    });
  } catch (error) {
    log('NzbDAV', `Error fetching history: ${error.message}`);
    return [];
  }
}

// Radarr-specific handler
class RadarrMonitor extends ArrClient {
  async getAllMovies() {
    try {
      const response = await this.axios.get(`/api/${this.apiVersion}/movie`);
      return response.data || [];
    } catch (error) {
      log(this.name, `Error fetching movies: ${error.message}`);
      return [];
    }
  }

  async processHistory(nzbdavHistory) {
    const movies = await this.getAllMovies();

    for (const historyItem of nzbdavHistory) {
      const jobName = historyItem.job_name || historyItem.name || '';
      const category = (historyItem.category || historyItem.Category || '').toLowerCase();

      // Only process movies category
      if (!category.includes('movie')) continue;

      const normalizedJob = this.normalizeTitle(jobName);

      // Find matching movie
      const movie = movies.find(m => {
        const normalizedTitle = this.normalizeTitle(m.title);
        return normalizedJob.includes(normalizedTitle) || normalizedTitle.includes(normalizedJob);
      });

      if (!movie) {
        log(this.name, `No matching movie found for: ${jobName}`);
        continue;
      }

      // Skip if already has file
      if (movie.hasFile) {
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
        }
      } else {
        log(this.name, `[DRY RUN] Would update path and refresh`);
      }
    }
  }
}

// Sonarr-specific handler
class SonarrMonitor extends ArrClient {
  async getAllSeries() {
    try {
      const response = await this.axios.get(`/api/${this.apiVersion}/series`);
      return response.data || [];
    } catch (error) {
      log(this.name, `Error fetching series: ${error.message}`);
      return [];
    }
  }

  parseEpisodeInfo(jobName) {
    // Try to extract season and episode numbers from release name
    // Supports formats: S01E02, S01E02E03, 1x02, etc.
    const patterns = [
      /[Ss](\d+)[Ee](\d+)(?:[Ee](\d+))?/,  // S01E02 or S01E02E03
      /(\d+)x(\d+)/,                        // 1x02
      /[Ee]pisode[.\s](\d+)/i,              // Episode 02
    ];

    for (const pattern of patterns) {
      const match = jobName.match(pattern);
      if (match) {
        const season = parseInt(match[1]) || 1;
        const episode = parseInt(match[2]);
        return { season, episode };
      }
    }

    return null;
  }

  async getEpisode(seriesId, season, episode) {
    try {
      const response = await this.axios.get(`/api/${this.apiVersion}/episode`, {
        params: { seriesId }
      });
      const episodes = response.data || [];
      return episodes.find(e => e.seasonNumber === season && e.episodeNumber === episode);
    } catch (error) {
      log(this.name, `Error fetching episodes: ${error.message}`);
      return null;
    }
  }

  async registerEpisodeFile(episodeFile, episodeIds) {
    try {
      const payload = {
        path: episodeFile.path,
        seriesId: episodeFile.seriesId,
        episodeIds: episodeIds,
        quality: episodeFile.quality,
        releaseGroup: episodeFile.releaseGroup,
        sceneName: episodeFile.sceneName
      };

      const response = await this.axios.post(`/api/${this.apiVersion}/episodefile`, payload);
      return response.data;
    } catch (error) {
      log(this.name, `Error registering episode file: ${error.message}`);
      return null;
    }
  }

  async processHistory(nzbdavHistory) {
    const allSeries = await this.getAllSeries();

    for (const historyItem of nzbdavHistory) {
      const jobName = historyItem.job_name || historyItem.name || '';
      const category = (historyItem.category || historyItem.Category || '').toLowerCase();

      // Only process TV category
      if (!category.includes('tv') && !category.includes('sonarr')) continue;

      // Parse episode information
      const episodeInfo = this.parseEpisodeInfo(jobName);
      if (!episodeInfo) {
        log(this.name, `Could not parse episode info from: ${jobName}`);
        continue;
      }

      const normalizedJob = this.normalizeTitle(jobName);

      // Find matching series
      const series = allSeries.find(s => {
        const normalizedTitle = this.normalizeTitle(s.title);
        return normalizedJob.includes(normalizedTitle) || normalizedTitle.includes(normalizedJob);
      });

      if (!series) {
        log(this.name, `No matching series found for: ${jobName}`);
        continue;
      }

      // Get the specific episode
      const episode = await this.getEpisode(series.id, episodeInfo.season, episodeInfo.episode);
      if (!episode) {
        log(this.name, `Episode S${episodeInfo.season}E${episodeInfo.episode} not found for ${series.title}`);
        continue;
      }

      // Check if episode already has a file
      if (episode.hasFile) {
        log(this.name, `${series.title} S${episodeInfo.season}E${episodeInfo.episode} already has file`);
        continue;
      }

      // Find the actual video file in the download directory
      const downloadPath = path.join(this.config.mountPath, jobName);
      let videoFile = null;

      try {
        if (fs.existsSync(downloadPath)) {
          const files = fs.readdirSync(downloadPath);
          videoFile = files.find(f => /\.(mkv|mp4|avi|mov)$/i.test(f));
        }
      } catch (error) {
        log(this.name, `Error scanning directory ${downloadPath}: ${error.message}`);
        continue;
      }

      if (!videoFile) {
        log(this.name, `No video file found in ${downloadPath}`);
        continue;
      }

      const fullPath = path.join(downloadPath, videoFile);
      log(this.name, `Registering ${series.title} S${episodeInfo.season}E${episodeInfo.episode}: ${fullPath}`);

      if (!CONFIG.dryRun) {
        const episodeFile = {
          path: fullPath,
          seriesId: series.id,
          quality: { quality: { id: 1, name: 'Unknown' } },
          releaseGroup: '',
          sceneName: jobName
        };

        const registered = await this.registerEpisodeFile(episodeFile, [episode.id]);
        if (registered) {
          log(this.name, `✅ Successfully registered: ${series.title} S${episodeInfo.season}E${episodeInfo.episode}`);
        }
      } else {
        log(this.name, `[DRY RUN] Would register episode file: ${fullPath}`);
      }
    }
  }
}

// Lidarr-specific handler
class LidarrMonitor extends ArrClient {
  async getAllArtists() {
    try {
      const response = await this.axios.get(`/api/${this.apiVersion}/artist`);
      return response.data || [];
    } catch (error) {
      log(this.name, `Error fetching artists: ${error.message}`);
      return [];
    }
  }

  async processHistory(nzbdavHistory) {
    const allArtists = await this.getAllArtists();

    for (const historyItem of nzbdavHistory) {
      const jobName = historyItem.job_name || historyItem.name || '';
      const category = (historyItem.category || historyItem.Category || '').toLowerCase();

      // Only process music category
      if (!category.includes('music') && !category.includes('lidarr')) continue;

      const normalizedJob = this.normalizeTitle(jobName);

      // Find matching artist
      const artist = allArtists.find(a => {
        const normalizedName = this.normalizeTitle(a.artistName);
        return normalizedJob.includes(normalizedName) || normalizedName.includes(normalizedJob);
      });

      if (!artist) {
        log(this.name, `No matching artist found for: ${jobName}`);
        continue;
      }

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
    monitors.push(new LidarrMonitor('Lidarr', CONFIG.lidarr, 'v1'));
  }

  if (monitors.length === 0) {
    log('Main', 'No services enabled! Check environment variables.');
    process.exit(1);
  }

  if (!CONFIG.nzbdav.url || !CONFIG.nzbdav.apiKey) {
    log('Main', 'NzbDAV URL and API key are required!');
    process.exit(1);
  }

  log('Main', `Starting monitors: ${monitors.map(m => m.name).join(', ')}`);
  log('Main', `NzbDAV URL: ${CONFIG.nzbdav.url}`);
  log('Main', `Poll interval: ${CONFIG.pollInterval / 1000}s`);
  log('Main', `Dry run: ${CONFIG.dryRun}`);

  async function poll() {
    // Fetch NzbDAV history once
    const nzbdavHistory = await fetchNzbdavHistory();
    log('Main', `Found ${nzbdavHistory.length} completed downloads in NzbDAV history`);

    // Process history with each monitor
    for (const monitor of monitors) {
      try {
        await monitor.processHistory(nzbdavHistory);
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
