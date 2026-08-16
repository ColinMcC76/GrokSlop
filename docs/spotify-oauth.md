# Spotify OAuth redirect (remote Discord users)

Spotify always sends the user’s browser to your **redirect URI** after login. That request must reach the **machine running GrokSlop** (or you complete the flow manually in Discord).

`http://127.0.0.1:3921/spotify/callback` only works when the browser is on the **same PC as the bot**. Discord users on other networks cannot use that URL directly.

## Linking (website flow)

1. Run **`/spotify link`** in Discord — you get one URL like  
   `https://spotify.mcwhorezone.com/spotify/link?state=...`
2. That page sends you to Spotify automatically.
3. After login, the browser shows **connection refused** — copy the full address bar URL.
4. Paste it on the **same page** and click **Complete linking** — you see **Spotify linked** (and a Discord DM).
5. **`/joinvc`**, then pick **GrokSlop** in Spotify → Connect.

Set in `.env`:

```env
SPOTIFY_REDIRECT_URI=https://spotify.mcwhorezone.com/spotify/callback
SPOTIFY_OAUTH_PORT=3921
LIBRESPOT_PATH=C:\path\to\librespot.exe
```

Cloudflare tunnel must route `spotify.mcwhorezone.com` → `127.0.0.1:3921` (same as before).

`/spotify finish` in Discord still works as a fallback if you prefer pasting there.

1. Expose the bot’s OAuth port to the internet, e.g.:
   - Bot on a VPS: open port `3921` or reverse-proxy `/spotify/callback` to it.
   - Bot at home: [ngrok](https://ngrok.com/) — `ngrok http 3921` → `https://xxxx.ngrok-free.app`
   - Your website: nginx `proxy_pass` to `http://127.0.0.1:3921` for path `/spotify/callback`

2. In the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) → your app → **Redirect URIs**, add the **exact** public URL, e.g.  
   `https://yourdomain.com/spotify/callback`

3. In `.env`:
   ```env
   SPOTIFY_REDIRECT_URI=https://yourdomain.com/spotify/callback
   ```

4. Restart the bot. Users run `/spotify link`, approve in the browser, see a success page, and get a **Discord DM** from the bot.

You do **not** need a custom website page unless you want branding; the bot already serves a simple HTML success response on that path.

## Option B — `/spotify finish` (no public URL)

For local redirect URIs or when the callback page does not load:

1. User runs `/spotify link` and opens the authorize URL (any device).
2. After Spotify login, the browser goes to `127.0.0.1` (may show an error page — that is OK).
3. User **copies the full address bar** (must include `code=` and `state=`).
4. User runs `/spotify finish` and pastes that URL.
5. Bot completes linking and **DMs** confirmation.

## Discord-only?

Spotify cannot redirect into Discord. The bot can **DM** the user after a successful callback or `/spotify finish`; that is the Discord confirmation.

## Spotify Dashboard checklist

- Redirect URI matches `.env` `SPOTIFY_REDIRECT_URI` exactly.
- For production/public apps, Spotify prefers **HTTPS** (localhost HTTP is fine for dev on the bot PC).

## `server_error` after login

If the browser shows **Spotify authorization failed: server_error**, the tunnel and redirect URI are usually correct — Spotify failed during login.

**Most common cause:** the app is in **Development Mode** and the Spotify user is not on the allowlist.

1. [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) → your app.
2. **Settings** → **User Management** (Users and Access).
3. **Add** the email address of the Premium account used in the browser.
4. Save, wait ~1 minute, try `/spotify link` again (incognito).

Also verify `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env` match that same app (reset secret if unsure).
