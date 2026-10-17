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

The wrapper aliases `npm` to `socket npm`; `\npm` runs plain npm without it.
- Full scan: `rm -rf node_modules && npm ci`, expect `Socket npm found no risks`.
- `npm audit fix` fixes nothing through the wrapper: use `npm audit fix --audit`.
- `npm rebuild` through the wrapper silently does nothing: use `\npm rebuild`.
- Scripts fail through the wrapper with `ERR_ACCESS_DENIED`: use `\npm test`
  or `node --run test`.

### install claude code
```
curl -fsSL https://claude.ai/install.sh | bash
```

or install the VSC extension

## run the app
```
npm ci
\npm rebuild better-sqlite3 argon2 --foreground-scripts --ignore-scripts=false   # after every npm ci
npm start
```

## test in browser
open http://localhost:3000

## updating node and socket
```
sudo apt update && sudo apt install --only-upgrade nodejs
npm install -g @socketsecurity/cli   # if it fails replacing itself: \npm install -g ...

# check
npm ci    # look for "Socket npm found no risks"
\npm rebuild better-sqlite3 argon2 --foreground-scripts --ignore-scripts=false
\npm test
```

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

Updating Node:
```
sudo apt update && sudo apt install --only-upgrade nodejs
```
then `pm2 update` as `lorchess` (see "updating pm2").

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

## run the app
```
npm ci --omit=dev
npm start
```

or better use pm2:
```
sudo npm install -g pm2         # as ubuntu

sudo -u lorchess -i
pm2 start npm --name "lorchess" -- start

# survive reboot:
pm2 save
pm2 startup                     # prints a `sudo env PATH=... pm2 startup ...` line: run that as ubuntu


pm2 list                        # see all running processes and their status
pm2 logs lorchess            # tail live logs
pm2 logs lorchess --lines 100  # show last 100 lines
pm2 restart lorchess         # restart the app (e.g. after deploying new code)
pm2 stop lorchess            # stop without removing from pm2's list
pm2 delete lorchess          # remove from pm2 entirely
pm2 monit                       # live dashboard: CPU, memory, logs
```

### updating pm2

```
sudo npm install -g pm2@latest

sudo -u lorchess -i
pm2 update                      # restarts the daemon and the app (a few seconds down)
pm2 save
pm2 list                        # lorchess "online"
```

Also run `pm2 update` after a Node update: the daemon keeps the old Node until then.


### log rotation

Without it pm2's logs grow until the disk is full. Once per server:
```
pm2 install pm2-logrotate
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'   # rotate daily at midnight
pm2 set pm2-logrotate:max_size 50M                 # and early if a file reaches 50 MB
pm2 set pm2-logrotate:retain 14                    # keep 14 rotated files per log
pm2 set pm2-logrotate:compress true                # gzip the rotated files

pm2 conf pm2-logrotate     # show the current settings
ls -lh ~/.pm2/logs/        # live and rotated files with their sizes
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

## deploying new code
```
git pull
npm ci --omit=dev
pm2 restart lorchess
```

Never `npm install` or `npm audit fix` on the server: change dependencies in
dev, commit the lockfile, deploy. If ignore-scripts is ever set here, add the
`\npm rebuild ...` line from the dev "run the app" before restarting.

## changing a user's password

In the project dir, as `lorchess`; safe while the app runs.
```
npm run user:password -- <username>
echo "<new password>" | npm run user:password -- <username>   # non-interactive
```

Existing sessions stay logged in; to kick them out, restart with a new `SESSION_SECRET`.

## deactivating a user

```
npm run user:deactivate -- <username>
npm run user:reactivate -- <username>
```

## deleting a user

No undo. First make sure the request comes from the account's owner (there is
no email on file: ask them to prove it from inside the account, e.g. by setting
their board colours to a value you name).
```
npm run user:delete -- <username>
```

Refuses during a live game: deactivate first, delete after the forfeit.

## backing up sqlite database

```
sudo apt install sqlite3        # as ubuntu

sudo -u lorchess -i
cd ~/lorchess
mkdir -p ~/backups
sqlite3 data/lorchess.sqlite "VACUUM INTO '$HOME/backups/lorchess-backup-$(date +%F).sqlite'"
```

and move the backup file somewhere safe (e.g. download to local machine, upload to cloud storage etc.)

Restore, in the project dir:
```
rclone copy b2:lorchess-backups/lorchess-backup-DATE.sqlite ~/backups/   # only if it isn't in ~/backups
pm2 stop lorchess
cp ~/backups/lorchess-backup-DATE.sqlite data/lorchess.sqlite
rm -f data/lorchess.sqlite-wal data/lorchess.sqlite-shm
pm2 start lorchess
```

### backup to B2

```
sudo apt install rclone         # as ubuntu

sudo -u lorchess -i
rclone config
rclone copy test1.txt b2:lorchess-backups/
# restore:
rclone copy b2:lorchess-backups/test1.txt .
```

Daily cron job, as `lorchess` (`crontab -e`); `scripts/backup.sh` keeps 7 days
in `~/backups/` and 30 in B2:
```
0 3 * * * /home/lorchess/lorchess/scripts/backup.sh >> /home/lorchess/backups/backup.log 2>&1
```

## monitoring (Better Stack)

`/health` answers 200 when the app is up, the database reads and >10 % of the
disk is free; otherwise 503, with the reason in `pm2 logs` (`health.failed`).

- Better Stack monitor on `https://lorchess.lorand77.dev/health`, every 3 min.
- Better Stack heartbeat, daily, 2 h grace, pinged by the backup cron job
  (keep its URL out of the repo):
  ```
  0 3 * * * /home/lorchess/lorchess/scripts/backup.sh >> /home/lorchess/backups/backup.log 2>&1 && curl -fsS -m 10 --retry 3 -o /dev/null <heartbeat URL>
  ```
