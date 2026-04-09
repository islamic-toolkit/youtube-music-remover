# Contributing to YouTube Music Remover

Thanks for contributing.

## Before You Start

This extension is a browser-based YouTube integration, so most meaningful changes should be verified on real YouTube watch pages after loading the extension unpacked.

The current architecture is centered around:

- shared provider metadata in `provider-catalog.js`
- two explicit processing pipelines in `background.js`
- in-player UI and playback logic in `content.js`
- popup settings and provider-aware controls in `popup.js`

## Local Setup

1. Fork the repository
2. Clone your fork
3. Open `chrome://extensions/`
4. Enable `Developer mode`
5. Click `Load unpacked`
6. Select the repository folder

## What To Keep In Sync

When you change user-facing behavior, please update the related docs and strings too.

Examples:

- provider capabilities -> `provider-catalog.js`, popup behavior, and README
- playback behavior -> `content.js`, popup wording, and README
- localization -> `i18n.js` and `_locales/`
- extension metadata -> `manifest.json` and README when relevant

## Provider Changes

Any provider update should start with the provider catalog.

For a new provider, define:

- `id`
- `labelKey`
- `pipelineType`
- `supportsChunkDuration`
- `supportsPlaybackPrompt`
- `selectionWarningKey`

Then wire the implementation into the correct background pipeline:

- `direct_link` providers use `start(job, signal)` and `poll(job, signal)`
- `upload_audio` providers use `prepareChunk(chunk, job, signal)` and `pollChunk(chunk, job, signal)`

Avoid adding new hardcoded provider checks in the popup or content script when the same behavior can be read from the catalog.

## Manual Verification Checklist

Before opening a pull request, manually verify the flows affected by your change.

Suggested checks:

- extension loads correctly as unpacked
- player button appears on YouTube watch pages
- popup settings save and restore correctly
- English and Arabic both render correctly
- direct-link providers disable only `Chunk Duration`
- upload-audio providers still support chunked processing and progressive playback
- cached results still reuse correctly
- auto-start behaves as expected

## Documentation

Please update these files when behavior changes:

- `README.md`
- `CONTRIBUTING.md`
- `LICENSE` if copyright years need adjustment

## Pull Requests

When opening a PR:

- explain the user-facing change clearly
- mention affected providers or pipelines
- include screenshots for popup or in-player UI changes
- note any manual test scenarios you ran

## Bug Reports

Helpful bug reports include:

- browser name and version
- extension version
- selected provider
- whether auto-start was enabled
- the YouTube URL category involved
  examples: lecture, podcast, music video, short clip
- console errors from the extension or page if available

## Style Notes

- keep changes aligned with the existing architecture
- prefer capability-driven behavior over provider-specific branching
- keep strings localizable
- preserve both English and Arabic support
