# Project Rules

- Use `var` instead of `const`/`let`. No arrow functions.
- Server-side: CommonJS (`require`). Client-side: ES modules (`import`).
- Never use browser-native `alert()`, `confirm()`, or `prompt()`. Always use custom JS dialogs/modals instead.
- When rebuilding daemon config (e.g. `restartDaemonFromConfig()`), always use `Object.assign({}, lastConfig, overrides)` to preserve all existing settings. Never reconstruct config by manually listing fields.
- Before adding new code, read [docs/guides/MODULE_MAP.md](docs/guides/MODULE_MAP.md) to find the right file. Never add inline logic to `project.js` handleMessage.
- Never use `localStorage` for user settings or preferences. All settings must be stored server-side (via WebSocket messages or REST API) so they persist across devices and browsers.
- Client modules (`lib/public/modules/`): state goes in store.js (zustand-like), WS via ws-ref.js, functions via direct import. Never use `var _ctx = null` / `initXxx(ctx)`. See [docs/guides/CLIENT_MODULE_DEPS.md](docs/guides/CLIENT_MODULE_DEPS.md).

## Restarting Clay

Never run `node bin/cli.js` or any Clay start/restart command directly from bash. Clay runs as a persistent daemon in its own Herdr tab inside the Clay workspace. To restart: ask the user to do it via Herdr, or instruct them to restart it from that tab. Launching it from a bash command will either fail silently or start a conflicting process.
