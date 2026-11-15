# Channel filters in this fork

Source branch: [`feat/pr720-channel-block`](https://github.com/akshatagarwl/TizenTube/tree/feat/pr720-channel-block). This extends the work from upstream [PR #720](https://github.com/reisxd/TizenTube/pull/720), retaining the original project's license and attribution. It is not a new official upstream release.

## Features

- Separate personal blocks and compressed community snapshots.
- Cached channel-ID/name indexes and independent source switches; no scanning huge lists for each card.
- Filtering of channel cards, clustered search/continuations, Shorts with menu subtitles, shows/podcasts/owned playlists and empty shelves.
- Explicit history/library/playlist exemptions retained. This is preference filtering, not playback access control. Autocomplete is not blocked.
- No imported JavaScript, title regexes, blanket religious/political keywords, AiSList warnlist or automatic list updates.

## Public data and companions

- [TV Channel Lists](https://github.com/akshatagarwl/tv-channel-lists): MIT builder plus independently curated CC0 channel facts. The current public curation contains 49 channels. Local exceptions remain private preferences. This is **not an authoritative accuracy/bias rating** and is not exhaustive.
- AiSList data retains CC BY-NC 4.0. SlopTube/MinimalTube redistribution licensing is unconfirmed. Fetched inputs, combined snapshots, personal SmartTube exports and account profiles are **not distributed in this fork**.
- [Android/iPhone setup preview](https://github.com/akshatagarwl/tv-setup): explicit consent and pinned APK verification. Channel-list import remains unimplemented in the installer.
- [Google voice-search handoff](https://github.com/akshatagarwl/tv-search-handoff): retains Google recognition and does not filter remote keys.
- [TV launcher shortcut](https://github.com/akshatagarwl/tv-youtube-shortcut): no permissions; original generic public artwork.

## Build/test

```sh
cd mods
npm ci
npm test
npm run build
```

This branch's filter tests cover source indexes, mutation-driven invalidation, channel/owner renderers, continuation/grouped responses, valid compressed snapshots and rejection of malformed/oversized input. Existing dependency advisories require a separate review before production distribution.

## Local data contract

`localStorage['tizentube.communityBlocklist.v1']` stores the builder's gzip/base64 payload. The decoded schema is `{version: 1, sources, channels: [[channelId, displayName, membershipMask], ...]}`. Bits: AiSList `1`, SlopTube `2`, MinimalTube `4`, curated religion/spirituality `8`. Decompression is bounded; lookups are cached and invalidated on configuration changes. Personal blocks win over community exceptions.

Settings → TizenTube Settings → User Interface Settings → Community lists exposes independent toggles/counts. Refresh results after changing a source.

The builder applies local exact-ID community exceptions before packaging; the TV cannot infer a new preference from a GitHub update. **No automatic remote list pull exists.** Updating a previously installed snapshot requires a separately authorized, backed-up import.

Do not edit live LevelDB, clear app data or replace an entire profile. Wait for permission to interrupt playback, back up fresh storage, preserve personal settings, stop the app before any offline import, respect its localStorage quota and verify both allowed/blocked results plus actual playback afterwards. Never publish storage backups, account sessions, QR tokens, signing keystores or personal lists.
