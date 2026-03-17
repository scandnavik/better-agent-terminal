# CLAUDE.md - Project Guidelines

## Logging

- **Frontend (renderer)**: Use `window.electronAPI.debug.log(...)` instead of `console.log()`. This sends logs to the electron main process logger, which writes to disk.
- **Backend (electron)**: Use `logger.log(...)` / `logger.error(...)` from `./logger`.
- Do NOT use `console.log()` for debugging — use the logger so logs are persisted and visible in the log file.
