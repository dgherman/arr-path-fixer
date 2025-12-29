# arr-path-fixer

Automatically fixes paths for Radarr/Sonarr/Lidarr in streaming setups where files can't be moved/organized.

## Problem It Solves

When using NzbDAV for streaming:
- NzbDAV creates files at: `/mnt/nzbdav/content/movies/Release.Name.2024/file.mkv`
- Radarr expects them at: `/mnt/nzbdav/content/movies/Movie Title (2024)/file.mkv`
- Import process tries to move files → fails on virtual filesystem
- Results in bandwidth waste and failed imports

## Solution

This service:
1. Monitors *arr service queues for completed downloads
2. Finds where NzbDAV actually created the file
3. Updates the movie/series/album path to match reality
4. Triggers refresh → file is detected
5. Clears the queue

**No file moves = No bandwidth waste = No failed imports**

## Deployment

### Option 1: Podman/Docker with systemd

1. Build the image:
```bash
cd /Users/dgherman/Documents/projects/arr-path-fixer
podman build -t arr-path-fixer:latest .
```

2. Create environment file:
```bash
cp .env.example ~/arr-path-fixer/.env
nano ~/arr-path-fixer/.env  # Edit with your API keys
```

3. Create systemd service:
```bash
cat > ~/.config/systemd/user/arr-path-fixer.service <<'EOF'
[Unit]
Description=Arr Path Fixer
After=network-online.target

[Service]
Type=simple
Restart=always
RestartSec=10

ExecStart=/usr/bin/podman run \\
  --rm \\
  --name arr-path-fixer \\
  --network=host \\
  --env-file %h/arr-path-fixer/.env \\
  -v /mnt/nzbdav:/mnt/nzbdav:ro \\
  localhost/arr-path-fixer:latest

ExecStop=/usr/bin/podman stop -t 10 arr-path-fixer

[Install]
WantedBy=default.target
EOF
```

4. Start the service:
```bash
systemctl --user daemon-reload
systemctl --user enable arr-path-fixer.service
systemctl --user start arr-path-fixer.service
systemctl --user status arr-path-fixer.service
```

### Option 2: Docker Compose

```yaml
version: '3.8'

services:
  arr-path-fixer:
    image: arr-path-fixer:latest
    container_name: arr-path-fixer
    restart: unless-stopped
    network_mode: host
    environment:
      RADARR_ENABLED: "true"
      RADARR_URL: "http://localhost:7878"
      RADARR_API_KEY: "your-api-key"
      RADARR_MOUNT_PATH: "/mnt/nzbdav/content/movies"

      SONARR_ENABLED: "true"
      SONARR_URL: "http://localhost:8989"
      SONARR_API_KEY: "your-api-key"
      SONARR_MOUNT_PATH: "/mnt/nzbdav/content/tv"

      LIDARR_ENABLED: "true"
      LIDARR_URL: "http://localhost:8686"
      LIDARR_API_KEY: "your-api-key"
      LIDARR_MOUNT_PATH: "/mnt/nzbdav/content/music"

      POLL_INTERVAL_SECONDS: "60"
      DRY_RUN: "false"
    volumes:
      - /mnt/nzbdav:/mnt/nzbdav:ro
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `RADARR_ENABLED` | Enable Radarr monitoring | `false` |
| `RADARR_URL` | Radarr URL | - |
| `RADARR_API_KEY` | Radarr API key | - |
| `RADARR_MOUNT_PATH` | Path to movies | `/mnt/nzbdav/content/movies` |
| `SONARR_ENABLED` | Enable Sonarr monitoring | `false` |
| `SONARR_URL` | Sonarr URL | - |
| `SONARR_API_KEY` | Sonarr API key | - |
| `SONARR_MOUNT_PATH` | Path to TV shows | `/mnt/nzbdav/content/tv` |
| `LIDARR_ENABLED` | Enable Lidarr monitoring | `false` |
| `LIDARR_URL` | Lidarr URL | - |
| `LIDARR_API_KEY` | Lidarr API key | - |
| `LIDARR_MOUNT_PATH` | Path to music | `/mnt/nzbdav/content/music` |
| `POLL_INTERVAL_SECONDS` | How often to check queues | `60` |
| `DRY_RUN` | Test mode (no changes made) | `false` |

## Testing

1. Enable dry run mode:
```bash
echo "DRY_RUN=true" >> ~/arr-path-fixer/.env
systemctl --user restart arr-path-fixer
```

2. Watch logs:
```bash
journalctl --user -u arr-path-fixer -f
```

3. Request a movie in Overseerr and watch the logs to see what would happen

4. Disable dry run when satisfied:
```bash
sed -i 's/DRY_RUN=true/DRY_RUN=false/' ~/arr-path-fixer/.env
systemctl --user restart arr-path-fixer
```

## Logs

View real-time logs:
```bash
# Systemd
journalctl --user -u arr-path-fixer -f

# Podman
podman logs -f arr-path-fixer
```

## Troubleshooting

### Service won't start
- Check environment file exists: `cat ~/arr-path-fixer/.env`
- Verify API keys are correct
- Check mount path is accessible: `ls /mnt/nzbdav/content/`

### Not detecting files
- Verify Completed Download Handling is **DISABLED** in *arr apps
- Check queue has items with `importBlocked` (Radarr) or `importPending` (Sonarr/Lidarr) status
- Ensure poll interval isn't too long

### Wrong paths being set
- Check mount paths match your setup
- Verify NzbDAV creates files where expected
- Enable dry run and check logs

## Architecture

```
┌─────────────────────────────────────────┐
│ arr-path-fixer Container                │
│                                          │
│  Monitors:                               │
│  - Radarr queue (every 60s)             │
│  - Sonarr queue (every 60s)             │
│  - Lidarr queue (every 60s)             │
│                                          │
│  For completed items:                    │
│  1. Find actual file location           │
│  2. Update *arr item path                │
│  3. Trigger refresh                      │
│  4. Clear queue                          │
└─────────────────────────────────────────┘
         │              │              │
         ▼              ▼              ▼
    ┌────────┐    ┌────────┐    ┌────────┐
    │ Radarr │    │ Sonarr │    │ Lidarr │
    └────────┘    └────────┘    └────────┘
```

## License

MIT
