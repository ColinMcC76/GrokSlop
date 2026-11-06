# YouTube playback (`/play`)

GrokSlop plays YouTube with **yt-dlp** (pipe stream, direct URL + ffmpeg, or temp download). **play-dl** is only used for search/URL lookup — not streaming (YouTube breaks it often).

## Your log pattern (403 everywhere)

If `error.log` shows:

- `yt-dlp (default) failed: HTTP Error 403`
- `yt-dlp (m3u8-ios) failed: HTTP Error 403`
- `Failed to decrypt with DPAPI` (browser cookies)
- `play-dl ... Invalid URL`

Do the steps below in order.

## 1. Update yt-dlp (required)

In PowerShell:

```powershell
yt-dlp -U
```

If that does not help:

```powershell
yt-dlp --update-to nightly
```

Confirm version:

```powershell
yt-dlp --version
```

You want a **2026** build (e.g. `2026.01.29` or newer nightly).

Set in `.env` if yt-dlp is not on PATH:

```env
YT_DLP_PATH=C:\path\to\yt-dlp.exe
```

## 2. Install Deno (JS challenge solver)

YouTube now needs a JS runtime for yt-dlp:

```powershell
irm https://deno.land/install.ps1 | iex
```

Add Deno to PATH, then in `.env`:

```env
YT_DLP_JS_RUNTIME=deno
```

(Node alone may not be enough — Deno is recommended.)

## 3. Fix cookies (remove broken browser option)

**Do not use** `YT_DLP_COOKIES_FROM_BROWSER=chrome` if you see **DPAPI** errors — that happens when the bot runs as a different user/session than your browser.

Instead:

1. Install a “Get cookies.txt” browser extension for YouTube
2. Export cookies while logged into YouTube
3. Save as `cookies.txt` in your grokbot folder
4. In `.env`:

```env
YT_DLP_COOKIES=C:\Users\colin\Personal Use\Powershell\grokbot\cookies.txt
YT_DLP_SKIP_BROWSER_COOKIES=1
```

Remove or comment out `YT_DLP_COOKIES_FROM_BROWSER`.

## 4. Optional extras

```env
YT_DLP_IMPERSONATE=chrome
```

(Only if your yt-dlp build supports `--impersonate`.)

## 5. Restart GrokSlop

```powershell
cd "C:\Users\colin\Personal Use\Powershell\grokbot"
git pull
node index.js
```

On first `/play`, the console logs `[YouTube queue] yt-dlp <version>`.

## Header overflow (`HPE_HEADER_OVERFLOW`)

`/play` used to ask **play-dl** for the title. YouTube's reply headers are often bigger than Node's 16KB default, which shows up as:

```text
Parse Error: Header overflow
code: 'HPE_HEADER_OVERFLOW'
```

or, when the watch page no longer matches play-dl:

```text
Initial Response Data is undefined.
```

Starting the bot (`node index.js`) raises that limit automatically. If play-dl still cannot read the page, the same `/play` falls back to **yt-dlp** for the title and queue entry. Playback was already yt-dlp.

## Audio plays in French (or another auto-dub)

YouTube attaches auto-dubbed audio tracks to English videos. The smallest of those tracks was being selected, which is often French. `/play` now asks yt-dlp for the **original** audio track first (`format_note*=original`, then language preference), and only then any other audio. A video that is actually French still plays in French. Set `YT_DLP_FORMAT` only if you want a different selector.

## Logs

Check `logs\error.log` for `[YouTube queue]` lines.
