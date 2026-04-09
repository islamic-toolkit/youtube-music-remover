# YouTube Music Remover

YouTube Music Remover is a Manifest V3 browser extension for YouTube that separates vocals and speech from background music.

The current codebase supports two provider pipelines:

- `direct_link`: the provider receives the YouTube link and processes it remotely
- `upload_audio`: the extension downloads the audio, splits it into chunks, uploads the chunks, and streams cleaned results progressively

Current providers:

- `SoundBoost` -> `direct_link`
- `Remove Music` -> `upload_audio`

The extension includes English and Arabic support, an in-player action button, auto-start, cached results, and playback controls that let the user decide whether to keep the original video audio playing while upload-based processing runs.

## Current Version

The repository currently matches extension version `4.3.0` from [manifest.json](./manifest.json).

## Features

- In-player YouTube control for starting or stopping the music-removal flow
- Two explicit provider pipelines for current and future integrations
- Chunked upload pipeline for providers that need local audio uploads
- Direct-link pipeline for providers that process from the YouTube URL
- Progressive playback for chunked results when ready
- Auto-start on page load
- Ask-before-starting playback behavior
- English and Arabic UI with RTL support
- Cached cleaned-audio result URLs for faster reuse

## Provider Behavior

### Direct-link providers

Direct-link providers process the video from its original YouTube URL.

- `Chunk Duration` is disabled
- A warning is shown in the popup because very long videos may take longer
- The playback-behavior preference is still available

### Upload-audio providers

Upload-audio providers require the extension to download and split audio locally before sending it to the provider.

- `Chunk Duration` is enabled
- Playback can begin progressively as chunks become ready
- The same playback-behavior preference remains available

## How It Works

### Direct-link flow

1. Open a YouTube watch page
2. Click the extension button in the player, or enable auto-start
3. The provider imports the YouTube URL remotely
4. The extension polls provider status
5. The cleaned vocals URL is streamed back into the player

### Upload-audio flow

1. Open a YouTube watch page
2. Click the extension button in the player, or enable auto-start
3. The extension downloads the audio source
4. Audio is split into chunks according to `Chunk Duration`
5. Chunks are uploaded and processed in parallel
6. Cleaned chunks are streamed back progressively and synced to the video

## Installation

### Load unpacked

1. Download or clone this repository
2. Open `chrome://extensions/`
3. Enable `Developer mode`
4. Click `Load unpacked`
5. Select the project folder

The extension is intended for Chromium-based browsers that support Manifest V3 and the required Chrome extension APIs.

## Settings

The popup currently exposes:

- `Extension Enabled`
- `Auto-Start on Page Load`
- `Language`
- `Provider`
- `Chunk Duration`
- `Ask Before Starting`

Important behavior:

- `Chunk Duration` is available only for upload-audio providers
- `Ask Before Starting` remains available for both provider types
- `Play Immediately` is chosen through the in-player prompt rather than the popup

## Project Structure

```text
youtube-music-remover/
|-- _locales/
|-- icons/
|-- background.js
|-- content-ui-helpers.js
|-- content.js
|-- i18n.js
|-- manifest.json
|-- offscreen.html
|-- popup.html
|-- popup.js
|-- provider-catalog.js
`-- styles.css
```

Key files:

- `provider-catalog.js`: shared provider definitions and capability metadata
- `background.js`: provider orchestration, caching, download/upload handling, and job lifecycle
- `content.js`: player UI, prompt behavior, playback sync, and streaming
- `popup.js`: settings UI and provider-aware controls
- `i18n.js`: runtime translations shared across popup, content, and background
- `_locales/`: Chrome extension locale resources

## Localization

The extension currently supports:

- English
- Arabic

Localization is split into two layers:

- Chrome locale metadata in `_locales/`
- shared runtime strings in `i18n.js`

If you add new user-facing text, update both places when needed so popup text, in-player text, and extension metadata stay aligned.

## Development Notes

- The codebase is organized around provider capabilities rather than one-off provider branches
- New providers should be added through `provider-catalog.js` first
- Direct-link and upload-audio providers should keep using the explicit pipeline split already in the background worker
- Manual verification on real YouTube pages is important for UI placement, provider flow, and playback timing

## Contributing

Contribution guidance lives in [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
