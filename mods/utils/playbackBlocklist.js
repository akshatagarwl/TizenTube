import { configRead, configChangeEmitter } from '../config.js';
import { communityIndex } from './communityBlocklist.js';

const CHANNEL_ID = /^UC[\w-]{22}$/;
const MAX_VIDEOS = 256;
const nativeParse = JSON.parse;
let personalIds;
configChangeEmitter.addEventListener('configChange', ({ detail }) => {
  if (detail.key === 'blockedChannels') personalIds = null;
});

export function isPlaybackChannelBlocked(channelId) {
  if (!CHANNEL_ID.test(channelId)) return false;
  if (!personalIds) personalIds = new Set(configRead('blockedChannels'));
  return personalIds.has(`id:${channelId}`) || communityIndex().ids.has(channelId);
}

function nextOwner(response) {
  const results = response.contents?.singleColumnWatchNextResults
    ?? response.contents?.twoColumnWatchNextResults;
  const contents = results?.results?.results?.contents ?? [];
  const primary = [];
  for (const item of contents) primary.push(...(item.itemSectionRenderer?.contents ?? [item]));
  for (const item of primary) {
    const metadata = item.videoMetadataRenderer ?? item.videoSecondaryInfoRenderer;
    const owner = metadata?.owner?.videoOwnerRenderer;
    const channelId = owner?.navigationEndpoint?.browseEndpoint?.browseId;
    if (CHANNEL_ID.test(channelId)) return channelId;
  }
  return null;
}

function denyPlayer(player) {
  delete player.streamingData;
  delete player.playerAds;
  delete player.adPlacements;
  delete player.adSlots;
  player.playabilityStatus = { status: 'UNPLAYABLE', reason: 'Blocked channel' };
}

export function createPlaybackGate({ isBlocked = isPlaybackChannelBlocked,
  logUnknown = detail => console.warn('TizenTube: unknown playback channel', detail) } = {}) {
  const videos = new Map();
  const listeners = new Set();
  const unknown = new Set();

  function record(videoId, channelId, authoritative) {
    if (!videoId || !CHANNEL_ID.test(channelId)) return;
    const previous = videos.get(videoId);
    if (!authoritative && previous?.authoritative) return;
    if (previous?.channelId === channelId && previous.authoritative === authoritative) return;
    videos.delete(videoId);
    videos.set(videoId, { channelId, authoritative });
    if (videos.size > MAX_VIDEOS) videos.delete(videos.keys().next().value);
    for (const listener of listeners) listener(videoId);
  }

  function decision(videoId, source = 'media') {
    const channelId = videos.get(videoId)?.channelId;
    if (channelId) return { videoId, channelId, blocked: isBlocked(channelId) };
    const key = videoId || '(missing video ID)';
    if (!unknown.has(key)) {
      if (unknown.size >= MAX_VIDEOS) unknown.clear();
      unknown.add(key);
      logUnknown({ videoId: videoId || null, source });
    }
    return { videoId, channelId: null, blocked: false };
  }

  function visit(response, depth = 0) {
    if (!response || typeof response !== 'object' || depth > 8) return response;
    if (Array.isArray(response)) {
      response.forEach(item => visit(item, depth + 1));
      return response;
    }
    const details = response.videoDetails;
    if (details) record(details.videoId, details.channelId, true);
    const nextVideoId = response.currentVideoEndpoint?.watchEndpoint?.videoId;
    if (nextVideoId) record(nextVideoId, nextOwner(response), false);

    // Only descend into playback envelopes, never recommendation/channel cards.
    const envelopes = ['playerResponse', 'player_response', 'playerResponses', 'player', 'args',
      'response', 'entries', 'command', 'reelWatchEndpoint'];
    for (const key of envelopes) {
      const nested = response[key];
      if (typeof nested === 'string') {
        try {
          const player = nativeParse(nested);
          visit(player, depth + 1);
          response[key] = JSON.stringify(player);
        } catch (error) {
          console.warn('TizenTube: invalid embedded player response', error.message);
        }
      } else {
        visit(nested, depth + 1);
      }
    }
    if (details || response.streamingData || response.playabilityStatus) {
      const videoId = details?.videoId ?? nextVideoId;
      const channelId = details?.channelId;
      const blocked = CHANNEL_ID.test(channelId)
        ? isBlocked(channelId) : decision(videoId, 'player').blocked;
      if (blocked) denyPlayer(response);
    }
    return response;
  }

  return {
    observe: visit,
    decision,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const playbackGate = createPlaybackGate();
