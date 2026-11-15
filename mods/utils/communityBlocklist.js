import { gunzipSync, strFromU8 } from 'fflate';
import { configRead, configChangeEmitter } from '../config.js';

export const COMMUNITY_KEY = 'tizentube.communityBlocklist.v1';
const nativeParse = JSON.parse;
const ID = /^UC[\w-]{22}$/;
const MAX_PACKED_CHARS = 2350000;
const MAX_JSON_BYTES = 8000000;
const BITS = { aislist: 1, sloptube: 2, minimaltube: 4, religion: 8 };
const emptySnapshot = () => ({ channels: [], counts: {} });

export function decodeCommunitySnapshot(packed) {
  if (!packed) return emptySnapshot();
  if (packed.length > MAX_PACKED_CHARS) throw new Error('Community snapshot exceeds storage budget');
  const binary = atob(packed);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (bytes.length < 18 || bytes[0] !== 31 || bytes[1] !== 139 || bytes[2] !== 8) throw new Error('Not a gzip snapshot');
  const size = new DataView(bytes.buffer).getUint32(bytes.length - 4, true);
  if (size > MAX_JSON_BYTES) throw new Error('Community snapshot expands beyond budget');
  // A fixed buffer bounds decompression allocation even for a malformed trailer.
  const decoded = gunzipSync(bytes, { out: new Uint8Array(size) });
  const data = nativeParse(strFromU8(decoded));
  if (data.version !== 1 || !Array.isArray(data.channels) || data.channels.length > 100000) throw new Error('Unsupported snapshot');
  const ids = new Set();
  const counts = { aislist: 0, sloptube: 0, minimaltube: 0, religion: 0 };
  for (const row of data.channels) {
    if (!Array.isArray(row) || row.length !== 3 || !ID.test(row[0]) || typeof row[1] !== 'string'
        || row[1].length > 512 || !Number.isInteger(row[2]) || row[2] < 1 || row[2] > 15 || ids.has(row[0])) throw new Error('Invalid channel record');
    ids.add(row[0]);
    for (const [source, bit] of Object.entries(BITS)) if (row[2] & bit) counts[source]++;
  }
  return { channels: data.channels, counts };
}

export function createCommunityIndex(snapshot, sources, allowed = []) {
  const mask = sources.reduce((value, source) => value | (BITS[source] || 0), 0);
  const exceptions = new Set(allowed);
  const ids = new Set();
  const names = new Set();
  for (const [id, name, membership] of snapshot.channels) {
    if (!(membership & mask) || exceptions.has(id) || exceptions.has('id:' + id)) continue;
    ids.add(id);
    if (name) names.add(name.toLowerCase());
  }
  return { ids, names };
}

// Load once per app start, before JSON.parse interception. No subscription fetches
// from the TV and no 60k-entry scans on every shelf or video.
let snapshot = emptySnapshot();
try {
  snapshot = decodeCommunitySnapshot(window.localStorage[COMMUNITY_KEY]);
} catch (_) {
  console.warn('TizenTube: community blocklist unavailable; personal blocks remain active');
}
let cachedSources;
let cachedAllowed;
let cachedIndex;
configChangeEmitter.addEventListener('configChange', ({ detail }) => {
  if (['enabledCommunitySources', 'communityAllowedChannels'].includes(detail.key)) cachedIndex = null;
});
export function communityIndex() {
  const sources = configRead('enabledCommunitySources');
  const allowed = configRead('communityAllowedChannels');
  if (!cachedIndex || sources !== cachedSources || allowed !== cachedAllowed) {
    cachedIndex = createCommunityIndex(snapshot, sources, allowed);
    cachedSources = sources;
    cachedAllowed = allowed;
  }
  return cachedIndex;
}
export function communitySummary() {
  return { count: snapshot.channels.length, counts: snapshot.counts };
}
