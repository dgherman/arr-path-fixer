#!/usr/bin/env node

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Configuration from environment variables
const CONFIG = {
  nzbdav: {
    url: process.env.NZBDAV_URL,
    apiKey: process.env.NZBDAV_API_KEY
  },
  radarr: {
    enabled: process.env.RADARR_ENABLED === 'true',
    url: process.env.RADARR_URL,
    apiKey: process.env.RADARR_API_KEY,
    mountPath: process.env.RADARR_MOUNT_PATH || '/mnt/nzbdav/content/movies',
    categories: (process.env.RADARR_CATEGORIES || 'movies').toLowerCase().split(',').map(s => s.trim())
  },
  sonarr: {
    enabled: process.env.SONARR_ENABLED === 'true',
    url: process.env.SONARR_URL,
    apiKey: process.env.SONARR_API_KEY,
    mountPath: process.env.SONARR_MOUNT_PATH || '/mnt/nzbdav/content/tv',
    dbPath: process.env.SONARR_DB_PATH || '/config/sonarr/sonarr.db',
    categories: (process.env.SONARR_CATEGORIES || 'tv').toLowerCase().split(',').map(s => s.trim())
  },
  lidarr: {
    enabled: process.env.LIDARR_ENABLED === 'true',
    url: process.env.LIDARR_URL,
    apiKey: process.env.LIDARR_API_KEY,
    mountPath: process.env.LIDARR_MOUNT_PATH || '/mnt/nzbdav/content/music',
    dbPath: process.env.LIDARR_DB_PATH || '/config/lidarr/lidarr.db',
    categories: (process.env.LIDARR_CATEGORIES || 'music').toLowerCase().split(',').map(s => s.trim())
  },
  pollInterval: parseInt(process.env.POLL_INTERVAL_SECONDS || '60') * 1000,
  searchCooldownMs: parseInt(process.env.SEARCH_COOLDOWN_MINUTES || '1440') * 60 * 1000, // Default 24 hours
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
      const response = await this.axios.get(`/api/${this.apiVersion}/queue?includeUnknownSeriesItems=true&pageSize=1000`);
      return response.data.records || [];
    } catch (error) {
      log(this.name, `Error fetching queue: ${error.message}`);
      return [];
    }
  }

  async clearFailedQueueEntries(filterFn) {
    try {
      const queue = await this.getQueue();
      const failedEntries = queue.filter(item => item.status === 'failed' && filterFn(item));

      for (const entry of failedEntries) {
        await this.removeFromQueue(entry.id);
        log(this.name, `Cleared failed queue entry: ${entry.title}`);
      }

      return failedEntries.length;
    } catch (error) {
      log(this.name, `Error clearing failed queue entries: ${error.message}`);
      return 0;
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
      let exactMatchFound = false;
      for (const dir of directories) {
        const dirNormalized = dir.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (dirNormalized === releaseNormalized) {
          exactMatchFound = true;
          const fullPath = path.join(mountPath, dir);
          if (this.hasMediaFiles(fullPath)) {
            log(this.name, `Found exact match: ${fullPath}`);
            return fullPath;
          }
          // Exact match exists but no media files - check for numbered versions
          const numberedPath = this.findNumberedVersion(fullPath, dir);
          if (numberedPath) {
            return numberedPath;
          }
        }
      }

      // If no exact match directory exists, check if numbered versions exist directly
      if (!exactMatchFound) {
        const basePath = path.join(mountPath, releaseName);
        const numberedPath = this.findNumberedVersion(basePath, releaseName);
        if (numberedPath) {
          return numberedPath;
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

  // Find directory with numbered suffix (e.g., "Release (2)", "Release (3)") that has media files
  findNumberedVersion(basePath, baseName) {
    try {
      const parentDir = path.dirname(basePath);
      if (!fs.existsSync(parentDir)) return null;

      const directories = fs.readdirSync(parentDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      // Look for numbered versions: "baseName (2)", "baseName (3)", etc.
      const numberedPattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\((\\d+)\\)$`);

      const numberedVersions = directories
        .filter(dir => numberedPattern.test(dir))
        .map(dir => ({
          name: dir,
          number: parseInt(dir.match(numberedPattern)[1])
        }))
        .sort((a, b) => b.number - a.number); // Sort descending (newest first)

      // Return the first numbered version that has media files
      for (const version of numberedVersions) {
        const fullPath = path.join(parentDir, version.name);
        if (this.hasMediaFiles(fullPath)) {
          log(this.name, `Found numbered version with media: ${fullPath}`);
          return fullPath;
        }
      }

      return null;
    } catch (error) {
      log(this.name, `Error finding numbered version: ${error.message}`);
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

// NzbDAV history fetcher - fetches all completed downloads
async function fetchNzbdavHistory() {
  try {
    const params = {
      mode: 'history',
      apikey: CONFIG.nzbdav.apiKey,
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
    this.searchCooldownMs = CONFIG.searchCooldownMs;
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

      // Only process configured categories
      if (!this.config.categories.some(cat => category.includes(cat))) continue;

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
          // Clear any failed queue entries for this movie
          await this.clearFailedQueueEntries(item => item.movieId === movie.id);
        }
      } else {
        log(this.name, `[DRY RUN] Would update path and refresh`);
      }
    }
  }

  async cleanupStaleFiles() {
    log(this.name, 'Checking for stale movie files...');
    const movies = await this.getAllMovies();
    const moviesWithFiles = movies.filter(m => m.hasFile && m.movieFile);
    let cleanedCount = 0;

    for (const movie of moviesWithFiles) {
      const filePath = movie.movieFile.path;

      // Only check files in our mount path
      if (!filePath || !filePath.startsWith(this.config.mountPath)) continue;

      // Check if file exists on disk
      if (!fs.existsSync(filePath)) {
        log(this.name, `Stale file detected: "${movie.title}" - ${filePath}`);

        if (!CONFIG.dryRun) {
          try {
            // Delete the movie file record via API
            await this.axios.delete(`/api/${this.apiVersion}/moviefile/${movie.movieFile.id}`);
            log(this.name, `Deleted stale movie file record for: ${movie.title}`);

            // Trigger a search for the now-missing movie
            await this.triggerSearchForIncompleteDownload(movie, movie.title);
            cleanedCount++;
          } catch (error) {
            log(this.name, `Failed to delete movie file: ${error.message}`);
          }
        } else {
          log(this.name, `[DRY RUN] Would delete stale file and trigger search`);
          cleanedCount++;
        }
      }
    }

    if (cleanedCount > 0) {
      log(this.name, `🧹 Cleaned up ${cleanedCount} stale movie files`);
    }
    return cleanedCount;
  }
}

// Sonarr-specific handler
class SonarrMonitor extends ArrClient {
  constructor(name, config, apiVersion = 'v3') {
    super(name, config, apiVersion);
    // Track recently searched episodes to avoid repeated searches
    this.recentlySearched = new Map(); // "seriesId-season-episode" -> timestamp
    this.searchCooldownMs = CONFIG.searchCooldownMs;
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

  parseSeasonInfo(jobName) {
    // Detect season-only patterns (season packs without episode numbers)
    const patterns = [
      /[Ss](\d+)(?![Ee]\d)/,           // S01 not followed by E##
      /[Ss]eason[.\s_-]?(\d+)/i,       // Season 1, Season.1, Season_1
      /[._-]S(\d+)[._-]/,              // .S01. or _S01_ or -S01-
    ];

    for (const pattern of patterns) {
      const match = jobName.match(pattern);
      if (match) {
        const season = parseInt(match[1]);
        // Verify this isn't actually an episode pattern we missed
        if (!/[Ss]\d+[Ee]\d+/.test(jobName)) {
          return { season };
        }
      }
    }

    return null;
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

  async getAllEpisodes(seriesId) {
    try {
      const response = await this.axios.get(`/api/${this.apiVersion}/episode`, {
        params: { seriesId }
      });
      return response.data || [];
    } catch (error) {
      log(this.name, `Error fetching episodes: ${error.message}`);
      return [];
    }
  }

  async triggerSeasonSearch(series, seasonNumber) {
    const searchKey = `${series.id}-season-${seasonNumber}`;
    const lastSearch = this.recentlySearched.get(searchKey);

    if (lastSearch && (Date.now() - lastSearch) < this.searchCooldownMs) {
      const hoursAgo = ((Date.now() - lastSearch) / (60 * 60 * 1000)).toFixed(1);
      log(this.name, `Skipping search for "${series.title}" Season ${seasonNumber} - already searched ${hoursAgo}h ago`);
      return;
    }

    log(this.name, `Triggering search for incomplete season pack: "${series.title}" Season ${seasonNumber}`);

    if (!CONFIG.dryRun) {
      const success = await this.triggerCommand({
        name: 'SeasonSearch',
        seriesId: series.id,
        seasonNumber: seasonNumber
      });

      if (success) {
        this.recentlySearched.set(searchKey, Date.now());
        log(this.name, `✅ Season search triggered for: ${series.title} Season ${seasonNumber}`);
      } else {
        log(this.name, `❌ Failed to trigger season search for: ${series.title} Season ${seasonNumber}`);
      }
    } else {
      log(this.name, `[DRY RUN] Would trigger season search for: ${series.title} Season ${seasonNumber}`);
    }
  }

  async processSeasonPack(series, seasonNumber, downloadPath, jobName) {
    log(this.name, `Processing season pack: ${series.title} Season ${seasonNumber}`);

    // Get all episodes for this series
    const allEpisodes = await this.getAllEpisodes(series.id);
    const seasonEpisodes = allEpisodes.filter(e => e.seasonNumber === seasonNumber);

    if (seasonEpisodes.length === 0) {
      log(this.name, `No episodes found in Sonarr for ${series.title} Season ${seasonNumber}`);
      return;
    }

    // Check if directory exists and has files
    let videoFiles = [];
    let actualDownloadPath = downloadPath;
    try {
      if (fs.existsSync(downloadPath)) {
        const files = fs.readdirSync(downloadPath);
        videoFiles = files.filter(f => /\.(mkv|mp4|avi|mov)$/i.test(f));
      }

      // If no video files in original path, check for numbered versions (2), (3), etc.
      if (videoFiles.length === 0) {
        const numberedPath = this.findNumberedVersion(downloadPath, jobName);
        if (numberedPath) {
          actualDownloadPath = numberedPath;
          const files = fs.readdirSync(numberedPath);
          videoFiles = files.filter(f => /\.(mkv|mp4|avi|mov)$/i.test(f));
        }
      }
    } catch (error) {
      log(this.name, `Error scanning directory ${downloadPath}: ${error.message}`);
    }

    if (videoFiles.length === 0) {
      log(this.name, `No video files found in season pack directory - download appears incomplete`);
      await this.triggerSeasonSearch(series, seasonNumber);
      return;
    }

    log(this.name, `Found ${videoFiles.length} video files in season pack (${actualDownloadPath})`);

    // Match video files to episodes
    let registeredCount = 0;
    let alreadyHaveCount = 0;

    for (const videoFile of videoFiles) {
      // Parse episode info from the video filename
      const fileEpisodeInfo = this.parseEpisodeInfo(videoFile);
      if (!fileEpisodeInfo) {
        log(this.name, `Could not parse episode info from file: ${videoFile}`);
        continue;
      }

      // Find matching episode in Sonarr
      const episode = seasonEpisodes.find(
        e => e.seasonNumber === fileEpisodeInfo.season && e.episodeNumber === fileEpisodeInfo.episode
      );

      if (!episode) {
        log(this.name, `No Sonarr episode found for S${fileEpisodeInfo.season}E${fileEpisodeInfo.episode}`);
        continue;
      }

      if (episode.hasFile) {
        alreadyHaveCount++;
        continue;
      }

      const fullPath = path.join(actualDownloadPath, videoFile);
      log(this.name, `Registering ${series.title} S${fileEpisodeInfo.season}E${fileEpisodeInfo.episode}: ${videoFile}`);

      if (!CONFIG.dryRun) {
        const episodeFile = {
          path: fullPath,
          seriesId: series.id,
          seasonNumber: fileEpisodeInfo.season,
          quality: { quality: { id: 1, name: 'Unknown' } },
          releaseGroup: '',
          sceneName: videoFile
        };

        const registered = await this.registerEpisodeFile(episodeFile, [episode.id]);
        if (registered) {
          registeredCount++;
          // Clear any failed queue entries for this episode
          await this.clearFailedQueueEntries(item =>
            item.seriesId === series.id &&
            item.episodeId === episode.id
          );
        }
      } else {
        log(this.name, `[DRY RUN] Would register: ${fullPath}`);
        registeredCount++;
      }
    }

    if (registeredCount > 0) {
      log(this.name, `✅ Registered ${registeredCount} episodes for ${series.title} Season ${seasonNumber}`);
    }
    if (alreadyHaveCount > 0) {
      log(this.name, `ℹ️  ${alreadyHaveCount} episodes already had files`);
    }

    // Check if any episodes are still missing files after processing
    const missingEpisodes = seasonEpisodes.filter(e => !e.hasFile && e.monitored);
    const processedFiles = videoFiles.filter(f => this.parseEpisodeInfo(f) !== null);

    if (missingEpisodes.length > processedFiles.length) {
      log(this.name, `Season pack incomplete: ${missingEpisodes.length} episodes expected, ${processedFiles.length} files found`);
      // Don't trigger search here - the files might just need to be imported first
    }
  }

  getDatabase() {
    if (!this._db) {
      if (!fs.existsSync(this.config.dbPath)) {
        log(this.name, `Database not found at: ${this.config.dbPath}`);
        return null;
      }
      this._db = new Database(this.config.dbPath);
    }
    return this._db;
  }

  async ensureSeriesPath(seriesId) {
    // Ensure series path is set to mount path root for relative paths to work
    const db = this.getDatabase();
    if (!db) return false;

    try {
      const series = db.prepare('SELECT Id, Path FROM Series WHERE Id = ?').get(seriesId);
      if (series && series.Path !== this.config.mountPath) {
        log(this.name, `Updating series ${seriesId} path from "${series.Path}" to "${this.config.mountPath}"`);
        db.prepare('UPDATE Series SET Path = ? WHERE Id = ?').run(this.config.mountPath, seriesId);
      }
      return true;
    } catch (error) {
      log(this.name, `Error updating series path: ${error.message}`);
      return false;
    }
  }

  async registerEpisodeFile(episodeFile, episodeIds) {
    const db = this.getDatabase();
    if (!db) {
      log(this.name, 'Database not available, falling back to API (will likely fail on read-only filesystem)');
      return this.registerEpisodeFileViaApi(episodeFile, episodeIds);
    }

    try {
      // Ensure series path is set correctly
      await this.ensureSeriesPath(episodeFile.seriesId);

      // Get file size
      let fileSize = 0;
      try {
        const stats = fs.statSync(episodeFile.path);
        fileSize = stats.size;
      } catch (e) {
        log(this.name, `Could not get file size: ${e.message}`);
      }

      // Calculate relative path from mount path
      const relativePath = episodeFile.path.replace(this.config.mountPath + '/', '');

      // Extract release group from scene name
      const releaseGroupMatch = episodeFile.sceneName?.match(/-([A-Za-z0-9]+)$/);
      const releaseGroup = releaseGroupMatch ? releaseGroupMatch[1] : '';

      // Check if episode file already exists for this path
      const existingFile = db.prepare(
        'SELECT Id FROM EpisodeFiles WHERE SeriesId = ? AND RelativePath = ?'
      ).get(episodeFile.seriesId, relativePath);

      if (existingFile) {
        log(this.name, `Episode file already registered with ID ${existingFile.Id}`);
        // Update episode to link to existing file
        for (const episodeId of episodeIds) {
          db.prepare('UPDATE Episodes SET EpisodeFileId = ? WHERE Id = ?').run(existingFile.Id, episodeId);
        }
        return { id: existingFile.Id };
      }

      // Insert new episode file record
      // Quality format: {"quality": <id>, "revision": {"version": 1, "real": 0, "isRepack": false}}
      // Languages format: [1] (array of language IDs, 1 = English)
      const qualityJson = JSON.stringify({
        quality: 3, // WEBDL-1080p as default
        revision: { version: 1, real: 0, isRepack: false }
      });
      const languagesJson = '[1]'; // English

      const result = db.prepare(`
        INSERT INTO EpisodeFiles (SeriesId, Quality, Size, DateAdded, SeasonNumber, SceneName, ReleaseGroup, MediaInfo, RelativePath, OriginalFilePath, Languages, IndexerFlags, ReleaseType)
        VALUES (?, ?, ?, datetime('now'), ?, ?, ?, NULL, ?, NULL, ?, 0, 0)
      `).run(
        episodeFile.seriesId,
        qualityJson,
        fileSize,
        episodeFile.seasonNumber || 1,
        episodeFile.sceneName || '',
        releaseGroup,
        relativePath,
        languagesJson
      );

      const episodeFileId = result.lastInsertRowid;
      log(this.name, `Inserted EpisodeFile with ID ${episodeFileId}`);

      // Link episodes to the new file
      for (const episodeId of episodeIds) {
        db.prepare('UPDATE Episodes SET EpisodeFileId = ? WHERE Id = ?').run(episodeFileId, episodeId);
        log(this.name, `Linked episode ${episodeId} to file ${episodeFileId}`);
      }

      return { id: episodeFileId };
    } catch (error) {
      log(this.name, `Error registering episode file via DB: ${error.message}`);
      return null;
    }
  }

  async registerEpisodeFileViaApi(episodeFile, episodeIds) {
    try {
      // Fallback to API method (will fail on read-only filesystem)
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
      log(this.name, `Error registering episode file via API: ${error.message}`);
      return null;
    }
  }

  async processHistory(nzbdavHistory) {
    const allSeries = await this.getAllSeries();

    for (const historyItem of nzbdavHistory) {
      const jobName = historyItem.job_name || historyItem.name || '';
      const category = (historyItem.category || historyItem.Category || '').toLowerCase();

      // Only process configured categories
      if (!this.config.categories.some(cat => category.includes(cat))) continue;

      // Try to parse episode information (individual episode or season pack)
      const episodeInfo = this.parseEpisodeInfo(jobName);
      const seasonInfo = !episodeInfo ? this.parseSeasonInfo(jobName) : null;

      if (!episodeInfo && !seasonInfo) {
        log(this.name, `Could not parse episode/season info from: ${jobName}`);
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

      const downloadPath = path.join(this.config.mountPath, jobName);

      // Handle season packs differently from individual episodes
      if (seasonInfo) {
        await this.processSeasonPack(series, seasonInfo.season, downloadPath, jobName);
        continue;
      }

      // Individual episode handling (existing logic)
      const episode = await this.getEpisode(series.id, episodeInfo.season, episodeInfo.episode);
      if (!episode) {
        log(this.name, `Episode S${episodeInfo.season}E${episodeInfo.episode} not found for ${series.title}`);
        continue;
      }

      // Check if episode already has a file
      if (episode.hasFile) {
        continue;
      }

      // Find the actual video file in the download directory
      let videoFile = null;
      let actualDownloadPath = downloadPath;

      try {
        if (fs.existsSync(downloadPath)) {
          const files = fs.readdirSync(downloadPath);
          videoFile = files.find(f => /\.(mkv|mp4|avi|mov)$/i.test(f));
        }

        // If no video in original path, check for numbered versions (2), (3), etc.
        if (!videoFile) {
          const numberedPath = this.findNumberedVersion(downloadPath, jobName);
          if (numberedPath) {
            actualDownloadPath = numberedPath;
            const files = fs.readdirSync(numberedPath);
            videoFile = files.find(f => /\.(mkv|mp4|avi|mov)$/i.test(f));
          }
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

      const fullPath = path.join(actualDownloadPath, videoFile);
      log(this.name, `Registering ${series.title} S${episodeInfo.season}E${episodeInfo.episode}: ${fullPath}`);

      if (!CONFIG.dryRun) {
        const episodeFile = {
          path: fullPath,
          seriesId: series.id,
          seasonNumber: episodeInfo.season,
          quality: { quality: { id: 1, name: 'Unknown' } },
          releaseGroup: '',
          sceneName: videoFile
        };

        const registered = await this.registerEpisodeFile(episodeFile, [episode.id]);
        if (registered) {
          log(this.name, `✅ Successfully registered: ${series.title} S${episodeInfo.season}E${episodeInfo.episode}`);
          // Clear any failed queue entries for this episode
          await this.clearFailedQueueEntries(item =>
            item.seriesId === series.id &&
            item.episodeId === episode.id
          );
        }
      } else {
        log(this.name, `[DRY RUN] Would register episode file: ${fullPath}`);
      }
    }
  }

  async cleanupStaleFiles() {
    const db = this.getDatabase();
    if (!db) {
      log(this.name, 'Database not available for stale file cleanup');
      return 0;
    }

    log(this.name, 'Checking for stale episode files...');
    let cleanedCount = 0;

    try {
      // Get all episode files in our mount path
      const episodeFiles = db.prepare(`
        SELECT ef.Id, ef.SeriesId, ef.RelativePath, s.Title as SeriesTitle
        FROM EpisodeFiles ef
        JOIN Series s ON s.Id = ef.SeriesId
      `).all();

      for (const ef of episodeFiles) {
        const fullPath = path.join(this.config.mountPath, ef.RelativePath);

        // Check if file exists on disk
        if (!fs.existsSync(fullPath)) {
          log(this.name, `Stale file detected: "${ef.SeriesTitle}" - ${ef.RelativePath}`);

          if (!CONFIG.dryRun) {
            // Unlink episodes from this file
            db.prepare('UPDATE Episodes SET EpisodeFileId = 0 WHERE EpisodeFileId = ?').run(ef.Id);
            // Delete the episode file record
            db.prepare('DELETE FROM EpisodeFiles WHERE Id = ?').run(ef.Id);
            log(this.name, `Deleted stale episode file record ID ${ef.Id}`);

            // Trigger series refresh to update UI
            await this.triggerCommand({ name: 'RefreshSeries', seriesId: ef.SeriesId });
            cleanedCount++;
          } else {
            log(this.name, `[DRY RUN] Would delete stale file and refresh series`);
            cleanedCount++;
          }
        }
      }

      if (cleanedCount > 0) {
        log(this.name, `🧹 Cleaned up ${cleanedCount} stale episode files`);
      }
    } catch (error) {
      log(this.name, `Error during stale file cleanup: ${error.message}`);
    }

    return cleanedCount;
  }
}

// Lidarr-specific handler
class LidarrMonitor extends ArrClient {
  constructor(name, config, apiVersion = 'v1') {
    super(name, config, apiVersion);
    // Track recently searched albums to avoid repeated searches
    this.recentlySearched = new Map(); // albumId -> timestamp
    this.searchCooldownMs = CONFIG.searchCooldownMs;
  }

  async triggerSearchForIncompleteDownload(album, originalRelease) {
    const lastSearch = this.recentlySearched.get(album.id);

    if (lastSearch && (Date.now() - lastSearch) < this.searchCooldownMs) {
      const hoursAgo = ((Date.now() - lastSearch) / (60 * 60 * 1000)).toFixed(1);
      log(this.name, `Skipping search for album "${album.title}" - already searched ${hoursAgo}h ago`);
      return;
    }

    log(this.name, `Triggering search for incomplete download: "${album.title}" (was: ${originalRelease})`);

    if (!CONFIG.dryRun) {
      const success = await this.triggerCommand({
        name: 'AlbumSearch',
        albumIds: [album.id]
      });

      if (success) {
        this.recentlySearched.set(album.id, Date.now());
        log(this.name, `✅ Search triggered for album: ${album.title}`);
      } else {
        log(this.name, `❌ Failed to trigger search for album: ${album.title}`);
      }
    } else {
      log(this.name, `[DRY RUN] Would trigger search for album: ${album.title}`);
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

  async getAllAlbums() {
    try {
      const response = await this.axios.get(`/api/${this.apiVersion}/album`);
      return response.data || [];
    } catch (error) {
      log(this.name, `Error fetching albums: ${error.message}`);
      return [];
    }
  }

  async getAlbumTracks(albumId) {
    try {
      const response = await this.axios.get(`/api/${this.apiVersion}/track`, {
        params: { albumId }
      });
      return response.data || [];
    } catch (error) {
      log(this.name, `Error fetching tracks for album ${albumId}: ${error.message}`);
      return [];
    }
  }

  getDatabase() {
    if (!this._db) {
      if (!fs.existsSync(this.config.dbPath)) {
        log(this.name, `Database not found at: ${this.config.dbPath}`);
        return null;
      }
      this._db = new Database(this.config.dbPath);
    }
    return this._db;
  }

  parseTrackNumber(filename) {
    // Try to extract track number from filename
    // Various patterns used in music releases

    // Pattern 1: 3-digit disc+track format (102 = disc 1 track 02, 201 = disc 2 track 01)
    const discTrackMatch = filename.match(/^(\d)(\d{2})[-_.\s]/);
    if (discTrackMatch) {
      return parseInt(discTrackMatch[2]); // Return just the track portion
    }

    // Pattern 2: Standard 1-2 digit track at start (01-..., 01_..., 01 ...)
    const standardMatch = filename.match(/^(\d{1,2})[-_.\s]/);
    if (standardMatch) {
      return parseInt(standardMatch[1]);
    }

    // Pattern 3: Track number in middle with _-_NN_-_ format (artist_-_08_-_title.mp3)
    const middleMatch = filename.match(/_-_(\d{1,2})_-_/);
    if (middleMatch) {
      return parseInt(middleMatch[1]);
    }

    // Pattern 4: Track keyword (track01, track 1)
    const trackMatch = filename.match(/track\s*(\d{1,2})/i);
    if (trackMatch) {
      return parseInt(trackMatch[1]);
    }

    // Pattern 5: Just digits at start followed by dot (01.title)
    const dotMatch = filename.match(/^(\d{1,2})\./);
    if (dotMatch) {
      return parseInt(dotMatch[1]);
    }

    return null;
  }

  async registerTrackFile(trackFilePath, albumId, track) {
    const db = this.getDatabase();
    if (!db) {
      log(this.name, 'Database not available');
      return null;
    }

    try {
      // Get file size
      let fileSize = 0;
      try {
        const stats = fs.statSync(trackFilePath);
        fileSize = stats.size;
      } catch (e) {
        log(this.name, `Could not get file size: ${e.message}`);
      }

      // Check if track file already exists for this path
      const existingFile = db.prepare(
        'SELECT Id FROM TrackFiles WHERE Path = ?'
      ).get(trackFilePath);

      if (existingFile) {
        log(this.name, `Track file already registered with ID ${existingFile.Id}`);
        // Ensure track is linked to this file
        db.prepare('UPDATE Tracks SET TrackFileId = ? WHERE Id = ?').run(existingFile.Id, track.id);
        return { id: existingFile.Id };
      }

      // Extract release group from filename
      const releaseGroupMatch = trackFilePath.match(/-([A-Za-z0-9]+)\.[^.]+$/);
      const releaseGroup = releaseGroupMatch ? releaseGroupMatch[1] : '';

      // Detect quality from file extension
      const ext = path.extname(trackFilePath).toLowerCase();
      let qualityId = 1; // Unknown
      let qualityName = 'Unknown';
      if (ext === '.flac') {
        // Check if 24bit based on filename
        if (trackFilePath.toLowerCase().includes('24bit') || trackFilePath.toLowerCase().includes('24-bit')) {
          qualityId = 21;
          qualityName = 'FLAC 24bit';
        } else {
          qualityId = 6;
          qualityName = 'FLAC';
        }
      } else if (ext === '.mp3') {
        qualityId = 4;
        qualityName = 'MP3-320';
      } else if (ext === '.m4a' || ext === '.aac') {
        qualityId = 5;
        qualityName = 'AAC-320';
      }

      // Quality format: quality is just the ID integer, not a nested object
      const qualityJson = JSON.stringify({
        quality: qualityId,
        revision: { version: 1, real: 0, isRepack: false }
      });

      const now = new Date().toISOString();

      // Insert new track file record
      const result = db.prepare(`
        INSERT INTO TrackFiles (AlbumId, Quality, Size, SceneName, DateAdded, ReleaseGroup, MediaInfo, Modified, Path, IndexerFlags)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 0)
      `).run(
        albumId,
        qualityJson,
        fileSize,
        path.basename(trackFilePath),
        now,
        releaseGroup,
        now,
        trackFilePath
      );

      const trackFileId = result.lastInsertRowid;
      log(this.name, `Inserted TrackFile with ID ${trackFileId}`);

      // Link track to the new file
      db.prepare('UPDATE Tracks SET TrackFileId = ? WHERE Id = ?').run(trackFileId, track.id);
      log(this.name, `Linked track ${track.id} to file ${trackFileId}`);

      return { id: trackFileId };
    } catch (error) {
      log(this.name, `Error registering track file via DB: ${error.message}`);
      return null;
    }
  }

  hasAudioFiles(dirPath) {
    try {
      const files = fs.readdirSync(dirPath);
      return files.some(f => /\.(flac|mp3|m4a|aac|ogg|wav)$/i.test(f));
    } catch {
      return false;
    }
  }

  getAudioFiles(dirPath) {
    try {
      const files = fs.readdirSync(dirPath);
      return files.filter(f => /\.(flac|mp3|m4a|aac|ogg|wav)$/i.test(f));
    } catch {
      return [];
    }
  }

  findBestAlbumMatch(jobName, allAlbums, allArtists) {
    // Step 1: Find matching artist first
    const { match: artist, score: artistScore } = findBestMatch(
      jobName,
      null,
      allArtists,
      a => a.artistName,
      null
    );

    if (!artist || artistScore < 0.5) {
      return { match: null, score: 0 };
    }

    // Step 2: Filter albums to this artist only
    const artistAlbums = allAlbums.filter(a => a.artist?.artistName === artist.artistName);

    if (artistAlbums.length === 0) {
      return { match: null, score: 0 };
    }

    // Step 3: Match against album titles
    const jobWords = extractTitleWords(jobName);
    // Also create a normalized version for short title matching
    const jobNameNormalized = jobName.toLowerCase().replace(/[^a-z0-9]/g, '');

    let bestMatch = null;
    let bestScore = 0;

    for (const album of artistAlbums) {
      const albumWords = extractTitleWords(album.title);
      let score = 0;

      // For short album titles (1-2 words after extraction, or titles like "L.W.", "K.G.")
      // Use normalized substring matching instead
      const albumTitleNormalized = album.title.toLowerCase().replace(/[^a-z0-9]/g, '');

      if (albumWords.length <= 1 || album.title.length <= 4) {
        // Short title: check if normalized album title appears in normalized job name
        if (albumTitleNormalized.length >= 2 && jobNameNormalized.includes(albumTitleNormalized)) {
          score = 1.0; // Perfect match for short titles
        }
      } else {
        // Normal word-based matching for longer titles
        let matchingWords = 0;
        for (const word of albumWords) {
          if (jobWords.includes(word)) {
            matchingWords++;
          }
        }
        score = albumWords.length > 0 ? matchingWords / albumWords.length : 0;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = album;
      }
    }

    // Require at least 50% of album title words to match
    if (bestScore >= 0.5) {
      return { match: bestMatch, score: bestScore };
    }

    return { match: null, score: 0 };
  }

  async processHistory(nzbdavHistory) {
    const allArtists = await this.getAllArtists();
    const allAlbums = await this.getAllAlbums();

    for (const historyItem of nzbdavHistory) {
      const jobName = historyItem.job_name || historyItem.name || '';
      const category = (historyItem.category || historyItem.Category || '').toLowerCase();

      // Only process configured categories
      if (!this.config.categories.some(cat => category.includes(cat))) continue;

      // Match artist first, then album within that artist
      const { match: album, score: albumScore } = this.findBestAlbumMatch(jobName, allAlbums, allArtists);

      if (!album) {
        // Fall back to artist-only matching for logging
        const { match: artist, score: artistScore } = findBestMatch(
          jobName,
          null,
          allArtists,
          a => a.artistName,
          null
        );

        if (!artist) {
          log(this.name, `No matching artist/album found for: ${jobName}`);
          continue;
        }

        log(this.name, `Matched "${jobName}" to artist "${artist.artistName}" (score: ${artistScore.toFixed(2)}) - no specific album match`);
        continue;
      }

      log(this.name, `Matched "${jobName}" to album "${album.title}" by "${album.artist?.artistName}" (score: ${albumScore.toFixed(2)})`);

      // Check if album already has all tracks with files
      const tracks = await this.getAlbumTracks(album.id);
      const tracksWithoutFiles = tracks.filter(t => !t.hasFile);

      if (tracksWithoutFiles.length === 0) {
        continue; // All tracks already have files
      }

      // Find the download directory
      const downloadPath = path.join(this.config.mountPath, jobName);
      let actualDownloadPath = downloadPath;

      // Check for actual files
      if (!fs.existsSync(downloadPath) || !this.hasAudioFiles(downloadPath)) {
        // Try numbered versions
        const numberedPath = this.findNumberedVersion(downloadPath, jobName);
        if (numberedPath) {
          actualDownloadPath = numberedPath;
        } else {
          log(this.name, `No audio files found for album "${album.title}" - download appears incomplete`);
          await this.triggerSearchForIncompleteDownload(album, jobName);
          continue;
        }
      }

      const audioFiles = this.getAudioFiles(actualDownloadPath);
      if (audioFiles.length === 0) {
        log(this.name, `No audio files found in ${actualDownloadPath}`);
        await this.triggerSearchForIncompleteDownload(album, jobName);
        continue;
      }

      log(this.name, `Found ${audioFiles.length} audio files for album "${album.title}" (${tracksWithoutFiles.length} tracks need files)`);

      // Match audio files to tracks
      let registeredCount = 0;

      for (const audioFile of audioFiles) {
        const trackNumber = this.parseTrackNumber(audioFile);
        if (!trackNumber) {
          log(this.name, `Could not parse track number from: ${audioFile}`);
          continue;
        }

        // Find matching track
        const track = tracksWithoutFiles.find(t => {
          const absoluteNum = t.absoluteTrackNumber;
          const trackNum = parseInt(t.trackNumber) || t.absoluteTrackNumber;
          return absoluteNum === trackNumber || trackNum === trackNumber;
        });

        if (!track) {
          continue; // Track already has file or doesn't exist in Lidarr
        }

        const fullPath = path.join(actualDownloadPath, audioFile);
        log(this.name, `Registering track ${trackNumber}: ${audioFile}`);

        if (!CONFIG.dryRun) {
          const registered = await this.registerTrackFile(fullPath, album.id, track);
          if (registered) {
            registeredCount++;
          }
        } else {
          log(this.name, `[DRY RUN] Would register: ${fullPath}`);
          registeredCount++;
        }
      }

      if (registeredCount > 0) {
        log(this.name, `✅ Registered ${registeredCount} tracks for album "${album.title}"`);
        // Clear any failed queue entries for this album
        await this.clearFailedQueueEntries(item => item.albumId === album.id);
        // Trigger artist refresh to update Lidarr UI immediately
        await this.refreshArtist(album.artist?.artistMetadataId || album.artistId);
      }
    }
  }

  async refreshArtist(artistId) {
    if (!artistId) return;
    try {
      await this.axios.post(`/api/${this.apiVersion}/command`, {
        name: 'RefreshArtist',
        artistId: artistId
      });
      log(this.name, `Triggered refresh for artist ${artistId}`);
    } catch (error) {
      log(this.name, `Failed to trigger artist refresh: ${error.message}`);
    }
  }

  async cleanupStaleFiles() {
    const db = this.getDatabase();
    if (!db) {
      log(this.name, 'Database not available for stale file cleanup');
      return 0;
    }

    log(this.name, 'Checking for stale track files...');
    let cleanedCount = 0;
    const artistsToRefresh = new Set();

    try {
      // Get all track files with their album and artist info
      const trackFiles = db.prepare(`
        SELECT tf.Id, tf.AlbumId, tf.Path, a.Title as AlbumTitle, ar.Name as ArtistName, ar.ArtistMetadataId
        FROM TrackFiles tf
        JOIN Albums a ON a.Id = tf.AlbumId
        JOIN Artists ar ON ar.ArtistMetadataId = a.ArtistMetadataId
        WHERE tf.Path LIKE ?
      `).all(this.config.mountPath + '%');

      for (const tf of trackFiles) {
        // Check if file exists on disk
        if (!fs.existsSync(tf.Path)) {
          log(this.name, `Stale file detected: "${tf.ArtistName}" - "${tf.AlbumTitle}" - ${path.basename(tf.Path)}`);

          if (!CONFIG.dryRun) {
            // Unlink tracks from this file
            db.prepare('UPDATE Tracks SET TrackFileId = 0 WHERE TrackFileId = ?').run(tf.Id);
            // Delete the track file record
            db.prepare('DELETE FROM TrackFiles WHERE Id = ?').run(tf.Id);
            log(this.name, `Deleted stale track file record ID ${tf.Id}`);

            artistsToRefresh.add(tf.ArtistMetadataId);
            cleanedCount++;
          } else {
            log(this.name, `[DRY RUN] Would delete stale file and refresh artist`);
            cleanedCount++;
          }
        }
      }

      // Refresh affected artists and trigger searches for albums that now have missing tracks
      for (const artistMetadataId of artistsToRefresh) {
        await this.refreshArtist(artistMetadataId);
      }

      if (cleanedCount > 0) {
        log(this.name, `🧹 Cleaned up ${cleanedCount} stale track files`);
      }
    } catch (error) {
      log(this.name, `Error during stale file cleanup: ${error.message}`);
    }

    return cleanedCount;
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
  log('Main', `Search cooldown: ${CONFIG.searchCooldownMs / 60000} minutes`);
  log('Main', `Dry run: ${CONFIG.dryRun}`);

  let lastStaleCleanup = 0;
  const staleCleanupIntervalMs = 60 * 60 * 1000; // Run stale file cleanup every hour

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

    // Run stale file cleanup periodically (every hour)
    const now = Date.now();
    if (now - lastStaleCleanup >= staleCleanupIntervalMs) {
      log('Main', 'Running stale file cleanup...');
      for (const monitor of monitors) {
        try {
          if (monitor.cleanupStaleFiles) {
            await monitor.cleanupStaleFiles();
          }
        } catch (error) {
          log(monitor.name, `Error in stale file cleanup: ${error.message}`);
        }
      }
      lastStaleCleanup = now;
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
