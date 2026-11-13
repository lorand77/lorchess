# Operations

Everything done again and again once the app is installed (installing is in
`setup.md`). On the server, `sudo` commands run as `ubuntu`; everything else as
`lorchess`, after `sudo -u lorchess -i`, in `~/lorchess`.

## deploying new code
```
git pull
npm ci --omit=dev
pm2 restart lorchess
```

Never `npm install` or `npm audit fix` on the server: change dependencies in
dev, commit the lockfile, deploy. If ignore-scripts is ever set here, add the
`\npm rebuild ...` line from "run the app" in `setup.md` before restarting.

## pm2
```
pm2 list                        # see all running processes and their status
pm2 logs lorchess               # tail live logs
pm2 logs lorchess --lines 100   # show last 100 lines
pm2 restart lorchess            # restart the app (e.g. after deploying new code)
pm2 stop lorchess               # stop without removing from pm2's list
pm2 delete lorchess             # remove from pm2 entirely
pm2 monit                       # live dashboard: CPU, memory, logs
ls -lh ~/.pm2/logs/             # live and rotated log files with their sizes
```

## updating

### Node and socket (dev)
```
sudo apt update && sudo apt install --only-upgrade nodejs
npm install -g @socketsecurity/cli   # if it fails replacing itself: \npm install -g ...

# check
npm ci    # look for "Socket npm found no risks"
\npm rebuild better-sqlite3 argon2 --foreground-scripts --ignore-scripts=false
\npm test
```

### Node (prod)
```
sudo apt update && sudo apt install --only-upgrade nodejs   # as ubuntu

sudo -u lorchess -i
pm2 update                      # the daemon keeps the old Node until then
pm2 list                        # lorchess "online"
```

### pm2 (prod)
```
sudo npm install -g pm2@latest  # as ubuntu

sudo -u lorchess -i
pm2 update                      # restarts the daemon and the app (a few seconds down)
pm2 save
pm2 list                        # lorchess "online"
```

## users

All safe while the app runs.

### changing a password
```
npm run user:password -- <username>
echo "<new password>" | npm run user:password -- <username>   # non-interactive
```

Existing sessions stay logged in; to kick them out, restart with a new `SESSION_SECRET`.

### deactivating
```
npm run user:deactivate -- <username>
npm run user:reactivate -- <username>
```

### deleting

No undo. First make sure the request comes from the account's owner (there is
no email on file: ask them to prove it from inside the account, e.g. by setting
their board colours to a value you name).
```
npm run user:delete -- <username>
```

Refuses during a live game: deactivate first, delete after the forfeit.

## backups

The cron job runs `scripts/backup.sh` daily at 03:00 (see "backups to B2" in
`setup.md`); its output is in `~/backups/backup.log`.

Backup by hand:
```
scripts/backup.sh               # same as the nightly job: ~/backups/ and B2
sqlite3 data/lorchess.sqlite "VACUUM INTO '$HOME/backups/lorchess-backup-$(date +%F).sqlite'"   # local copy only
```

### restore
```
rclone copy b2:lorchess-backups/lorchess-backup-DATE.sqlite ~/backups/   # only if it isn't in ~/backups
pm2 stop lorchess
cp ~/backups/lorchess-backup-DATE.sqlite data/lorchess.sqlite
rm -f data/lorchess.sqlite-wal data/lorchess.sqlite-shm
pm2 start lorchess
```

If the whole instance is gone: build a new one from the PROD half of
`setup.md`, then restore as above.

## monitoring

`/health` answers 200 when the app is up, the database reads and >10 % of the
disk is free; otherwise 503, with the reason in `pm2 logs` (`health.failed`).

- Better Stack monitor alert: the app, Caddy or the box is down, or `/health`
  failed; start with `pm2 list` and `pm2 logs lorchess`.
- Heartbeat alert: the nightly backup failed or did not run; see
  `~/backups/backup.log`.
