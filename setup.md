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

### run the app
```
npm install

# Native modules (better-sqlite3, argon2) compile a binary in their install
# script. npm blocks that script two ways on a fresh install — clear both:
#   1. our global ignore-scripts=true          -> pass --ignore-scripts=false
#   2. npm 12's install-script allowlist       -> approve the packages first
npm install-scripts approve better-sqlite3
npm install-scripts approve argon2
npm rebuild better-sqlite3 argon2 --foreground-scripts --ignore-scripts=false

npm start
```

### test in browser
open http://localhost:3000


--------------------------------------------------------

# PROD environment 1 - ubuntu server

### setup server
- digital ocean droplet
- Ubuntu 24.04 (LTS) x64
- Basic / 1 vCPU / 1 GB RAM / 25 GB Disk
- add ssh key

```
ssh root@IP_ADDRESS
adduser --disabled-password --gecos "" lorchess
su - lorchess
```

### project code
```
git clone https://github.com/lorand77/lorchess.git
```

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

# adding a new package:
socket npm install PACKAGE_NAME

# if needed:
socket npm install PACKAGE_NAME --ignore-scripts=false

socket wrapper on
npm install PACKAGE_NAME     ## routed via socket now
```

### run the app
```
npm install

# Native modules (better-sqlite3, argon2) compile a binary in their install
# script. npm blocks that script two ways on a fresh install — clear both:
#   1. our global ignore-scripts=true          -> pass --ignore-scripts=false
#   2. npm 12's install-script allowlist       -> approve the packages first
npm install-scripts approve better-sqlite3
npm install-scripts approve argon2
npm rebuild better-sqlite3 argon2 --foreground-scripts --ignore-scripts=false

npm start
```

or better use pm2:
```
socket npm install -g pm2

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

## open firewall
digital ocean: create firewall, allow port 3000, assign to droplet

## in browser
open http://142.93.50.247:3000

## deploying new code
```
git pull
npm install        # in case dependencies changed
pm2 restart lorchess
```

## backing up sqlite database

@@@TODO
```
```

and move the backup file somewhere safe (e.g. download to local machine, upload to cloud storage etc.)

--------------------------------------------------------

# PROD environment 2 - platform-as-a-service 

@@@TODO

