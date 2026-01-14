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

// Common release groups to remove from matching
const RELEASE_GROUPS = [
  'lama', 'yify', 'rarbg', 'ettv', 'eztv', 'sparks', 'geckos', 'fleet',
  'ntb', 'ctrlhd', 'epsilon', 'fgt', 'ion10', 'memento', 'playbd', 'framestor',
  'triton', 'unknown', 'flux', 'smurf', 'stringerbell', 'kontrast', 'psa',
  'turg', 'aaa', 'welp', 'taxes', 'entitled', 'gp', 'privatehd'
];

// Extract year from a string (returns null if not found)
function extractYear(str) {
  const match = str.match(/\b(19|20)\d{2}\b/);
  return match ? parseInt(match[0]) : null;
}

// Extract title words for matching (removes noise, keeps meaningful words)
function extractTitleWords(str) {
  return str
    .toLowerCase()
    // Remove years
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    // Remove resolutions
    .replace(/\b(480|720|1080|2160)[pi]?\b/gi, ' ')
    // Remove video codecs
    .replace(/\b(bluray|blu-ray|webrip|web-rip|webdl|web-dl|hdtv|brrip|dvdrip|remux|avc|hevc|x264|x265|h264|h265|vc-?1|10bit)\b/gi, ' ')
    // Remove audio codecs
    .replace(/\b(dts|dts-hd|ac3|aac|flac|mp3|m4a|truehd|atmos|ma|5\.1|7\.1|2\.0)\b/gi, ' ')
    // Remove common tags
    .replace(/\b(repack|proper|extended|unrated|directors\.?cut|theatrical|imax|3d|hdr|hdr10|dolby\.?vision|dv)\b/gi, ' ')
    // Remove release groups
    .replace(new RegExp(`\\b(${RELEASE_GROUPS.join('|')})\\b`, 'gi'), ' ')
    // Remove episode/season markers for movies
    .replace(/\bs\d+e\d+\b/gi, ' ')
    // Replace separators with spaces
    .replace(/[._-]+/g, ' ')
    // Remove non-alphanumeric (keep spaces)
    .replace(/[^a-z0-9\s]/g, ' ')
    // Collapse whitespace and split
    .split(/\s+/)
    .filter(word => word.length > 1); // Remove single chars
}

// Calculate match score between two sets of words (0-1)
function calculateMatchScore(words1, words2) {
  if (words1.length === 0 || words2.length === 0) return 0;

  const set1 = new Set(words1);
  const set2 = new Set(words2);

  // Count matching words
  let matches = 0;
  for (const word of set1) {
    if (set2.has(word)) matches++;
  }

  // Score is based on how many of the smaller set's words are found in the larger
  const minSize = Math.min(set1.size, set2.size);
  return matches / minSize;
}

// Find best matching item from a list using word-based matching
function findBestMatch(targetTitle, targetYear, items, getTitleFn, getYearFn = null) {
  const targetWords = extractTitleWords(targetTitle);

  let bestMatch = null;
  let bestScore = 0;
  const MIN_SCORE = 0.6; // Minimum 60% word overlap required

  for (const item of items) {
    const itemTitle = getTitleFn(item);
    const itemWords = extractTitleWords(itemTitle);
    const itemYear = getYearFn ? getYearFn(item) : extractYear(itemTitle);

    let score = calculateMatchScore(targetWords, itemWords);

    // Boost score if years match
    if (targetYear && itemYear && targetYear === itemYear) {
      score += 0.2;
    }
    // Penalize if years exist but don't match
    else if (targetYear && itemYear && Math.abs(targetYear - itemYear) > 1) {
      score -= 0.3;
    }

    if (score > bestScore && score >= MIN_SCORE) {
      bestScore = score;
      bestMatch = item;
    }
  }

  return { match: bestMatch, score: bestScore };
}

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

  findActualPath(releaseName, mountPath) {
    try {
      if (!fs.existsSync(mountPath)) {
        log(this.name, `Mount path doesn't exist: ${mountPath}`);
        return null;
      }

      const directories = fs.readdirSync(mountPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      // First try exact match (release name matches directory name)
      const releaseNormalized = releaseName.toLowerCase().replace(/[^a-z0-9]/g, '');
      for (const dir of directories) {
        const dirNormalized = dir.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (dirNormalized === releaseNormalized) {
          const fullPath = path.join(mountPath, dir);
          if (this.hasMediaFiles(fullPath)) {
            log(this.name, `Found exact match: ${fullPath}`);
            return fullPath;
          }
        }
      }

      // Fall back to word-based matching
      const releaseWords = extractTitleWords(releaseName);
      const releaseYear = extractYear(releaseName);

      let bestMatch = null;
      let bestScore = 0;
      const MIN_SCORE = 0.7; // Higher threshold for directory matching

      for (const dir of directories) {
        const dirWords = extractTitleWords(dir);
        const dirYear = extractYear(dir);

        let score = calculateMatchScore(releaseWords, dirWords);

        // Boost score if years match
        if (releaseYear && dirYear && releaseYear === dirYear) {
          score += 0.2;
        }

        if (score > bestScore && score >= MIN_SCORE) {
          const fullPath = path.join(mountPath, dir);
          if (this.hasMediaFiles(fullPath)) {
            bestScore = score;
            bestMatch = fullPath;
          }
        }
      }

      if (bestMatch) {
        log(this.name, `Found matching path (score: ${bestScore.toFixed(2)}): ${bestMatch}`);
        return bestMatch;
      }

      log(this.name, `No matching directory found for: ${releaseName}`);
      return null;
    } catch (error) {
      log(this.name, `Error finding actual path: ${error.message}`);
      return null;
    }
  }

  hasMediaFiles(dirPath) {
    try {
      const files = fs.readdirSync(dirPath);
      return files.some(f => /\.(mkv|mp4|avi|mov|flac|mp3|m4a)$/i.test(f));
    } catch {
      return false;
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
  constructor(name, config, apiVersion = 'v3') {
    super(name, config, apiVersion);
    // Track recently searched movies to avoid repeated searches
    this.recentlySearched = new Map(); // movieId -> timestamp
    this.searchCooldownMs = 24 * 60 * 60 * 1000; // 24 hours
  }

  async getAllMovies() {
    try {
      const response = await this.axios.get(`/api/${this.apiVersion}/movie`);
      return response.data || [];
    } catch (error) {
      log(this.name, `Error fetching movies: ${error.message}`);
      return [];
    }
  }

  async triggerSearchForIncompleteDownload(movie, originalRelease) {
    // Check cooldown to avoid repeated searches
    const lastSearch = this.recentlySearched.get(movie.id);
    if (lastSearch && (Date.now() - lastSearch) < this.searchCooldownMs) {
      const hoursAgo = ((Date.now() - lastSearch) / (60 * 60 * 1000)).toFixed(1);
      log(this.name, `Skipping search for "${movie.title}" - already searched ${hoursAgo}h ago`);
      return;
    }

    log(this.name, `Triggering search for incomplete download: "${movie.title}" (was: ${originalRelease})`);

    if (!CONFIG.dryRun) {
      const success = await this.triggerCommand({
        name: 'MoviesSearch',
        movieIds: [movie.id]
      });

      if (success) {
        this.recentlySearched.set(movie.id, Date.now());
        log(this.name, `✅ Search triggered for: ${movie.title}`);
      } else {
        log(this.name, `❌ Failed to trigger search for: ${movie.title}`);
      }
    } else {
      log(this.name, `[DRY RUN] Would trigger search for: ${movie.title}`);
    }
  }

  async processHistory(nzbdavHistory) {
    const movies = await this.getAllMovies();

    for (const historyItem of nzbdavHistory) {
      const jobName = historyItem.job_name || historyItem.name || '';
      const category = (historyItem.category || historyItem.Category || '').toLowerCase();

      // Only process movies category
      if (!category.includes('movie')) continue;

      // Extract year from release name for better matching
      const releaseYear = extractYear(jobName);

      // Use improved word-based matching
      const { match: movie, score } = findBestMatch(
        jobName,
        releaseYear,
        movies,
        m => m.title,
        m => m.year
      );

      if (!movie) {
        log(this.name, `No matching movie found for: ${jobName}`);
        continue;
      }

      log(this.name, `Matched "${jobName}" to "${movie.title}" (score: ${score.toFixed(2)})`);

      // Skip if already has file
      if (movie.hasFile) {
        continue;
      }

      const actualPath = this.findActualPath(jobName, this.config.mountPath);

      // If no media files found on disk, the download likely failed - trigger a new search
      if (!actualPath) {
        log(this.name, `No media files found for "${movie.title}" - download appears incomplete`);
        await this.triggerSearchForIncompleteDownload(movie, jobName);
        continue;
      }

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
  constructor(name, config, apiVersion = 'v3') {
    super(name, config, apiVersion);
    // Track recently searched episodes to avoid repeated searches
    this.recentlySearched = new Map(); // "seriesId-season-episode" -> timestamp
    this.searchCooldownMs = 24 * 60 * 60 * 1000; // 24 hours
  }

  async triggerSearchForIncompleteDownload(series, episode, originalRelease) {
    const searchKey = `${series.id}-${episode.seasonNumber}-${episode.episodeNumber}`;
    const lastSearch = this.recentlySearched.get(searchKey);

    if (lastSearch && (Date.now() - lastSearch) < this.searchCooldownMs) {
      const hoursAgo = ((Date.now() - lastSearch) / (60 * 60 * 1000)).toFixed(1);
      log(this.name, `Skipping search for "${series.title}" S${episode.seasonNumber}E${episode.episodeNumber} - already searched ${hoursAgo}h ago`);
      return;
    }

    log(this.name, `Triggering search for incomplete download: "${series.title}" S${episode.seasonNumber}E${episode.episodeNumber} (was: ${originalRelease})`);

    if (!CONFIG.dryRun) {
      const success = await this.triggerCommand({
        name: 'EpisodeSearch',
        episodeIds: [episode.id]
      });

      if (success) {
        this.recentlySearched.set(searchKey, Date.now());
        log(this.name, `✅ Search triggered for: ${series.title} S${episode.seasonNumber}E${episode.episodeNumber}`);
      } else {
        log(this.name, `❌ Failed to trigger search for: ${series.title} S${episode.seasonNumber}E${episode.episodeNumber}`);
      }
    } else {
      log(this.name, `[DRY RUN] Would trigger search for: ${series.title} S${episode.seasonNumber}E${episode.episodeNumber}`);
    }
  }

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
      // Use the command API with ManualImport to register the episode file
      const files = [{
        path: episodeFile.path,
        seriesId: episodeFile.seriesId,
        episodeIds: episodeIds,
        quality: episodeFile.quality,
        releaseGroup: episodeFile.releaseGroup || ''
      }];

      const command = {
        name: 'ManualImport',
        files: files,
        importMode: 'auto'
      };

      const response = await this.axios.post(`/api/${this.apiVersion}/command`, command);
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

      // Use improved word-based matching
      const { match: series, score } = findBestMatch(
        jobName,
        null, // TV shows don't typically have year in release name
        allSeries,
        s => s.title,
        s => s.year
      );

      if (!series) {
        log(this.name, `No matching series found for: ${jobName}`);
        continue;
      }

      log(this.name, `Matched "${jobName}" to "${series.title}" (score: ${score.toFixed(2)})`);

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
        log(this.name, `No video file found in ${downloadPath} - download appears incomplete`);
        await this.triggerSearchForIncompleteDownload(series, episode, jobName);
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
  constructor(name, config, apiVersion = 'v1') {
    super(name, config, apiVersion);
    // Track recently searched artists to avoid repeated searches
    this.recentlySearched = new Map(); // artistId -> timestamp
    this.searchCooldownMs = 24 * 60 * 60 * 1000; // 24 hours
  }

  async triggerSearchForIncompleteDownload(artist, originalRelease) {
    const lastSearch = this.recentlySearched.get(artist.id);

    if (lastSearch && (Date.now() - lastSearch) < this.searchCooldownMs) {
      const hoursAgo = ((Date.now() - lastSearch) / (60 * 60 * 1000)).toFixed(1);
      log(this.name, `Skipping search for "${artist.artistName}" - already searched ${hoursAgo}h ago`);
      return;
    }

    log(this.name, `Triggering search for incomplete download: "${artist.artistName}" (was: ${originalRelease})`);

    if (!CONFIG.dryRun) {
      const success = await this.triggerCommand({
        name: 'ArtistSearch',
        artistId: artist.id
      });

      if (success) {
        this.recentlySearched.set(artist.id, Date.now());
        log(this.name, `✅ Search triggered for: ${artist.artistName}`);
      } else {
        log(this.name, `❌ Failed to trigger search for: ${artist.artistName}`);
      }
    } else {
      log(this.name, `[DRY RUN] Would trigger search for: ${artist.artistName}`);
    }
  }

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

      // Use improved word-based matching
      const { match: artist, score } = findBestMatch(
        jobName,
        null,
        allArtists,
        a => a.artistName,
        null
      );

      if (!artist) {
        log(this.name, `No matching artist found for: ${jobName}`);
        continue;
      }

      log(this.name, `Matched "${jobName}" to "${artist.artistName}" (score: ${score.toFixed(2)})`);

      const actualPath = this.findActualPath(jobName, this.config.mountPath);

      // If no media files found on disk, the download likely failed - trigger a new search
      if (!actualPath) {
        log(this.name, `No media files found for "${artist.artistName}" - download appears incomplete`);
        await this.triggerSearchForIncompleteDownload(artist, jobName);
        continue;
      }

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
