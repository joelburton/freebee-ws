# Server setup

Files in this directory:

- `nginx` — nginx server block (HTTPS + WebSocket-aware reverse proxy → :3001).
- `freebee.service` — systemd unit that runs `node server/server.js` and
  restarts it on crash / boot.

Both files contain placeholder paths and hostnames — read them and edit
before installing.

## Install nginx config

```sh
sudo cp setup/nginx /etc/nginx/sites-available/freebee
sudo ln -s /etc/nginx/sites-available/freebee /etc/nginx/sites-enabled/freebee
sudo nginx -t            # validate
sudo systemctl reload nginx
```

To restart later (after editing the config):

```sh
sudo nginx -t && sudo systemctl reload nginx   # graceful: no dropped connections
sudo systemctl restart nginx                   # only if reload won't do (e.g. nginx upgrade)
```

TLS certs are issued by Certbot — once for the hostname:

```sh
sudo certbot --nginx -d freebee.example.com
```

## Install Freebee as a systemd service

One-time:

```sh
# Build the production bundle into dist/.
cd /opt/freebee
npm ci
npm run build

# Install the unit and enable it (enable = start on boot).
sudo cp setup/freebee.service /etc/systemd/system/freebee.service
sudo systemctl daemon-reload
sudo systemctl enable --now freebee
```

Day-to-day:

```sh
sudo systemctl status freebee     # is it running?
sudo systemctl restart freebee    # apply code changes (after `npm run build`)
sudo systemctl stop freebee
sudo journalctl -u freebee -f     # follow logs
```

After pulling new code:

```sh
cd /opt/freebee
git pull
npm ci
npm run build
sudo systemctl restart freebee
```

## Things to edit before first install

In `setup/freebee.service`:

- `User=` / `Group=` — the unprivileged user that owns the checkout.
- `WorkingDirectory=` and `ReadWritePaths=` — wherever you cloned the repo
  (e.g. `/opt/freebee`, `/home/joel/freebee`).
- `ExecStart=` — path to `node` from `which node` on the server (often
  `/usr/bin/node`, but `/usr/local/bin/node` or an `nvm`-managed path are
  common).

In `setup/nginx`:

- `server_name` — the hostname you're serving from.
- `ssl_certificate` / `ssl_certificate_key` paths — match the hostname
  Certbot issued the cert for.
