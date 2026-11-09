# Put the control panel on whorezone.party

The panel is served by the same process as the Discord bot, on `127.0.0.1:3847`. Friends open `https://whorezone.party`. A Cloudflare Tunnel on the PC forwards that address to the local panel. The panel is not a separate website, and port 3847 stays closed on the router.

Until Discord login is configured, the panel still opens on this computer and refuses every other address.

## 1. Discord sign-in

The panel uses the bot's existing application. In the [Discord Developer Portal](https://discord.com/developers/applications), open that application, then OAuth2, and add these redirects:

- `https://whorezone.party/auth/discord/callback`
- `http://127.0.0.1:3847/auth/discord/callback`
- `http://localhost:3847/auth/discord/callback`

If `DASHBOARD_PORT` is not `3847`, use that port in the two local URLs.

Copy the OAuth2 client secret. Turn on Developer Mode in Discord (User Settings, Advanced), right-click your own username, and copy your user id.

In `.env`:

```env
DISCORD_CLIENT_SECRET=the client secret from the developer portal
DASHBOARD_OWNER_ID=your Discord user id
DASHBOARD_SESSION_SECRET=a long random string
```

Create the session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`CLIENT_ID` is already the application id. Leave `TOKEN` as the bot token. The token is not the client secret, and it does not go in the tunnel config.

Restart the bot after saving `.env`. The local window asks you to sign in with Discord too. You are allowed as soon as you sign in. Everyone else sees a waiting page until you approve them.

## 2. Approve friends

Open **Access** on the panel, or go to `https://whorezone.party/admin`. That page lists people who signed in and are waiting. Approve lets them control the bot. Remove cuts them off on their next click. The list is stored in `data/dashboard-access.json`. That folder is gitignored.

## 3. Cloudflare Tunnel

1. Add `whorezone.party` to the same Cloudflare account that will run the tunnel. Use Cloudflare's nameservers at the registrar.
2. Install `cloudflared` on the Windows PC: [https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
3. `cert.pem` in `%USERPROFILE%\.cloudflared` belongs to one zone. If that file is already for another domain, `cloudflared tunnel route dns` appends that zone and creates a name like `whorezone.party.otherdomain.com` instead of `whorezone.party`. Rename the old file, then log in and pick the `whorezone.party` zone in the browser:

```bat
ren %USERPROFILE%\.cloudflared\cert.pem cert.pem.other-zone.bak
cloudflared tunnel login
cloudflared tunnel create grokslop
cloudflared tunnel route dns grokslop whorezone.party
```

The route line has to say `Added CNAME whorezone.party`. If it names any other host, stop and fix the login zone before continuing. `cert.pem` and the tunnel `.json` are secrets. Leave them in `.cloudflared` and do not send them anywhere.

4. Create `%USERPROFILE%\.cloudflared\config.yml` before starting the tunnel. Use the tunnel id from the create command. Without this file, `cloudflared` stays connected and answers every request with 503.

```yaml
tunnel: TUNNEL-ID
credentials-file: C:\Users\YOU\.cloudflared\TUNNEL-ID.json
ingress:
  - hostname: whorezone.party
    service: http://127.0.0.1:3847
  - service: http_status:404
```

5. Start the bot and the tunnel together with `Start-GrokSlop.bat`. That runs the bot in one minimized window and `cloudflared tunnel run grokslop` in a second window titled GrokSlop Tunnel.

A good start does not print `No ingress rules` or `503`. Both windows have to keep running. The page answers only while that PC is on. Close the GrokSlop Tunnel window to stop the tunnel.

`www.whorezone.party` is accepted too. Add a DNS route and the matching Discord redirect (`https://www.whorezone.party/auth/discord/callback`) if you want that name.

## What stays private

- The bot keeps listening on `127.0.0.1` only.
- A tunnel pointed at the panel before the three `.env` values are set receives a short refusal instead of the controls.
- Sign-in uses the `identify` scope, so Discord shares the account id and username and nothing else.
- The session cookie is `HttpOnly`, lasts 14 days, and is marked `Secure` on `whorezone.party`.
