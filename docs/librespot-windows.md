# librespot on Windows (for GrokSlop Spotify Connect)

The official [librespot v0.8.0 release](https://github.com/librespot-org/librespot/releases/tag/v0.8.0) is **source only** (no `.exe`). You build once, then point GrokSlop at the binary.

You do **not** need librespot on your PATH if `.env` sets `LIBRESPOT_PATH` to the full path of `librespot.exe`.

## 1. Install Rust

1. Open [https://rustup.rs](https://rustup.rs) and run **rustup-init.exe** (64-bit).
2. Accept defaults (install stable, add to PATH).
3. **Close and reopen PowerShell**, then check:

```powershell
rustc --version
cargo --version
```

## 2. Install C++ build tools (required to compile)

Rust on Windows needs the MSVC linker.

1. Download [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).
2. Run the installer and select workload **“Desktop development with C++”** (includes MSVC and Windows SDK).
3. Reboot if prompted, then open a **new** PowerShell window.

## 3. Get librespot source (v0.8.0)

Pick a folder, e.g. `C:\tools`:

```powershell
cd C:\tools
git clone --branch v0.8.0 --depth 1 https://github.com/librespot-org/librespot.git
cd librespot
```

If you do not have Git, download the **Source code (zip)** from the v0.8.0 release page, extract it, and `cd` into that folder.

## 4. Build release binary

First build can take **10–20 minutes** (downloads crates).

```powershell
cargo build --release
```

When it finishes, the executable is:

```text
C:\tools\librespot\target\release\librespot.exe
```

Quick test (should print help, not “not recognized”):

```powershell
C:\tools\librespot\target\release\librespot.exe -h
```

## 5. Configure GrokSlop `.env`

In your `grokbot` folder `.env` (use your real path):

```env
LIBRESPOT_PATH=C:\tools\librespot\target\release\librespot.exe
```

Optional:

```env
SPOTIFY_DEVICE_NAME=GrokSlop
```

Restart the bot: `node .\index.js`

Then run **`/spotify link`** in Discord, complete login in your browser, and finish with **`/spotify finish`**. See [spotify-oauth.md](./spotify-oauth.md).

## 6. Optional: add to PATH

Only if you want to run `librespot` from any folder without `LIBRESPOT_PATH`:

**Current PowerShell session:**

```powershell
$env:Path += ";C:\tools\librespot\target\release"
```

**Permanent (user PATH):**

```powershell
[Environment]::SetEnvironmentVariable(
  "Path",
  [Environment]::GetEnvironmentVariable("Path", "User") + ";C:\tools\librespot\target\release",
  "User"
)
```

Restart PowerShell after that. GrokSlop still prefers `LIBRESPOT_PATH` when set.

## Troubleshooting

| Problem | Fix |
|--------|-----|
| `spawn librespot ENOENT` | Set `LIBRESPOT_PATH` to the full `librespot.exe` path; restart bot |
| `link.exe` / `MSVC` errors | Install **Desktop development with C++** build tools |
| `cargo` not found | Reopen terminal after rustup; run `rustup default stable` |
| Device not in Spotify | Same Premium account as `/spotify link`; run `/spotify status`; check bot console for `[spotify:]` errors |
| Build very slow | Normal on first `cargo build --release` |

## Automated script

From the repo root (after Rust + Build Tools are installed):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-librespot-windows.ps1
```

It clones v0.8.0 (if needed), builds release, and prints the `LIBRESPOT_PATH` line for `.env`.
