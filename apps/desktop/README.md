# The Shark desktop

Windows shell around `apps/web`. Same UI, same Supabase project. There is no second frontend.

## Run

From the repo root, with Rust stable (rustfmt and clippy), the WebView2 runtime, and pnpm:

```bash
pnpm install
pnpm desktop:dev
```

`desktop:dev` starts the web app's Vite server at `http://127.0.0.1:5173` and opens it in the window. Sign-in uses the Supabase URL baked into that dev server (`apps/web/.env.development`, local API at `http://127.0.0.1:55421`).

```bash
pnpm desktop:check
pnpm desktop:build
```

`desktop:check` is `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test` in `src-tauri`. `desktop:build` runs the web app's production `build` script, then `tauri build`.

## Installer

The NSIS installer is written to:

`apps/desktop/src-tauri/target/release/bundle/nsis/`

It installs for the current user only (no administrator prompt). Installer languages are Arabic and English. There is no code signing and no auto-updater.

Windows SmartScreen will warn that the publisher is unknown. Choose **More info → Run anyway**.

## Supabase

The installed app is a client of Supabase, the same way the browser app is. It does not keep its own database.

`app.security.csp` in `src-tauri/tauri.conf.json` is the release policy. `connect-src` allows `'self'` and the local API `http://127.0.0.1:55421`. When the hosted project exists, add its `https://…supabase.co` origin to `connect-src` in **both** `app.security.csp` and `app.security.devCsp`, and provide `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to the web build (`.env.production`, not committed). The installer freezes the URL and the CSP at build time.

Release `style-src` is `'self'` only. Tailwind is compiled into a stylesheet file. The dev policy allows `'unsafe-inline'` styles and scripts because the Vite dev server injects Tailwind in a `<style>` tag and an inline React refresh preamble. Neither policy allows `'unsafe-eval'`.

Devtools are available in debug builds. Release builds do not enable the `devtools` crate feature, so the inspector stays off.

Reloading the window on `/login` or `/` works with the web app's `BrowserRouter`. Tauri's asset protocol serves `index.html` when the path is not a file, and the address stays on that path.
