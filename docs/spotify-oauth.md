# Spotify OAuth redirect (remote Discord users)

Spotify always sends the user’s browser to your **redirect URI** after login. That request must reach the **machine running GrokSlop** (or you complete the flow manually in Discord).

`http://127.0.0.1:3921/spotify/callback` only works when the browser is on the **same PC as the bot**. Discord users on other networks cannot use that URL directly.

## Linking (librespot OAuth — required for Connect)

Spotify Connect uses **librespot’s own OAuth**, not the Spotify Developer Dashboard Web API tokens. Those old tokens cause `INVALID_CREDENTIALS` at startup.

1. Run **`/spotify link`** in Discord.
2. Open the **Browse to:** URL in a browser (Premium account).
3. After login, the browser shows **connection refused** — copy the full URL (`http://127.0.0.1/login?code=...`).
4. Run **`/spotify finish`** and paste that URL.
5. **`/joinvc`**, then in Spotify pick **GrokSlop** under Connect.

Set `LIBRESPOT_PATH` in `.env` to your `librespot.exe`.

If Connect fails after an old link, run **`/spotify unlink`** then link again.

## Legacy Web API redirect (optional)

The `SPOTIFY_CLIENT_ID` / callback server is optional and no longer used for Connect login.

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
