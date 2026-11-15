import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { location: { hash: '#/search?q=test' }, localStorage: {} };
globalThis.CustomEvent = class {};
const { configWrite } = await import('../config.js');
const { blockChannel, getChannelInfo } = await import('../utils/blocklist.js');
const { filterBlockedResponse } = await import('../utils/filterBlockedResponse.js');
const channelId = 'UCabcdefghijklmnopqrstuv';
const card = (id, name = 'Example', type = 'VIDEO') => ({ lockupViewModel: {
  contentId: id, contentType: `LOCKUP_CONTENT_TYPE_${type}`,
  metadata: { lockupMetadataViewModel: { title: {content: name}, metadata: {
    contentMetadataViewModel: {metadataRows: [{metadataParts: [{text: {content: name}}]}]}
  } } }
} });
const cluster = items => ({clusterRenderer: {items}});

beforeEach(() => {
  window.location.hash = '#/search?q=test';
  configWrite('blockedChannels', []);
  configWrite('blockedChannelNames', {});
  configWrite('hiddenVideos', []);
});

test('channel cards use the channel ID and title, not the handle', () => {
  const channel = card(channelId, 'Example', 'CHANNEL');
  channel.lockupViewModel.metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows[0].metadataParts[0].text.content = '@example';
  assert.deepEqual(getChannelInfo(channel), {id: channelId, name: 'Example'});
  blockChannel({id: channelId, name: 'Example'});
  assert.deepEqual(filterBlockedResponse({items: [channel]}).items, []);
});

test('nested cluster search results remove blocked videos but keep others', () => {
  blockChannel({id: channelId, name: 'Example'});
  const response = {contents: {sectionListRenderer: {contents: [{clusterShelfRenderer: {
    clusters: [cluster([card('bad'), card('good', 'Another')])]
  }}]}}};
  const out = filterBlockedResponse(response);
  assert.equal(out.contents.sectionListRenderer.contents[0].clusterShelfRenderer.clusters[0].clusterRenderer.items[0].lockupViewModel.contentId, 'good');
});

test('all-blocked groups and shelves are removed, unrelated groups remain', () => {
  blockChannel({id: channelId, name: 'Example'});
  const out = filterBlockedResponse({contents: [
    {clusterShelfRenderer: {clusters: [cluster([card('bad')])]}},
    {shelfRenderer: {content: {horizontalListRenderer: {items: [card('bad')]}}}},
    {shelfRenderer: {content: {horizontalListRenderer: {items: [card('ok', 'Another')]}}}}
  ]});
  assert.equal(out.contents.length, 1);
});

test('continuation commands are filtered without dropping their next-page token', () => {
  blockChannel({id: channelId, name: 'Example'});
  const token = {continuationItemRenderer: {continuationEndpoint: {continuationCommand: {token: 'next'}}}};
  const out = filterBlockedResponse({onResponseReceivedActions: [{appendContinuationItemsAction: {
    continuationItems: [card('bad'), card('ok', 'Another'), token]
  }}]});
  assert.deepEqual(out.onResponseReceivedActions[0].appendContinuationItemsAction.continuationItems, [card('ok', 'Another'), token]);
});

test('Shorts use menu subtitle when the metadata omits channel text', () => {
  blockChannel({id: channelId, name: 'Example'});
  const short = card('short', 'Video title', 'SHORT');
  short.lockupViewModel.metadata.lockupMetadataViewModel.metadata = {};
  short.lockupViewModel.rendererContext = {commandContext: {onLongPress: {innertubeCommand: {
    showMenuCommand: {subtitle: {simpleText: 'Example'}}
  }}}};
  assert.deepEqual(filterBlockedResponse({items: [short]}).items, []);
});

test('explicit history/library pages remain exempt', () => {
  blockChannel({id: channelId, name: 'Example'});
  window.location.hash = '#/browse?c=FEhistory';
  const response = {items: [card('bad')]};
  assert.deepEqual(filterBlockedResponse(response).items, [card('bad')]);
});

test('unrelated playlists/navigation and no-block responses are unchanged', () => {
  const response = {items: [card('playlist', 'Example', 'PLAYLIST'), {buttonRenderer: {text: 'Next'}}]};
  assert.equal(filterBlockedResponse(response), response);
  blockChannel({id: channelId, name: 'Example'});
  assert.deepEqual(filterBlockedResponse(response), response);
});
