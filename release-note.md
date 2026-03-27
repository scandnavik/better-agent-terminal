# Release Notes — v2.1.x

## v2.1.1

### New Features

#### Skills Panel
- Right sidebar new "Skills" tab (alongside Snippets) showing available slash commands
- Split into **Custom** (user-defined `.claude/commands/`) and **Built-in** (system) sections with separator
- Click any skill to insert `/command` into Agent chat input
- Auto-loads from SDK `supportedCommands()` with 3s retry for fresh sessions
- Only visible for Claude Code terminals
- Filesystem scan reads project-level and global `.claude/commands/*.md`

#### Markdown Preview Panel
- Click `.md` file paths in Agent chat to open live preview in right sidebar
- Auto-updates on file changes via `fs.watch`
- Header with filename, copy path, open file, and close buttons
- Reuses existing markdown pipeline (marked + DOMPurify + highlight.js + mermaid)

#### Default Model & Effort Settings
- New settings: Default Model (text input) and Default Effort Level (dropdown)
- Applied to new Agent sessions automatically
- Default effort changed from `high` to `medium`
- Removed `max` effort from UI (SDK still accepts it for Opus 4.6)

#### Enable 1M Context Toggle
- New checkbox in Settings to enable/disable 1M token context window
- Default: enabled (1M is GA for Opus 4.6 / Sonnet 4.6)

#### Create New Workspace Folder
- "Add Workspace" button now has a "+" split button to create a new folder
- Uses save dialog to pick location and name, auto-creates the directory

#### Workspace Context Menu
- Added "Copy Path" option to right-click workspace menu

### Improvements

#### Statusline
- **ctx%** now uses per-turn `usage.input_tokens` (actual context size) instead of cumulative total
  - Previously showed misleading values like "ctx 184%" after many turns
  - Tooltip shows both current context and total consumption
- **maxOut** statusline item shows max output tokens (e.g. `maxOut:64k`)
  - Default hidden, enable in statusline settings
- **last_tool_name** shown in active tasks bar (e.g. `Searching codebase [Grep]`)

#### Input
- Agent input textarea auto-grows up to ~8 lines as you type
- Shrinks back to 1 line on clear/send

#### SDK & Token Counting
- Updated claude-agent-sdk to 0.2.81 and claude-code to 2.1.81
- Fixed token counting to include cache tokens (cacheRead + cacheCreate)
- Removed blink animation from task elapsed time display

### Bug Fixes
- Fixed usage polling rate-limit backoff (use retryAfterSec directly)
- Support `file://` URLs in LinkedText
- Restored original 2min usage polling (SDK rate_limits lacks 7d data)

### Community Contributions
- **@Owen0857**: Collapse output for read-only tools (Read, Glob, Grep, LS) (#42)
- **@Owen0857**: Usage polling rate-limit backoff fix (#44)
- **@Owen0857**: SDK plugin loading support (#40)
- **@handpower**: File URL parsing fix (#41)
- **@handpower**: Markdown rendering in Agent chat panel (#39)
