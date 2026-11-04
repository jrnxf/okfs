# Letting other machines in

## Letting other machines in

okfs listens on the loopback address, which only the machine it runs on can reach. `--bind 0.0.0.0` lets the network in, and from then on okfs asks for a key. It makes a random one each time it starts, and prints every address with the key on it:

```text
  at       http://192.168.1.20:8080/?key=...
  key      on: anyone with one of these links can read every file shown
```

A request without the key is refused. A browser that opens the link is given a cookie that holds the key, and the key is taken out of the address bar; a program such as `curl` adds `?key=...` to each request. `--qr` prints a code for the same link, so a phone opens the folder by scanning it. The key is new at every start, so an old link stops working when okfs restarts.

What the key does and does not do:

- It stops anyone who can reach the address but does not have the link. It does not stop anyone who can watch the traffic. Without a certificate okfs speaks plain HTTP, so on open Wi-Fi, or on a network whose password others know, a program that captures packets reads the key and then every file. Treat such a link as you would a password sent over plain HTTP. For anything beyond a network you trust, serve [HTTPS](#https) or put a TLS proxy in front (see [Behind a proxy or a tunnel](#behind-a-proxy-or-a-tunnel)).
- The cookie is `HttpOnly` and `SameSite=Strict`, which keeps scripts and other sites' pages from using it. A browser still sends a cookie to every port of the same host. Any other web service on the same machine, on any port, therefore receives the key from a browser that has opened okfs. Do not run okfs on a machine that also runs listeners you do not trust.
- On a machine with other users, another account can read the command that opens the browser. So the browser okfs opens itself gets a one-time `?once=` code in place of the key. The first request that brings the code trades it for the cookie, and a code no browser has used dies after 60 seconds.
- The key is not a login. Anyone who has the link has all of it: with a write flag, that includes changing and deleting.
- An HTML page in the preview is sandboxed in an origin of its own, and a browser sends no cookie with what it asks for. So while the key is on, the page is shown at an address that carries a pass to its own folder in place of the key. The pass lets in reading the files in that folder and the folders below it, so the page's images, stylesheets, scripts and links to its neighbours load. It lets in nothing else: no file above or beside that folder, no listing, no other route and no write. The page's scripts can read the pass, as they can its address, and could send it elsewhere: anyone who gets it can read that folder, until okfs restarts. The key itself is never put in a page's address. The same page opened directly under `/raw/` still sends no key, so there it cannot load its neighbours.

`--no-key` turns the key off. Use it only when something in front of okfs already decides who gets in, such as a proxy that signs people in, or on a network where everyone may read the folder. `--key` asks for the key on a loopback address too, for a tunnel that exposes it to anyone. `--allow-upload`, `--allow-edit` and `--allow-delete` each do the same, so that another account on the machine cannot change the folder. The browser okfs opens gets a one-time code, so on your own machine nothing looks different.

## HTTPS

Give okfs a certificate and its private key, both PEM files, and it serves https instead of http:

```sh
okfs --bind 0.0.0.0 --tls-cert cert.pem --tls-key key.pem
```

The two flags go together: one without the other is refused. Every address okfs prints starts with `https://`, and so do the `--qr` code and the link the browser opens with. The key, the one-time code and the host check work as they do over http, and the key's cookie is marked `Secure`. The port answers https alone: a browser that asks it for plain http gets no answer, so the key never crosses in the clear.

okfs does not make a certificate. Two ways to get one:

- [mkcert](https://github.com/FiloSottile/mkcert) makes one for the addresses you name, signed by a certificate authority of its own: `mkcert 192.168.1.20 localhost 127.0.0.1`. The browsers on the machine that ran `mkcert -install` trust it. A phone or another computer trusts it once you install mkcert's root certificate on it (`mkcert -CAROOT` says where it is). Until then they warn about it.
- A certificate for a name of your own, such as the one a reverse proxy or Let's Encrypt keeps for `files.example.com`. Point that name at the machine and pass `--allow-host files.example.com` too, as okfs answers only to [names it is given](#behind-a-proxy-or-a-tunnel).

okfs reads the files once, when it starts. Restart it after the certificate is renewed.

## Behind a proxy or a tunnel

On every address it listens on, okfs answers only to `localhost`, to plain addresses such as `127.0.0.1` or `192.168.1.20`, and to the names you give it with `--allow-host`. Any other name in a request's `Host` gets a refusal that names the flag to pass. This stops a hostile web page from reaching okfs by pointing a host name of its own at your machine, also when okfs listens on `0.0.0.0` and the machine it points at is another one on your network. If you put a proxy or a tunnel in front, name the host it uses:

```sh
okfs --allow-host files.example.com
```

A name of your own on the network, such as `my-laptop.local`, needs `--allow-host` too. A plain address always works, as `--bind 0.0.0.0` prints it.

The host check is not a password. A program other than a browser can send any name it likes, so okfs behind a proxy that asks people to sign in is still open to anything that can reach its own address directly. Keep that address where only the proxy can reach it: listen on loopback with the proxy on the same machine, or let a firewall through to okfs's port from the proxy alone. On loopback okfs asks for no key, unless a write flag is on. If okfs has to listen beyond loopback behind a proxy that signs people in, pass `--no-key`, or the proxy's users are asked for a key they do not have.

A proxy that ends TLS gives you https without `--tls-cert`, and okfs then marks its key cookie `Secure` when the proxy sends `X-Forwarded-Proto: https`. A tunnel such as Cloudflare Tunnel or Tailscale Funnel does the same job without a proxy of your own: run okfs on loopback, name the tunnel's host with `--allow-host`, and add `--key` unless the tunnel signs people in.

okfs cannot live under a path such as `example.com/files/`. Every address it uses starts at `/`, and there is no base-path option. Give it a host name of its own, such as `files.example.com`.

## Run it for good

okfs stops cleanly on SIGTERM as well as Ctrl-C, so a service manager can stop it. Run it on loopback, without opening a browser, and put the proxy in front.

### systemd

`/etc/systemd/system/okfs.service`:

```ini
[Unit]
Description=okfs file browser
After=network.target

[Service]
ExecStart=/usr/local/bin/okfs --no-open --bind 127.0.0.1 --port 8080 --allow-host files.example.com /srv/files
DynamicUser=yes
ReadOnlyPaths=/srv/files
Environment=XDG_CACHE_HOME=/var/cache
CacheDirectory=okfs
NoNewPrivileges=yes
ProtectHome=yes
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`DynamicUser=yes` runs okfs as a user with no account, so the files in `/srv/files` must be readable by everyone. With a write flag, okfs has to be able to write there: use `ReadWritePaths=` in place of `ReadOnlyPaths=`, and a `User=` that owns the folder. `CacheDirectory=okfs` gives it `/var/cache/okfs` for thumbnails and PDF pictures, and `XDG_CACHE_HOME` points okfs there. Then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now okfs
```

### launchd

`~/Library/LaunchAgents/co.example.okfs.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>co.example.okfs</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/okfs</string>
    <string>--no-open</string>
    <string>--bind</string>
    <string>127.0.0.1</string>
    <string>--port</string>
    <string>8080</string>
    <string>/Users/user/files</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/co.example.okfs.plist
```

A service on a Mac reads only the folders it has been given access to. If `/Users/user/files` is under Documents, Desktop or Downloads, give the `okfs` binary Full Disk Access in System Settings first.

### Caddy

```caddyfile
files.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

Caddy gets the certificate and passes the `Host` header on.

### nginx

```nginx
server {
    listen 443 ssl;
    server_name files.example.com;
    # ssl_certificate and ssl_certificate_key here

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

`proxy_buffering off` and the long read timeout keep `/api/events`, the stream that tells the page about changes, open. Without them the page still works but stops following the folder.

In both, start okfs with `--allow-host files.example.com`. To ask people to sign in, add that to the proxy (basic auth in Caddy or nginx, or an auth proxy), and keep okfs on loopback.
