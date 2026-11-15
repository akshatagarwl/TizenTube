import { configRead, configWrite, configChangeEmitter } from '../config.js';
import { communityIndex } from './communityBlocklist.js';

const MAX_HIDDEN_VIDEOS = 1000;

function textOf(text) {
  if (!text) return '';
  if (typeof text === 'string') return text;
  if (text.simpleText) return String(text.simpleText);
  if (text.content) return String(text.content);
  if (Array.isArray(text.runs)) return text.runs.map((run) => run?.text ?? '').join('');
  return '';
}

function findChannelId(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 14) return null;
  const browseId = obj.browseEndpoint?.browseId;
  if (typeof browseId === 'string' && browseId.startsWith('UC')) return browseId;
  for (const value of Object.values(obj)) {
    const id = findChannelId(value, depth + 1);
    if (id) return id;
  }
  return null;
}

export function getVideoId(item) {
  return item?.tileRenderer?.contentId ?? item?.lockupViewModel?.contentId ?? null;
}

// The first metadata line of a video tile is the channel name.
export function getChannelInfo(item) {
  if (item?.lockupViewModel?.contentType === 'LOCKUP_CONTENT_TYPE_CHANNEL') {
    return { id: item.lockupViewModel.contentId, name: textOf(item.lockupViewModel.metadata?.lockupMetadataViewModel?.title).trim() };
  }
  if (/^UC[\w-]{22}$/.test(item?.tileRenderer?.contentId ?? '')) {
    return { id: item.tileRenderer.contentId, name: textOf(item.tileRenderer.header?.tileHeaderRenderer?.title).trim() };
  }
  const nameNode = item?.tileRenderer
    ? item.tileRenderer.metadata?.tileMetadataRenderer?.lines?.[0]?.lineRenderer?.items?.[0]?.lineItemRenderer?.text
    : item?.lockupViewModel?.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text;
  const menuSubtitle = item?.lockupViewModel?.rendererContext?.commandContext?.onLongPress?.innertubeCommand?.showMenuCommand?.subtitle;
  const name = (textOf(nameNode) || textOf(menuSubtitle)).trim();
  // Prefer the id attached to the channel name itself over any other id in the tile.
  const id = findChannelId(nameNode) ?? findChannelId(item);
  if (!name && !id) return null;
  return { id, name };
}

const idKey = (id) => `id:${id}`;
const nameKey = (name) => `name:${name.toLowerCase()}`;

export function blockChannel(channel) {
  const key = channel.id ? idKey(channel.id) : nameKey(channel.name);
  const blocked = configRead('blockedChannels');
  if (!blocked.includes(key)) configWrite('blockedChannels', [...blocked, key]);
  configWrite('blockedChannelNames', { ...configRead('blockedChannelNames'), [key]: channel.name || channel.id });
}

export function hideVideoLocally(videoId) {
  const hidden = configRead('hiddenVideos');
  if (!videoId || hidden.includes(videoId)) return;
  configWrite('hiddenVideos', [...hidden, videoId].slice(-MAX_HIDDEN_VIDEOS));
}

function isVideoTile(item) {
  return item?.tileRenderer?.style === 'TILE_STYLE_YTLR_DEFAULT'
    || item?.lockupViewModel?.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO'
    || item?.lockupViewModel?.contentType === 'LOCKUP_CONTENT_TYPE_SHORT';
}

// Library, history and playlist pages show items the user chose on purpose.
const EXEMPT_PAGES = /FElibrary|FEhistory|FEplaylist|\/playlist|[?&]list=/i;

// Drops video tiles of blocked channels and hidden videos from a list of renderer items.
export function removeBlocked(items) {
  try {
    return filterBlocked(items);
  } catch (err) {
    console.error('TizenTube: failed to filter blocked items:', err);
    return items;
  }
}

let cachedKeys, cachedNames, cachedHidden, cachedPersonal;
configChangeEmitter.addEventListener('configChange', ({ detail }) => {
  if (['blockedChannels', 'blockedChannelNames', 'hiddenVideos'].includes(detail.key)) cachedPersonal = null;
});
function personalIndex() {
  const keys = configRead('blockedChannels');
  const names = configRead('blockedChannelNames');
  const hidden = configRead('hiddenVideos');
  if (!cachedPersonal || keys !== cachedKeys || names !== cachedNames || hidden !== cachedHidden) {
    cachedPersonal = {
      ids: new Set(keys.filter(key => key.startsWith('id:'))),
      nameOnly: new Set(keys.filter(key => key.startsWith('name:'))),
      idNames: new Set(keys.filter(key => key.startsWith('id:') && names[key]).map(key => nameKey(names[key]))),
      hidden: new Set(hidden)
    };
    cachedKeys = keys;
    cachedNames = names;
    cachedHidden = hidden;
  }
  return cachedPersonal;
}

export function hasChannelFilters() {
  return configRead('blockedChannels').length || configRead('hiddenVideos').length || communityIndex().ids.size;
}

function filterBlocked(items) {
  if (!Array.isArray(items)) return items;
  if (EXEMPT_PAGES.test(window.location?.hash ?? '')) return items;
  if (!hasChannelFilters()) return items;
  const { ids: blockedIds, nameOnly: blockedNameOnly, idNames: blockedIdNames, hidden } = personalIndex();
  const community = communityIndex();
  return items.filter((item) => {
    const isChannel = item?.lockupViewModel?.contentType === 'LOCKUP_CONTENT_TYPE_CHANNEL'
      || /^UC[\w-]{22}$/.test(item?.tileRenderer?.contentId ?? '');
    const isCollection = ['LOCKUP_CONTENT_TYPE_SHOW', 'LOCKUP_CONTENT_TYPE_PODCAST', 'LOCKUP_CONTENT_TYPE_PLAYLIST'].includes(item?.lockupViewModel?.contentType);
    if (!isVideoTile(item) && !isChannel && !isCollection) return true;
    if (isVideoTile(item) && hidden.has(getVideoId(item))) return false;
    const channel = getChannelInfo(item);
    if (!channel) return true;
    const nameBlocked = channel.name && (blockedNameOnly.has(nameKey(channel.name))
      || (!channel.id && blockedIdNames.has(nameKey(channel.name))));
    const communityBlocked = channel.id ? community.ids.has(channel.id)
      : channel.name && community.names.has(channel.name.toLowerCase());
    return !(channel.id && blockedIds.has(idKey(channel.id))) && !nameBlocked && !communityBlocked;
  });
}
