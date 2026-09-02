# Biometric Attendance

A small, production-ready attendance server for ADMS/iClock-compatible biometric terminals. The first scan opens a user's shift (**Checked in / Working**); the next distinct scan closes it (**Checked out**). The dashboard updates immediately without a page refresh.

## Features

- Native FKWebServer support (`realtime_glog` and `realtime_enroll_data`) for the connected terminal
- ADMS push endpoints on `/iclock/cdata`, `/iclock/getrequest`, and `/iclock/devicecmd`
- Any number of registered users, mapped by the PIN/user ID enrolled on the terminal
- Live check-in/check-out board using server-sent events
- Attendance history, device presence, and unknown-ID reporting
- Biometric scan logs showing one row per accepted check-in, check-out, or registration
- Duplicate upload protection so a terminal retry cannot accidentally toggle attendance
- Persistent SQLite database and password-protected dashboard
- Docker deployment with automatic restart

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
set ADMIN_PASSWORD=choose-a-strong-password
npm start
```

Open `http://localhost:8080` and sign in with username `admin` and the password you set.

## Deploy with Docker

```bash
cp .env.example .env
# Edit .env and set a strong ADMIN_PASSWORD.
docker compose up -d --build
docker compose logs -f attendance
```

The SQLite database is stored in the named `attendance-data` Docker volume, so rebuilding the container does not erase users or attendance.

On a server that already uses PM2, the included `ecosystem.config.cjs` loads the same `.env` file and can be started with `pm2 startOrReload ecosystem.config.cjs`.

## Configure the biometric terminal

For the supplied server, configure the device's ADMS/Cloud Server page with:

- Server address: `62.84.184.96`
- Server port: `8080`
- HTTPS/SSL: off (unless a reverse proxy has separately been configured for the device)
- Realtime upload: on

Then restart the terminal or test its server connection. Once it contacts the app it appears in the **Devices** panel.

In the dashboard, register each person using the exact numeric PIN/user ID already enrolled on the physical terminal. The connected FKWebServer-style terminal can also auto-create a user when it uploads enrollment data; an administrator can then edit the generated name. Fingerprints and face templates remain on the terminal; this app only receives the resulting attendance punches.

If the terminal clock has reset to an obviously old year (the connected device currently reports 2015), the server safely uses its own local receipt time. The original device timestamp still participates in duplicate detection, preventing repeated uploads from flipping a user in and out.

## Device protocol check

From another machine, this URL should return lines beginning with `GET OPTION FROM`:

```text
http://62.84.184.96:8080/iclock/cdata?SN=TEST
```

If it does not, check that TCP port 8080 is allowed by both the server firewall and hosting-provider firewall.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port used by the device and dashboard |
| `DATABASE_PATH` | `./data/attendance.db` | SQLite file location |
| `ADMIN_USERNAME` | `admin` | Dashboard HTTP Basic username |
| `ADMIN_PASSWORD` | `admin` in local development | Dashboard password; required by Docker Compose |
| `DEVICE_TIMEZONE` | `Asia/Kolkata` | Time zone used for today's totals |
| `DEVICE_SCAN_DEBOUNCE_SECONDS` | `30` | Quiet period separating repeated enrollment-style scans |

## Backups

Back up the SQLite database from the running container:

```bash
docker compose exec attendance sqlite3 /app/data/attendance.db ".backup /app/data/attendance-backup.db"
docker compose cp attendance:/app/data/attendance-backup.db ./attendance-backup.db
```

If the terminal is not ADMS/iClock compatible, its manufacturer and exact model are needed to add the correct protocol adapter.

## Migrating the previous installation

The one-time importer preserves users and any successfully saved attendance from the earlier SQLite database:

```bash
npm run migrate:legacy -- ./database.db ./data/attendance.db
```
