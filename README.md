<div align="center">

# 🎵 YouTube Music Remover

<div align="center">

![Visitors](https://api.visitorbadge.io/api/visitors?path=https%3A%2F%2Fgithub.com%2Fislamic-toolkit%2Fyoutube-music-remover&label=VISITORS&countColor=%23263759)

</div>

### A Chrome & Comet Browser Extension that strips background music from YouTube videos in real-time, leaving only vocals and speech.

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](https://github.com/islamic-toolkit/youtube-music-remover)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853?style=for-the-badge&logo=google&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](LICENSE)
[![Version](https://img.shields.io/badge/Version-2.1.0-blue?style=for-the-badge)]()

<br/>

<img src="icons/icon128.png" alt="YouTube Music Remover Logo" width="128" height="128"/>

**AI-powered vocal isolation for YouTube • Streaming playback • English & Arabic**

[Installation](#-installation) · [How It Works](#-how-it-works) · [Features](#-features) · [Contributing](#-contributing)

</div>

---

<div align="center">

<img src="icons/home.png" alt="YouTube Music Remover Screenshot" width="400"/>

</div>

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🎤 **AI Vocal Isolation** | Separates vocals from background music using AI stem separation |
| ⚡ **Streaming Playback** | Audio starts playing instantly — no waiting for full downloads |
| 🔁 **Auto-Start Mode** | Automatically removes music when you open any YouTube video |
| 🌐 **Bilingual UI** | Full English and Arabic support with RTL layout |
| 💾 **Smart Caching** | Previously processed videos load instantly from cache |
| 🎛️ **One-Click Toggle** | Floating button on the YouTube player to toggle vocals on/off |
| 🔇 **Seamless Sync** | Vocals stay perfectly synced with video playback |
| 🧩 **Manifest V3** | Built on the latest Chrome Extension architecture |

## 🎬 How It Works

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐     ┌──────────────┐
│  YouTube     │────▶│  Import URL   │────▶│  AI Stem Split  │────▶│  Stream      │
│  Video Page  │     │  to API       │     │  (Vocals Only)  │     │  Vocals Back │
└─────────────┘     └──────────────┘     └─────────────────┘     └──────────────┘
```

1. **Navigate** to any YouTube video
2. **Click** the 🎵 button on the player (or enable Auto-Start)
3. **AI separates** the vocal track from the music
4. **Audio streams** in and starts playing immediately — original video audio is muted

The extension uses [SoundBoost AI](https://soundboost.ai) for real-time audio stem separation.

## 📦 Installation

### From Source (Developer Mode)

1. **Clone** this repository:
   ```bash
   git clone https://github.com/islamic-toolkit/youtube-music-remover.git
   cd youtube-music-remover
   ```

2. Open **Chrome** or **Comet Browser** and navigate to `chrome://extensions/`

3. Enable **Developer Mode** (toggle in the top-right corner)

4. Click **"Load unpacked"** and select the project folder

5. Navigate to any YouTube video and click the 🎵 button!

### From Release

1. Download the latest `.zip` from [Releases](https://github.com/islamic-toolkit/youtube-music-remover/releases)
2. Extract the archive
3. Follow steps 2–5 above

## 🏗️ Project Structure

```
youtube-music-remover/
├── manifest.json       # Extension manifest (V3)
├── background.js       # Service worker — API calls, caching, stem separation
├── content.js          # YouTube page injection — UI, audio sync, playback
├── i18n.js             # Internationalization (English + Arabic translations)
├── popup.html          # Extension popup UI
├── popup.js            # Popup logic — settings, language, auto-start
├── offscreen.html      # Offscreen document for audio CORS proxy
├── styles.css          # Floating player UI styles
└── icons/
    ├── icon16.png      # Toolbar icon
    ├── icon48.png      # Extension management icon
    └── icon128.png     # Chrome Web Store icon
```

## ⚙️ Configuration

Click the extension icon in your toolbar to access settings:

| Setting | Description | Default |
|---------|-------------|---------|
| **Enable Extension** | Master on/off switch | ✅ On |
| **Auto-Start** | Automatically process videos on page load | ❌ Off |
| **Language** | Switch between English and العربية | English |

## 🔧 Technical Details

### Architecture

- **Manifest V3** — Modern service worker-based architecture
- **Offscreen Document** — Used for audio proxying to bypass CORS restrictions
- **Chrome Storage API** — Persists settings and vocals URL cache
- **Streaming First** — Vocals URL is streamed directly to an `<audio>` element instead of downloading + base64 encoding (eliminates the biggest performance bottleneck)

### API Flow

```
YouTube URL → Import → Poll Status → Start Separation → Poll Stems → Stream Vocals URL
```

### Caching Strategy

- Processed vocals URLs are cached in `chrome.storage.local`
- Cache entries include timestamps for expiration
- Maximum cache size is enforced (oldest entries evicted via LRU)
- Cache hits skip the entire API pipeline — instant playback

### Permissions

| Permission | Reason |
|------------|--------|
| `activeTab` | Access the current YouTube tab |
| `storage` | Save settings and cached vocal URLs |
| `offscreen` | Audio proxy document for CORS bypass |
| `host_permissions` | YouTube domains + SoundBoost API + R2 storage |

## 🌍 Internationalization

The extension ships with full **English** and **Arabic** support:

- All UI strings are externalized in `i18n.js`
- Arabic interface uses proper **RTL layout**
- Language preference persists across sessions
- Status messages during processing are also translated

### Adding a New Language

1. Open `i18n.js`
2. Add a new language key with all translation strings:
   ```javascript
   fr: {
     extName: "Islamic Toolkit - Suppresseur de Musique",
     // ... add all keys
   }
   ```
3. Add the option in `popup.html`'s language selector
4. Submit a PR!

## 🤝 Contributing

Contributions are welcome! Here's how you can help:

1. **Fork** the repository
2. **Create** a feature branch: `git checkout -b feature/amazing-feature`
3. **Commit** your changes: `git commit -m 'Add amazing feature'`
4. **Push** to the branch: `git push origin feature/amazing-feature`
5. **Open** a Pull Request

### Ideas for Contributions

- 🌐 Add more languages (French, Turkish, Urdu, etc.)
- 🎨 Dark/light theme for the popup
- 📊 Usage statistics dashboard
- 🔊 Volume mixer (vocals vs. original audio blend)
- 📱 Firefox / Edge port

## 📋 Changelog

### v2.1.0 (Latest)
- ⚡ **Streaming playback** — audio starts playing within seconds
- 🔁 **Auto-Start mode** — configurable automatic music removal
- 💾 **URL caching** — instant replay for previously processed videos
- 🌐 **Arabic language** support with RTL layout
- 🏗️ Offscreen document for CORS-free audio proxying
- 🛡️ Abort controller for clean request cancellation

### v1.0.0
- Initial release with basic vocal isolation

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [SoundBoost AI](https://soundboost.ai) — AI-powered audio stem separation API
- [Islamic Toolkit](https://github.com/islamic-toolkit) — Developer team

---

<div align="center">

**Made with ❤️ by [Islamic Toolkit](https://github.com/islamic-toolkit)**

If this project helps you, please consider giving it a ⭐

</div>
