# DEV environment

## general setup
- laptop/desktop
- OS (Windows)
- browser (Brave)
- VSC
- git
- WSL2
- Docker

## setup project
- folder with code in the OS
- open folder with VSC ("VSC project")
- Ctrl-Sh-P add dev container... (ubuntu)
- create git repo + publish to github

## install stuff
- install node+npm packages
- install claude code


### install node+npm
```
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

npm config set ignore-scripts true
npm config set save-exact true
npm config set min-release-age=7

npm config set prefix ~/.npm-global
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
# close terminal and open a new terminal

npm install -g @socketsecurity/cli


socket wrapper on
npm install PACKAGE_NAME     ## routed via socket now


# if needed:
npm install PACKAGE_NAME --ignore-scripts=false
```

### install claude code
```
curl -fsSL https://claude.ai/install.sh | bash
```

## run the app
```
npm install

# Native modules (better-sqlite3, argon2) compile a binary in their install
# script. Two gates block that script; the rebuild below clears both:
#   1. our global ignore-scripts=true  -> --ignore-scripts=false lifts it
#   2. npm 12's install-script allowlist -> already granted by "allowScripts"
#      in package.json (committed), so no `npm install-scripts approve` needed
npm rebuild better-sqlite3 argon2 --foreground-scripts --ignore-scripts=false

npm start
```

## test in browser
open http://localhost:3000


--------------------------------------------------------

# PROD environment - ubuntu server (AWS EC2)

This is the only deployment. Railway was used earlier and is retired; its notes
are kept in the appendix at the end, for reference only.

## setup server

- AWS EC2 instance t4g.small (2 vCPU, 2 GB RAM, 8 GB Disk)
- Ubuntu 26.04 (LTS) ARM64

```
ssh ubuntu@IP_ADDRESS
adduser --disabled-password --gecos "" lorchess
sudo -u lorchess -i
```


## project code
```
git clone https://github.com/lorand77/lorchess.git
```

## install node+npm
```
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g npm@latest
```

## configure environment

Create `.env` in the project dir. It is gitignored, and the `npm` scripts load
it at startup via `node --env-file-if-exists=.env` (nothing else reads it).

```
cd ~/lorchess

# generate a fresh secret:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

cat > .env <<EOF
SESSION_SECRET=<generated hex>
NODE_ENV=production
EOF

chmod 600 .env
```

- `SESSION_SECRET` — signs the session cookie. If unset, `src/config.js` falls
  back to a hardcoded dev default that is public in this repo; anyone who then
  obtains a session id (from logs or a DB backup) can turn it into a valid
  cookie. Use a different value per environment and never commit it. Changing it
  invalidates all existing sessions, i.e. logs everyone out.
- `NODE_ENV=production` — makes Express's default error handler send a bare
  "Internal Server Error" instead of a stack trace in the HTTP response body.
  Also makes `npm install` skip devDependencies.

Everything else has a default and is read in `src/config.js`; put it in `.env`
only to change it:

- `PORT` — the HTTP port (default 3000).
- `DB_PATH` — the SQLite file (default `data/lorchess.sqlite` in the project).
- `GRACE_MS` — how long a disconnected PvP player has to come back before they
  forfeit, and how long a player has to turn up to a game that just started
  before it is aborted (default 45000, i.e. 45 s).
- `RESUME_WINDOW_MS` — after a restart, how long games left in progress wait
  for their players before being aborted (default 600000, i.e. 10 min).
- `CHAT_RETENTION_DAYS` — how long in-game chat is kept after a game ends;
  `-1` keeps it for ever (default 30).
- `ELO_K` — the K-factor for rating changes after rated games (default 32).
- `CLOCK_MS`, `CLOCK_INC_MS` — the clock assumed for PvP games stored before
  time controls existed (default 600000 and 0). New games take theirs from the
  lobby's time-control list.

## run the app
```
npm install
npm start
```

or better use pm2:
```
sudo npm install -g pm2

pm2 start npm --name "lorchess" -- start

# survive reboot:
pm2 save
pm2 startup


pm2 list                        # see all running processes and their status
pm2 logs lorchess            # tail live logs
pm2 logs lorchess --lines 100  # show last 100 lines
pm2 restart lorchess         # restart the app (e.g. after deploying new code)
pm2 stop lorchess            # stop without removing from pm2's list
pm2 delete lorchess          # remove from pm2 entirely
pm2 monit                       # live dashboard: CPU, memory, logs
```

## https with custom domain (Caddy)

- the domain `lorand77.dev` is registered at name.com
- name.com: manage DNS -> add A record: host `lorchess` -> IP_ADDRESS
- EC2 firewall: allow ports 80 and 443 (80 = cert challenge, 443 = https)

install Caddy:
```
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

/etc/caddy/Caddyfile:
```
lorchess.lorand77.dev {
    reverse_proxy localhost:3000
}
```

```
sudo systemctl reload caddy
```

## deploying new code
```
git pull
npm install        # in case dependencies changed
pm2 restart lorchess
```

## changing a user's password

There is no self-service reset flow. Run this in the project dir on the server
(same user the app runs as, so it picks up `.env` / `DB_PATH`). It is safe to run
while the app is up.

```
npm run user:password -- <username>
```

It prompts twice for the new password with echo off. The password is never
passed as an argument, so it does not land in shell history. Non-interactive
use (e.g. from a deploy script) reads the first line of stdin instead:

```
echo "<new password>" | npm run user:password -- <username>
```

Minimum length is 6, matching registration. The reserved `LorFish` account is
refused. The user's existing sessions stay logged in; if they must be kicked
out, restart the app with a new `SESSION_SECRET` (logs everyone out).

## backing up sqlite database

```
apt install sqlite3
mkdir -p backups

sqlite3 data/lorchess.sqlite "VACUUM INTO 'backups/lorchess-backup-$(date +\%F).sqlite'"
```

and move the backup file somewhere safe (e.g. download to local machine, upload to cloud storage etc.)

```
pm2 stop lorchess
cp backups/lorchess-backup-DATE.sqlite data/lorchess.sqlite
rm -f data/lorchess.sqlite-wal data/lorchess.sqlite-shm
pm2 start lorchess
```

### backup to B2

```
apt install rclone
rclone config
rclone copy test1.txt b2:lorchess-backups/
# restore:
rclone copy b2:lorchess-backups/test1.txt .
```

and create a cron job to run the backup script daily 
`scripts/backup.sh`and `crontab -e` to add a line like:
```
0 3 * * * /home/lorchess/lorchess/scripts/backup.sh
```


--------------------------------------------------------

# Appendix - retired: platform-as-a-service on railway

LorChess ran on Railway before the EC2 server and is not going back. Nothing in
this section is in use; it is kept as a record of how the PaaS deployment
worked. The DNS records for `lorchess.lorand77.dev` now point at the EC2 server
(see "https with custom domain" above), so do not re-apply the custom-domain
steps below: they would take the live site down.

What a PaaS needs from this app, should one ever be considered again:

- a persistent volume, with `DB_PATH` pointing into it. The default
  `data/lorchess.sqlite` lives inside the checkout, which a PaaS rebuilds on
  every deploy, so without the volume every deploy starts with an empty database.
- `SESSION_SECRET` and `NODE_ENV=production` set as platform environment
  variables. There is no `.env` file on a PaaS; the npm scripts use
  `--env-file-if-exists`, so they start fine without one.
- TLS terminated at the platform's edge. `src/app.js` trusts one proxy hop
  (`trust proxy`), which is what lets the session cookie be `secure` behind it.

## setup

- create railway account
- create new project, link to github repo
- networking: generate domain, e.g. https://lorchess-production.up.railway.app
- open app in browser

## make sqlite data persistent

- attach volume `/data`
- Set environment variables (Service → Variables)
```
DB_PATH=/data/lorchess.sqlite
SESSION_SECRET=<generated hex, see "configure environment" above>
NODE_ENV=production
```

## custom domain

- buy lorand77.dev on name.com
- in railway: networking / custom domain -> gives CNAME and TXT to set
- in name.com: manage DNS records: add CNAME and TXT
- https will work out of the box (railway issues cert)   https://lorchess.lorand77.dev/
