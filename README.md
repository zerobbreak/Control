# Mission Control

See [VISION.md](VISION.md) for the product vision.

## Project layout

- `backend/` - standalone Rust backend crate.
- `desktop/` - Tauri 2 desktop app with a React + TypeScript frontend.

## Run the desktop app

Install the frontend dependencies once:

```powershell
cd desktop
npm install
```

Start the Tauri development app:

```powershell
npm run tauri dev
```

Build the frontend:

```powershell
npm run build
```

## Rust workspace

Check all Rust workspace crates:

```powershell
cargo check
```