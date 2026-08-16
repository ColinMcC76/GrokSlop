# Spotify Connect linking (Discord only)

GrokSlop uses **librespot** so your server appears as a Spotify Connect speaker. Linking happens entirely in Discord — no website or tunnel required.

## Requirements

- **Spotify Premium** on the account you link
- **librespot** built and `LIBRESPOT_PATH` set in `.env` (see [librespot-windows.md](./librespot-windows.md))

```env
LIBRESPOT_PATH=C:\path\to\librespot.exe
SPOTIFY_DEVICE_NAME=GrokSlop
```

`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, and `SPOTIFY_REDIRECT_URI` are **not** used for Connect linking.

## Link your server

1. Run **`/spotify link`** in Discord.
2. Open the **Spotify login link** from the bot’s reply in your browser.
3. Sign in and approve access.
4. The browser will show **connection refused** or **can’t reach this page** — that is expected.
5. Copy the **entire URL** from the address bar (`http://127.0.0.1/login?code=...`).
6. Run **`/spotify finish`** and paste that URL into the `redirect` field.

The bot confirms in Discord and sends a DM with next steps.

## Play music in Discord

1. Run **`/joinvc`** so the bot joins your voice channel.
2. In Spotify (phone or desktop), open **Connect to a device**.
3. Pick **GrokSlop** (or your `SPOTIFY_DEVICE_NAME`).
4. Start playback — everyone in the voice channel hears it.

Use **`/spotify status`** anytime for link state and these steps.

## Troubleshooting

| Issue | What to do |
|-------|------------|
| `/spotify finish` says no pending login | Run `/spotify link` again and finish within 15 minutes |
| Device missing in Spotify Connect | Run `/spotify status`; check bot console for librespot errors |
| `INVALID_CREDENTIALS` | Unlink and re-link; account must be **Premium** |
| No audio in Discord | Run `/joinvc`; confirm playback is on the GrokSlop device, not your phone speaker |
| YouTube blocked | Stop Spotify playback or `/spotify unlink` before `/play` |

## Unlink

Run **`/spotify unlink`** to disconnect Spotify for the server.
