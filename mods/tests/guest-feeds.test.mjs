import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Signed-out TVHTML5 FEtopics_news response shape, anonymized and reduced to card fields.
// No cookies, visitor IDs, tracking parameters or private list are included.
const tiles = JSON.parse(readFileSync(new URL('./fixtures/guest-news-tiles.json', import.meta.url)));
globalThis.window = {location: {hash: '#/browse?c=FEtopics_news'}, localStorage: {}};
const {configWrite} = await import('../config.js');
const {getChannelInfo, blockChannel} = await import('../utils/blocklist.js');
const {filterBlockedResponse} = await import('../utils/filterBlockedResponse.js');

beforeEach(() => {
  configWrite('blockedChannels', []);
  configWrite('blockedChannelNames', {});
  configWrite('hiddenVideos', []);
  configWrite('enabledCommunitySources', []);
});

function feed(cards) {
  return {contents: {tvBrowseRenderer: {content: {tvSurfaceContentRenderer: {content: {
    sectionListRenderer: {contents: [{shelfRenderer: {
      content: {horizontalListRenderer: {items: cards}}
    }}]}
  }}}}}};
}
function items(response) {
  return response.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content
    .sectionListRenderer.contents[0]?.shelfRenderer.content.horizontalListRenderer.items ?? [];
}

for (const route of ['FEtopics', 'FEtopics_news']) {
  test(`signed-out ${route} removes reviewed exact IDs without needing an account`, () => {
    window.location.hash = `#/browse?c=${route}`;
    const cards = structuredClone(tiles);
    const channel = getChannelInfo(cards[0]);
    assert.match(channel.id, /^UC[\w-]{22}$/);
    assert.ok(channel.name);
    // A list gap preserves the card; adding the ID fixes it without profile changes.
    assert.equal(items(filterBlockedResponse(feed(structuredClone(cards)))).length, 2);
    blockChannel(channel);
    const remaining = items(filterBlockedResponse(feed(cards)));
    assert.equal(remaining.length, 1);
    assert.notEqual(getChannelInfo(remaining[0]).id, channel.id);
  });
}

test('Home continuation removes blocked tiles and preserves continuation tokens', () => {
  window.location.hash = '#/browse?c=FEtopics';
  const cards = structuredClone(tiles);
  blockChannel(getChannelInfo(cards[0]));
  const token = {continuationItemRenderer: {continuationEndpoint: {continuationCommand: {token: 'next'}}}};
  const response = {onResponseReceivedActions: [{appendContinuationItemsAction: {
    continuationItems: [...cards, token]
  }}]};
  const remaining = filterBlockedResponse(response).onResponseReceivedActions[0]
    .appendContinuationItemsAction.continuationItems;
  assert.deepEqual(remaining, [cards[1], token]);
});

test('a completely blocked Guest news shelf disappears, not unrelated navigation', () => {
  window.location.hash = '#/browse?c=FEtopics_news';
  const cards = structuredClone(tiles);
  cards.forEach(card => blockChannel(getChannelInfo(card)));
  const response = feed(cards);
  response.navigation = {browseEndpoint: {browseId: 'FElibrary'}};
  const out = filterBlockedResponse(response);
  assert.equal(out.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content
    .sectionListRenderer.contents.length, 0);
  assert.equal(out.navigation.browseEndpoint.browseId, 'FElibrary');
});
