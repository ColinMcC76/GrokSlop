# YouTube playback (`/play`)

GrokSlop plays YouTube audio with **yt-dlp** first, then **play-dl** as a fallback.

## HTTP 403 Forbidden

YouTube often blocks outdated yt-dlp builds. If every video fails with `HTTP Error 403`:

### 1. Update yt-dlp (most important)

In PowerShell:

```powershell
yt-dlp -U
```

Or download the latest release from [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases).

GrokSlop already passes YouTube workarounds (`player_client=default,-android_sdkless` and `--js-runtimes node`). You still need a **recent yt-dlp** binary.

### 2. Optional: browser cookies (if 403 persists)

Add to `.env` (Chrome example — Edge/Firefox also work):

```env
YT_DLP_COOKIES_FROM_BROWSER=chrome
```

Or export a cookies file and set:

```env
YT_DLP_COOKIES=C:\Users\colin\Personal Use\Powershell\grokbot\cookies.txt
```

### 3. Optional: custom yt-dlp path

```env
YT_DLP_PATH=C:\path\to\yt-dlp.exe
```

### 4. Restart GrokSlop

After updating yt-dlp or changing `.env`, restart the bot.

## Logs

Check `logs\error.log` in the grokbot folder for `[YouTube queue]` lines.
