# Setup

Installing everything once: a dev machine, then the production server.
Everything done again and again (deploying, updates, users, backups, restore)
is in `operations.md`.

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

## install node+npm
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
```

Socket checks packages for malware before npm installs them. Only the commands
that bring packages in go through it; everything else is plain npm, because
Socket's npm breaks `npm audit` (always "found 0 vulnerabilities"),
`npm audit fix` (fixes nothing), `npm rebuild` (runs no scripts) and `npm test`
(`ERR_ACCESS_DENIED`). Add to `~/.bashrc`, then open a new terminal:
```bash
# Socket scans packages when npm brings new versions into the tree; everything
# else is plain npm, because Socket's npm breaks audit, rebuild and scripts.
npm() {
  case "$1" in
    install|i|in|ins|add|update|up|upgrade|ci|clean-install|ic) socket npm "$@" ;;
    *) command npm "$@" ;;
  esac
}
alias npx="socket npx"
```

- Don't use `socket wrapper on`: it aliases all of `npm` to `socket npm`, and
  an alias beats the function. `type npm` must say "npm is a function".
- `command npm ...` skips Socket for one command; `\npm` does not (it only
  skips aliases).
- A package that really needs its install script:
  `npm install PACKAGE_NAME --ignore-scripts=false`.

## install claude code
```
curl -fsSL https://claude.ai/install.sh | bash
```

or install the VSC extension

## run the app
```
npm ci
npm rebuild better-sqlite3 argon2 --foreground-scripts --ignore-scripts=false   # after every npm ci
npm start
```

then open http://localhost:3000

--------------------------------------------------------

# PROD environment - ubuntu server (AWS EC2)

## setup server

- AWS EC2 instance t4g.small (2 vCPU, 2 GB RAM, 16 GB Disk)
- Ubuntu 26.04 (LTS) ARM64
- use elastic IP

```
ssh ubuntu@IP_ADDRESS
sudo adduser --disabled-password --gecos "" lorchess
```

`sudo` commands run as `ubuntu`; everything else as `lorchess` (no sudo), after
`sudo -u lorchess -i`.


## project code
```
sudo -u lorchess -i
git clone https://github.com/lorand77/lorchess.git
```

## install node+npm
```
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## configure environment

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

- `SESSION_SECRET` — without it a public dev default is used. One per
  environment, never committed; changing it logs everyone out.
- `NODE_ENV=production` — the session cookie then only works over HTTPS, so
  the site must be reached through Caddy, not port 3000.

Everything else has a default; see `src/config.js`.

## run the app (pm2)

To try it by hand: `npm ci --omit=dev && npm start`. To keep it running, use pm2:
```
sudo npm install -g pm2         # as ubuntu

sudo -u lorchess -i
cd ~/lorchess
npm ci --omit=dev
pm2 start npm --name "lorchess" -- start

# survive reboot:
pm2 save
pm2 startup                     # prints a `sudo env PATH=... pm2 startup ...` line: run that as ubuntu
```

The everyday pm2 commands are in `operations.md`.

## log rotation

Without it pm2's logs grow until the disk is full.
```
pm2 install pm2-logrotate
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'   # rotate daily at midnight
pm2 set pm2-logrotate:max_size 50M                 # and early if a file reaches 50 MB
pm2 set pm2-logrotate:retain 14                    # keep 14 rotated files per log
pm2 set pm2-logrotate:compress true                # gzip the rotated files

pm2 conf pm2-logrotate     # check the settings
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
    header Strict-Transport-Security "max-age=31536000"
    reverse_proxy localhost:3000
}
```

```
sudo systemctl reload caddy
```

## monitoring (Better Stack)

- Better Stack monitor on `https://lorchess.lorand77.dev/health`, every 3 min.
- Better Stack heartbeat, daily, 2 h grace. The backup cron job below pings
  it; keep its URL out of the repo.

What `/health` checks, and what an alert means, is in `operations.md`.

## backups to B2

```
sudo apt install sqlite3 rclone   # as ubuntu

sudo -u lorchess -i
mkdir -p ~/backups                # the cron line's log goes here
rclone config                     # add the B2 remote as "b2"

# check the remote:
rclone copy test1.txt b2:lorchess-backups/
rclone copy b2:lorchess-backups/test1.txt .
```

Daily cron job, as `lorchess` (`crontab -e`); `scripts/backup.sh` keeps 7 days
in `~/backups/` and 30 in B2, then the heartbeat is pinged:
```
0 3 * * * /home/lorchess/lorchess/scripts/backup.sh >> /home/lorchess/backups/backup.log 2>&1 && curl -fsS -m 10 --retry 3 -o /dev/null <heartbeat URL>
```
