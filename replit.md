# Overview

Goat Bot V2 is a comprehensive Facebook Messenger chatbot built with Node.js that operates using a personal Facebook account through an unofficial Facebook API. The bot provides extensive command handling, event management, user/thread data management, and a web-based dashboard for configuration. It supports multiple database backends (JSON, SQLite, MongoDB) and includes features like automated uptime monitoring, Google Drive integration, and extensive customization options.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Core Architecture
The application follows a modular architecture with clear separation of concerns:

- **Entry Point**: `index.js` serves as the main entry point, spawning the main bot process (`Goat.js`) with automatic restart capabilities
- **Main Bot Logic**: `Goat.js` handles initialization, configuration validation, and core bot startup
- **Modular Design**: Separated into distinct modules for bot functionality, dashboard, database operations, and utilities

## Bot Framework
- **Event-Driven Architecture**: The bot uses an event-driven model to handle incoming messages, reactions, and Facebook events
- **Command System**: Modular command system with dynamic loading from the `scripts/cmds/` directory
- **Event Handlers**: Separate event handlers in `scripts/events/` for non-command interactions
- **Handler Chain**: Multi-layered handler system including authentication, data validation, and command execution

## Database Layer
- **Multi-Database Support**: Flexible database abstraction supporting JSON files, SQLite, and MongoDB
- **Data Controllers**: Centralized data controllers for users, threads, dashboard, and global data
- **Task Queue System**: Implements task queuing for database operations to prevent conflicts
- **Auto-Sync**: Optional automatic synchronization with Facebook thread data

## Authentication & Security
- **Facebook Authentication**: Uses unofficial Facebook API with cookie-based authentication
- **Multi-Login Methods**: Supports email/password, cookie-based, and token-based login
- **Dashboard Authentication**: Separate authentication system for web dashboard access
- **Role-Based Access**: Hierarchical permission system (bot admin, thread admin, regular user)
- **Liberty E2EE Protocol**: Full End-to-End Encryption using Signal Protocol (X3DH + Double Ratchet)
  - Located in `bot/e2ee/`
  - Uses Node.js built-in `crypto` module only (no extra packages)
  - PIN-based AES-256-GCM for simple sessions
  - X3DH key exchange for asynchronous session establishment
  - Double Ratchet for forward secrecy per-message keys
  - Works in DMs, encrypted groups, and regular groups
  - Config: `config.json → e2ee.pin` or env var `E2EE_PIN`
  - Command: `/e2ee` (status, handshake, pin, end, verify, setpin, sessions, encrypt, decrypt)

## Web Dashboard (WHITE V3 Admin Panel)
- **Express.js Backend**: Custom Arabic RTL admin panel on port 8080
- **Session Management**: Cookie-based session with password auth
- **Mobile-Responsive UI**: Hamburger sidebar + bottom navigation bar on mobile (≤768px)
- **Live Logs**: `/logs` page polls `/api/logs/json` every 5 seconds via AJAX (no page reload)
- **Quick Send**: `/send` page lets admin send messages to any bot thread directly from the panel
- **RAM Monitor**: Status page shows live memory (RSS MB) updated every 15 seconds
- **DevHub V3 (Major Upgrade)**:
  - **Auto Bot Context**: AI automatically reads all bot files (config, cmds list, events list, package.json, Goat.js) — no manual file selection needed
  - **Unified Chat with 4 tabs**: الوكلاء الثلاثة | Claude AI | سريع | مرشد المبتدئين
  - **Quick Actions panel**: Pre-built prompts for common tasks (add cmd, fix error, explain code, new event, list cmds, admin mgmt, protect bot)
  - **File Tree Browser**: Visual file tree of all bot files with search, click-to-open, click-to-edit
  - **In-browser File Editor**: Full inline editor — click file, edit, save directly; send to AI for analysis
  - **Improved ZIP upload**: adm-zip properly extracts ZIP files with directory preview; drag-and-drop support
  - **Auto-analyze uploaded files**: Option to analyze any uploaded file with Claude AI
  - **Bot Stats Bar**: Shows live cmd count, events count, prefix, version at top of DevHub
  - **Guide Page (/devhub/guide)**: Beginner-friendly help page with visual cards
  - **Keyboard shortcut**: Ctrl+Enter to send in any chat tab
  - **Apply from Chat**: 💾 button saves last code block from AI directly to a file
- **GitHub Push**: DevHub push-all uses pure Node.js recursive copy → git init → force push
- **Hot-Reload Config**: Saving admin/settings via panel immediately syncs `global.GoatBot.config` — no restart needed
- **Hot-Reload Cookies**: Saving AppState calls `global.GoatBot.reLoginBot()` if available (hot reconnect), else graceful process exit so watchdog restarts automatically
- **restartBot()**: Defined in server.js — prefers `reLoginBot()` hot-reload, falls back to `process.exit(0)` for watchdog restart
- **Claude AI**: 4th AI agent — dedicated chat tab + pipeline support via Pollinations free API (no key needed)
- **GitHub Token**: Saved to `webpanel/devhub-config.json` (base64 encoded) for castrolmocro/New-white-e2ee-v2
- **adm-zip**: Installed for proper ZIP extraction
- **moment-timezone**: Installed and verified working

## External Integrations
- **Google Services**: Deep integration with Google Drive API and Gmail for notifications
- **reCAPTCHA**: Google reCAPTCHA integration for security
- **Social Media**: Support for various social media content fetching
- **Uptime Monitoring**: Built-in uptime monitoring with external service integration

## Configuration Management
- **Environment-Aware**: Separate configurations for development and production
- **Hot Reloading**: Dynamic configuration updates without restart
- **Command Configuration**: Granular per-command configuration system
- **Global Settings**: Centralized global configuration management

## Error Handling & Logging
- **Comprehensive Logging**: Multi-level logging system with timestamps and color coding
- **Error Recovery**: Automatic restart mechanisms and error recovery
- **Notification System**: Email and Telegram notifications for critical errors
- **Debug Support**: Built-in debugging and development tools

# External Dependencies

## Core Dependencies
- **Node.js Runtime**: Requires Node.js 16.x+ for execution
- **Facebook Chat API**: Custom unofficial Facebook API (`fb-chat-api`) for Messenger integration
- **Express.js**: Web server framework for dashboard functionality

## Database Systems
- **MongoDB**: Optional NoSQL database with Mongoose ODM
- **SQLite**: Local database option using Sequelize ORM
- **JSON Files**: Simple file-based storage option

## Google Services
- **Google Drive API**: File storage and management through Google Drive
- **Gmail API**: Email notifications and verification codes
- **Google reCAPTCHA**: Bot protection and user verification

## Authentication & Security
- **Passport.js**: Authentication middleware for dashboard
- **bcrypt**: Password hashing and validation
- **express-session**: Session management for web interface

## Communication & Notifications
- **Nodemailer**: Email sending capabilities
- **Socket.io**: Real-time web communication
- **MQTT**: Message queuing for Facebook API communication

## Utility Services
- **Axios**: HTTP client for API requests
- **Cheerio**: HTML parsing and web scraping
- **Moment.js**: Date and time manipulation
- **Canvas**: Image processing and generation

## Development & Monitoring
- **Socket.io**: Real-time monitoring capabilities
- **Express Rate Limiting**: API rate limiting and protection
- **File Upload**: Multi-part file upload handling
- **CORS**: Cross-origin resource sharing support

## Media Processing
- **ytdl-core**: YouTube video downloading
- **Canvas**: Image manipulation and generation
- **Mime-DB**: File type detection and handling

## External Monitoring
- **Uptime Services**: Integration with UptimeRobot or Better Stack for monitoring
- **Replit/Glitch**: Cloud hosting platform compatibility
- **Telegram Bot API**: Alternative notification channel