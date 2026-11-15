import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';

const A = 'UC' + 'a'.repeat(22), B = 'UC' + 'b'.repeat(22);
const pack = data => gzipSync(JSON.stringify(data)).toString('base64');
const fixture = {version: 1, channels: [[A, 'Community A', 1], [B, 'Community B', 6]]};
globalThis.window = {location: {hash: '#/search?q=test'}, localStorage: {
  'tizentube.communityBlocklist.v1': pack(fixture)
}};
globalThis.CustomEvent = class {
  constructor(type, options) { this.type = type; this.detail = options?.detail; }
};
const {decodeCommunitySnapshot, createCommunityIndex, communityIndex, communitySummary} = await import('../utils/communityBlocklist.js');
const {configWrite, configRead} = await import('../config.js');
const {blockChannel, removeBlocked} = await import('../utils/blocklist.js');
const {filterBlockedResponse} = await import('../utils/filterBlockedResponse.js');
const video = (id, name, channelId) => ({lockupViewModel: {
  contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
  metadata: {lockupMetadataViewModel: {metadata: {contentMetadataViewModel: {
    metadataRows: [{metadataParts: [{text: {content: name, commandRuns: channelId ? [
      {onTap: {innertubeCommand: {browseEndpoint: {browseId: channelId}}}}
    ] : []}}]}]
  }}}}
}});

beforeEach(() => {
  configWrite('blockedChannels', []);
  configWrite('blockedChannelNames', {});
  configWrite('hiddenVideos', []);
  configWrite('enabledCommunitySources', ['aislist', 'sloptube', 'minimaltube']);
  configWrite('communityAllowedChannels', []);
});

test('compressed snapshot validates records and keeps source membership', () => {
  const data = decodeCommunitySnapshot(pack(fixture));
  assert.deepEqual(data.counts, {aislist: 1, sloptube: 1, minimaltube: 1, religion: 0});
  assert.equal(communitySummary().count, 2);
});

test('empty/corrupt/oversized/invalid snapshots cannot silently become broad filters', () => {
  assert.equal(decodeCommunitySnapshot('').channels.length, 0);
  assert.throws(() => decodeCommunitySnapshot('garbage'));
  assert.throws(() => decodeCommunitySnapshot('A'.repeat(2350001)));
  assert.throws(() => decodeCommunitySnapshot(pack({version: 2, channels: []})));
  assert.throws(() => decodeCommunitySnapshot(pack({version: 1, channels: [['not-an-id', 'Name', 1]]})));
  assert.throws(() => decodeCommunitySnapshot(pack({version: 1, channels: [[A, 'Name', 16]]})));
  assert.throws(() => decodeCommunitySnapshot(pack({version: 1, channels: [[A, 'Name', 1], [A, 'Name', 1]]})));
  const zipBombTrailer = gzipSync('{}');
  zipBombTrailer.writeUInt32LE(9000000, zipBombTrailer.length - 4);
  assert.throws(() => decodeCommunitySnapshot(zipBombTrailer.toString('base64')));
});

test('source toggles isolate lists and preserve multiply-listed channels', () => {
  const data = decodeCommunitySnapshot(pack(fixture));
  assert.deepEqual([...createCommunityIndex(data, ['aislist']).ids], [A]);
  assert.deepEqual([...createCommunityIndex(data, ['sloptube']).ids], [B]);
  assert.deepEqual([...createCommunityIndex(data, ['minimaltube']).ids], [B]);
  assert.equal(createCommunityIndex(data, []).ids.size, 0);
});

test('curated religion source is independently selectable', () => {
  const data = decodeCommunitySnapshot(pack({version: 1, channels: [[A, 'Spiritual teacher', 8], [B, 'Other', 1]]}));
  assert.deepEqual([...createCommunityIndex(data, ['religion']).ids], [A]);
  assert.deepEqual([...createCommunityIndex(data, ['aislist']).ids], [B]);
});

test('indexes are cached across calls and rebuilt when toggles change', () => {
  const index = communityIndex();
  for (let i = 0; i < 1000; i++) assert.equal(communityIndex(), index);
  configWrite('enabledCommunitySources', []);
  assert.notEqual(communityIndex(), index);
  assert.equal(communityIndex().ids.size, 0);
});

test('in-place settings toggles invalidate community and personal indexes', () => {
  communityIndex();
  const sources = configRead('enabledCommunitySources');
  sources.splice(0, sources.length);
  configWrite('enabledCommunitySources', sources);
  assert.equal(communityIndex().ids.size, 0);
  const item = video('v', 'Personal A', A);
  blockChannel({id: A, name: 'Personal A'});
  assert.deepEqual(removeBlocked([item]), []);
  const personal = configRead('blockedChannels');
  personal.splice(0, personal.length);
  configWrite('blockedChannels', personal);
  assert.deepEqual(removeBlocked([item]), [item]);
});

test('community-only filters cover nested search with no personal blocks', () => {
  const good = video('good', 'Another');
  assert.deepEqual(filterBlockedResponse({groups: [{items: [video('bad', 'Community A'), good]}]}).groups[0].items, [good]);
});

test('channel IDs beat ambiguous display names; missing IDs fall back to names', () => {
  const otherId = 'UC' + 'c'.repeat(22);
  const differentOwner = video('different-owner', 'Community A', otherId);
  assert.deepEqual(removeBlocked([video('by-id', 'Renamed', A), video('by-name', 'community a'), differentOwner]), [differentOwner]);
});

test('community allowlist does not override explicit personal blocking', () => {
  configWrite('communityAllowedChannels', [A]);
  const item = video('v', 'Community A', A);
  assert.deepEqual(removeBlocked([item]), [item]);
  blockChannel({id: A, name: 'Community A'});
  assert.deepEqual(removeBlocked([item]), []);
});

test('disabled community sources do not disable personal blocks', () => {
  configWrite('enabledCommunitySources', []);
  const publicItem = video('v1', 'Community A', A);
  blockChannel({id: B, name: 'Personal B'});
  assert.deepEqual(removeBlocked([publicItem, video('v2', 'Personal B', B)]), [publicItem]);
});

test('60k-channel snapshot builds a reusable ID index without per-card scans', () => {
  const channels = Array.from({length: 60000}, (_, i) => ['UC' + i.toString(36).padStart(22, '0'), `Channel ${i}`, 1]);
  const decoded = decodeCommunitySnapshot(pack({version: 1, channels}));
  const index = createCommunityIndex(decoded, ['aislist']);
  assert.equal(index.ids.size, 60000);
  for (let i = 0; i < 10000; i++) assert.ok(index.ids.has(channels[i][0]));
});
