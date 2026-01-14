# arr-path-fixer Architecture & Configuration

## Overview

This document describes the integration between NzbDAV, *arr apps (Radarr/Sonarr/Lidarr), arr-path-fixer, and Plex for streaming Usenet content.

## Components

### NzbDAV
- **Purpose**: Streams Usenet content via WebDAV without storing files locally
- **Port**: 3000
- **Mount Point**: `/mnt/nzbdav/content/` (WebDAV mount on host)
- **Categories**: `movies`, `tv`, `music`
- **Key Setting**: `webdav.enforce-readonly: true` - content is read-only

**Important**: NzbDAV creates numbered directory versions (`Release (2)`, `Release (3)`, etc.) when the same release is downloaded multiple times. This happens when:
- Original download failed/incomplete
- Health check deleted corrupted file
- Manual re-download triggered

### Radarr (Movies)
- **Port**: 7878
- **Root Folder**: `/mnt/nzbdav/content/movies`
- **Integration**: arr-path-fixer updates movie paths via API after download

### Sonarr (TV)
- **Port**: 8989
- **Root Folder**: `/mnt/nzbdav/content/tv`
- **Database**: `/config/sonarr/sonarr.db` (mounted into arr-path-fixer)
- **Integration**: arr-path-fixer registers episodes directly in SQLite database
  - Series path set to `/mnt/nzbdav/content/tv`
  - EpisodeFiles use relative paths from series root
  - Bypasses ManualImport API which requires write access

### Plex
- **Mount**: Reads directly from `/mnt/nzbdav/content/`
- **No special configuration needed** - just point libraries to the mount

### arr-path-fixer
- **Purpose**: Bridges NzbDAV downloads with *arr apps
- **Container**: Runs with `--network=host` and `--userns=keep-id`
- **Polling**: Scans entire NzbDAV history each poll (continuous health check)
- **Default interval**: 15 minutes (configurable)

## Configuration (.env)

```bash
# NzbDAV Configuration
NZBDAV_URL=http://localhost:3000
NZBDAV_API_KEY=<your-key>

# Polling Configuration
POLL_INTERVAL_SECONDS=900        # How often to scan all history (15 min)
SEARCH_COOLDOWN_MINUTES=30       # Wait before re-searching same item

# Radarr (Movies)
RADARR_ENABLED=true
RADARR_URL=http://localhost:7878
RADARR_API_KEY=<your-key>
RADARR_MOUNT_PATH=/mnt/nzbdav/content/movies

# Sonarr (TV)
SONARR_ENABLED=true
SONARR_URL=http://localhost:8989
SONARR_API_KEY=<your-key>
SONARR_MOUNT_PATH=/mnt/nzbdav/content/tv
SONARR_DB_PATH=/config/sonarr/sonarr.db

# Lidarr (Music) - Optional
LIDARR_ENABLED=false
LIDARR_URL=http://localhost:8686
LIDARR_API_KEY=<your-key>
LIDARR_MOUNT_PATH=/mnt/nzbdav/content/music
```

## Container Deployment

```bash
podman run -d \
  --name arr-path-fixer \
  --network=host \
  --userns=keep-id \
  --env-file /home/dgherman/arr-path-fixer/.env \
  -v /mnt/nzbdav/content:/mnt/nzbdav/content:ro \
  -v /home/dgherman/nzbdav/config/sonarr:/config/sonarr \
  arr-path-fixer
```

Key flags:
- `--network=host`: Access localhost services (Radarr, Sonarr, NzbDAV)
- `--userns=keep-id`: Preserve UID/GID for Sonarr database write access
- Sonarr config mounted read-write for database access

## Workflow

### Normal Download Flow
```
1. *arr app searches indexers → sends NZB to NzbDAV
2. NzbDAV downloads from Usenet → creates directory in /content/{category}/
3. arr-path-fixer polls NzbDAV history (every POLL_INTERVAL_SECONDS)
4. Matches download to *arr library using title/year matching
5. For Radarr: Updates movie path via API → triggers refresh
6. For Sonarr: Inserts EpisodeFile record directly in database
7. *arr app now shows file as available
8. Plex can play via WebDAV mount
```

### Incomplete Download Flow
```
1. arr-path-fixer detects download directory has no video files
2. Triggers search via *arr API for that movie/episode
3. Respects SEARCH_COOLDOWN_MINUTES to avoid hammering indexers
4. New download arrives (possibly as numbered version)
5. arr-path-fixer finds numbered version → registers it
```

### Numbered Version Handling
When original directory is empty but numbered versions exist:
```
/mnt/nzbdav/content/tv/Release.Name/           <- empty (failed)
/mnt/nzbdav/content/tv/Release.Name (2)/       <- has video
/mnt/nzbdav/content/tv/Release.Name (3)/       <- has video
```

arr-path-fixer checks for `(2)`, `(3)`, etc. and uses the highest numbered version with media files.

## Key Features

### Title Matching
- Word-based fuzzy matching (not exact string match)
- Year matching for movies
- Handles various release naming conventions
- Minimum 60% word overlap required (70% for directory matching)

### Season Pack Support
- Detects season-only patterns: `S01`, `Season.1`, etc.
- Scans directory for individual episode files
- Registers each episode file separately

### Search Cooldown
- Tracks recently searched items in memory
- Prevents re-searching same item within cooldown period
- Configurable via `SEARCH_COOLDOWN_MINUTES`

### Full History Scanning
- Each poll scans **all** completed downloads in NzbDAV history
- Acts as continuous health check for entire library
- Detects files that disappear at any time (corruption, deletion, etc.)
- Most items skip quickly (already registered or wrong category)
- 15-minute interval is sufficient since full scan catches everything

### Sonarr Database Integration
- Direct SQLite insertion bypasses read-only filesystem limitation
- Quality stored as: `{"quality": 3, "revision": {"version": 1, "real": 0, "isRepack": false}}`
- Languages stored as: `[1]` (array of language IDs, 1 = English)
- Automatically updates Series.Path to match mount path

## NzbDAV Background Repairs

**Status**: Disabled (recommended)

NzbDAV's Background Repairs feature was disabled because:
- Without symlinks/strm files, it can only **delete** corrupted files, not repair them
- arr-path-fixer handles missing file detection and re-search
- Avoids duplicate download attempts

If you want to enable it:
- Set `repair.enable: true` in NzbDAV
- Set `media.library-dir: /content`
- Note: Corrupted files will be deleted, requiring manual re-search

## Troubleshooting

### Episode not showing in Sonarr
1. Check arr-path-fixer logs: `podman logs arr-path-fixer`
2. Look for "No matching series found" - series might not be in library
3. Look for "Could not parse episode info" - unusual naming convention
4. Check if numbered version exists but wasn't found

### Infinite re-download loop
- Fixed by numbered version detection
- If still happening, check if ALL numbered versions are empty/corrupted

### Database write errors
- Ensure `--userns=keep-id` flag is set
- Check Sonarr config directory permissions
- Verify database path in .env matches actual location

### Search not triggering
- Check cooldown: search may have been triggered recently
- Look for "Skipping search for X - already searched Yh ago"
- Reduce `SEARCH_COOLDOWN_MINUTES` if needed

## File Locations

| File | Purpose |
|------|---------|
| `/home/dgherman/projects/arr-path-fixer/index.js` | Main application |
| `/home/dgherman/arr-path-fixer/.env` | Runtime configuration |
| `/home/dgherman/nzbdav/config/db.sqlite` | NzbDAV database |
| `/home/dgherman/nzbdav/config/sonarr/sonarr.db` | Sonarr database |
| `/mnt/nzbdav/content/` | WebDAV mount point |
