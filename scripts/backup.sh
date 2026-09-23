#!/bin/bash
# Daily SQLite backup to B2.
# Cron (as lorchess user):
#   0 3 * * * /home/lorchess/lorchess/scripts/backup.sh >> /home/lorchess/backups/backup.log 2>&1
set -e
export PATH=/usr/local/bin:/usr/bin:/bin

FILE=/home/lorchess/backups/lorchess-backup-$(date +%F).sqlite

mkdir -p /home/lorchess/backups
rm -f "$FILE"
sqlite3 /home/lorchess/lorchess/data/lorchess.sqlite "VACUUM INTO '$FILE'"
rclone copy "$FILE" b2:lorchess-backups/

# Delete local backups older than 7 days
find /home/lorchess/backups -name 'lorchess-backup-*.sqlite' -mtime +7 -delete

# Delete B2 backups older than 30 days
rclone delete b2:lorchess-backups/ --min-age 30d --b2-hard-delete

echo "$(date) backup OK: $FILE"