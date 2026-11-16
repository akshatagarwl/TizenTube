import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

const BLOCKED = 'UC' + 'b'.repeat(22);
const ALLOWED = 'UC' + 'a'.repeat(22);
const COMMUNITY = 'UC' + 'c'.repeat(22);
const VIDEO = 'testvideo01';
const LIVE_CHANNELS = ['UC' + 'l'.repeat(22), 'UC' + 'm'.repeat(22)];
const PERSONAL_CHANNELS = ['UC' + 'n'.repeat(22), 'UC' + 'o'.repeat(22), 'UC' + 'p'.repeat(22)];
globalThis.window = { location: { hash: '' }, localStorage: {
  'tizentube.communityBlocklist.v1': gzipSync(JSON.stringify({ version: 1,
    channels: [[COMMUNITY, 'Community', 15]] })).toString('base64'),
} };
globalThis.CustomEvent = class extends Event {
  constructor(type, options) { super(type); this.detail = options.detail; }
};
const { configWrite } = await import('../config.js');
const { createPlaybackGate, isPlaybackChannelBlocked } = await import('../utils/playbackBlocklist.js');
const { installPlaybackGate } = await import('../features/playbackGate.js');

beforeEach(() => {
  const blocked = [BLOCKED, ...LIVE_CHANNELS, ...PERSONAL_CHANNELS];
  configWrite('blockedChannels', blocked.map(id => `id:${id}`));
  configWrite('blockedChannelNames', { [`id:${BLOCKED}`]: 'Same name', 'name:same name': 'Same name' });
  configWrite('enabledCommunitySources', ['religion']);
  configWrite('communityAllowedChannels', []);
});

function player(channelId = BLOCKED, videoId = VIDEO) {
  return { videoDetails: { videoId, channelId, author: 'Same name', isLiveContent: false },
    playabilityStatus: { status: 'OK' },
    streamingData: { formats: [{ url: 'https://example.invalid/video' }],
      hlsManifestUrl: 'https://example.invalid/live.m3u8', dashManifestUrl: 'https://example.invalid/live.mpd' },
    playerAds: [{}], adPlacements: [{}], adSlots: [{}] };
}

function next(channelId, videoId = VIDEO) {
  return { currentVideoEndpoint: { watchEndpoint: { videoId } }, contents: {
    singleColumnWatchNextResults: { results: { results: { contents: [{ itemSectionRenderer: {
      contents: [{ videoMetadataRenderer: { owner: { videoOwnerRenderer: {
        navigationEndpoint: { browseEndpoint: { browseId: channelId } },
      } } } }],
    } }] } } },
  } };
}

function browser(hash) {
  const events = new Map();
  const timers = new Map();
  const screens = [];
  let nativePlays = 0;
  let backs = 0;
  let videoId = VIDEO;
  let payload;
  const playerEvents = new EventTarget();
  playerEvents.getVideoData = () => ({ video_id: videoId });
  playerEvents.getPlayerResponse = () => payload;
  class Media {
    tagName = 'VIDEO';
    pauses = 0;
    loads = 0;
    source = 'blob:synthetic';
    play() { nativePlays++; return Promise.resolve('playing'); }
    pause() { this.pauses++; }
    getAttribute() { return this.source; }
    removeAttribute() { this.source = null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    load() {
      this.loads++;
      events.get('loadstart')?.({ target: this });
    }
  }
  const media = new Media();
  class Response { async json() { return payload; } }
  class XHR { get response() { return payload; } }
  const environment = {
    location: { hash }, history: { length: 2, back() { backs++; } },
    HTMLMediaElement: Media, Response, XMLHttpRequest: XHR,
    setTimeout(callback) { const token = Symbol(); timers.set(token, callback); return token; },
    clearTimeout(token) { timers.delete(token); },
    document: {
      querySelector() { return playerEvents; }, querySelectorAll() { return [media]; },
      addEventListener(type, callback) { events.set(type, callback); },
      removeEventListener(type) { events.delete(type); },
      body: { appendChild(screen) { screens.push(screen); } },
      createElement() {
        return { style: {}, setAttribute() {}, remove() { this.removed = true; } };
      },
    },
  };
  return { environment, media, screens, playerEvents,
    setPayload(value) { payload = value; }, setVideoId(value) { videoId = value; },
    flushTimers() { for (const callback of [...timers.values()]) callback(); timers.clear(); },
    emit(type) { events.get(type)?.({ target: media }); },
    get nativePlays() { return nativePlays; }, get backs() { return backs; },
  };
}

const routes = [
  ['player', '#/watch?v=testvideo01'], ['watch-next', '#/watch?v=testvideo01'],
  ['search', '#/search?q=example'], ['home', '#/'],
  ['history', '#/browse?c=FEhistory'], ['library', '#/browse?c=FElibrary'],
  ['playlist', '#/playlist?list=PLtest'], ['list=', '#/watch?v=testvideo01&list=PLtest'],
  ['deep-link', '#/watch?v=testvideo01'], ['live', '#/browse?c=FEtopics_news&tab=live'],
  ['Shorts', '#/shorts/testvideo01'], ['autoplay', '#/watch?v=testvideo01'],
  ['up-next', '#/watch?v=testvideo01'], ['queue', '#/watch?v=testvideo01'],
  ['cast', '#/watch?v=testvideo01'], ['DIAL', '#/watch?v=testvideo01'],
];

for (const [route, hash] of routes) {
  test(`${route}: blocked ID cannot reach native media play, including Guest`, async () => {
    const gate = createPlaybackGate();
    const response = player();
    response.responseContext = { mainAppWebResponseContext: { loggedOut: true } };
    const envelope = route === 'watch-next' ? { ...next(BLOCKED), playerResponse: response } : response;
    gate.observe(envelope);
    assert.equal(response.playabilityStatus.status, 'UNPLAYABLE');
    assert.equal(response.playabilityStatus.reason, 'Blocked channel');
    for (const key of ['streamingData', 'playerAds', 'adPlacements', 'adSlots']) assert(!(key in response));
    const tab = browser(hash);
    const dispose = installPlaybackGate(tab.environment, gate);
    try {
      await assert.rejects(tab.media.play(), { name: 'NotAllowedError', message: 'Blocked channel' });
      assert.equal(tab.nativePlays, 0);
      assert(tab.media.pauses > 0);
      assert.equal(tab.media.source, null);
      assert.equal(tab.screens[0].textContent, 'Blocked channel');
      tab.flushTimers();
      assert.equal(tab.backs, 1);
    } finally { dispose(); }
  });
  test(`${route}: allowed ID reaches native media play unchanged`, async () => {
    const gate = createPlaybackGate();
    const response = player(ALLOWED);
    const original = structuredClone(response);
    gate.observe(response);
    assert.deepEqual(response, original);
    const tab = browser(hash);
    const dispose = installPlaybackGate(tab.environment, gate);
    try {
      assert.equal(await tab.media.play(), 'playing');
      assert.equal(tab.nativePlays, 1);
      assert.equal(tab.media.pauses, 0);
      assert.equal(tab.screens.length, 0);
      tab.flushTimers();
      assert.equal(tab.backs, 0);
    } finally { dispose(); }
  });
}

for (const channelId of PERSONAL_CHANNELS) {
  for (const [route, hash] of routes) {
    test(`personal ${channelId} ${route}: refuse playback at the media boundary`, async () => {
      const gate = createPlaybackGate();
      const response = player(channelId);
      gate.observe(response);
      assert.equal(response.playabilityStatus.status, 'UNPLAYABLE');
      assert.equal(response.streamingData, undefined);
      const tab = browser(hash);
      const dispose = installPlaybackGate(tab.environment, gate);
      try {
        await assert.rejects(tab.media.play(), /Blocked channel/);
        assert.equal(tab.nativePlays, 0);
      } finally { dispose(); }
    });
  }
}

for (const channelId of LIVE_CHANNELS) {
  test(`live blocked ${channelId}: strip HLS/DASH/formats and refuse media`, async () => {
    const gate = createPlaybackGate();
    const response = player(channelId);
    response.videoDetails.isLiveContent = true;
    gate.observe(response);
    assert.equal(response.streamingData, undefined);
    assert.equal(response.playabilityStatus.status, 'UNPLAYABLE');
    const tab = browser('#/watch?v=testvideo01');
    const dispose = installPlaybackGate(tab.environment, gate);
    try { await assert.rejects(tab.media.play(), /Blocked channel/); }
    finally { dispose(); }
  });
}

test('allowed live stream retains HLS, DASH and native playback', async () => {
  const gate = createPlaybackGate();
  const response = player(ALLOWED);
  response.videoDetails.isLiveContent = true;
  const original = structuredClone(response);
  gate.observe(response);
  assert.deepEqual(response, original);
  const tab = browser('#/watch?v=testvideo01');
  const dispose = installPlaybackGate(tab.environment, gate);
  try { assert.equal(await tab.media.play(), 'playing'); }
  finally { dispose(); }
});

test('each enabled community source refuses playback, not just cards', async () => {
  for (const source of ['aislist', 'sloptube', 'minimaltube', 'religion']) {
    configWrite('enabledCommunitySources', [source]);
    const gate = createPlaybackGate();
    const response = player(COMMUNITY);
    gate.observe(response);
    assert.equal(response.playabilityStatus.status, 'UNPLAYABLE');
    const tab = browser('#/watch?v=testvideo01');
    const dispose = installPlaybackGate(tab.environment, gate);
    try { await assert.rejects(tab.media.play(), /Blocked channel/); }
    finally { dispose(); }
  }
});

test('unknown/invalid IDs allow playback and log once; names never authorize a denial', async () => {
  configWrite('blockedChannels', ['name:same name']);
  const logs = [];
  const gate = createPlaybackGate({ logUnknown: detail => logs.push(detail) });
  for (const channelId of [undefined, 'not-a-channel-id']) {
    const response = player(channelId);
    if (channelId === undefined) delete response.videoDetails.channelId;
    const original = structuredClone(response);
    gate.observe(response);
    assert.deepEqual(response, original);
  }
  assert.equal(logs.length, 1);
  assert.equal(logs[0].videoId, VIDEO);
  const tab = browser('#/watch?v=testvideo01');
  const dispose = installPlaybackGate(tab.environment, gate);
  try { assert.equal(await tab.media.play(), 'playing'); }
  finally { dispose(); }
  assert.equal(logs.length, 1);
  assert.equal(isPlaybackChannelBlocked(ALLOWED), false);
});

test('enabled community source, exceptions, and explicit personal precedence', () => {
  assert.equal(isPlaybackChannelBlocked(COMMUNITY), true);
  configWrite('enabledCommunitySources', []);
  assert.equal(isPlaybackChannelBlocked(COMMUNITY), false);
  configWrite('enabledCommunitySources', ['religion']);
  configWrite('communityAllowedChannels', [COMMUNITY]);
  assert.equal(isPlaybackChannelBlocked(COMMUNITY), false);
  configWrite('blockedChannels', [`id:${COMMUNITY}`]);
  assert.equal(isPlaybackChannelBlocked(COMMUNITY), true);
  const keys = [];
  configWrite('blockedChannels', keys);
  assert.equal(isPlaybackChannelBlocked(COMMUNITY), false);
  keys.push(`id:${COMMUNITY}`);
  configWrite('blockedChannels', keys);
  assert.equal(isPlaybackChannelBlocked(COMMUNITY), true);
});

test('next owner is a video-keyed fallback, never recommendation owners or another video', () => {
  const gate = createPlaybackGate({ logUnknown() {} });
  gate.observe(next(BLOCKED));
  const response = player();
  delete response.videoDetails.channelId;
  gate.observe(response);
  assert.equal(response.playabilityStatus.status, 'UNPLAYABLE');
  assert.equal(gate.decision('another0001').blocked, false);
  const unrelated = next(ALLOWED, 'another0001');
  unrelated.contents.singleColumnWatchNextResults.pivot = next(BLOCKED).contents;
  gate.observe(unrelated);
  assert.equal(gate.decision('another0001').blocked, false);
});

test('authoritative player ID overrides next-owner fallback in either arrival order', () => {
  for (const first of ['player', 'next']) {
    const gate = createPlaybackGate();
    if (first === 'next') gate.observe(next(BLOCKED));
    gate.observe(player(ALLOWED));
    gate.observe(next(BLOCKED));
    assert.equal(gate.decision(VIDEO).blocked, false);
    gate.observe(player(BLOCKED));
    gate.observe(next(ALLOWED));
    assert.equal(gate.decision(VIDEO).blocked, true);
  }
});

test('blocked authoritative ID strips playback even if video ID is missing', () => {
  const gate = createPlaybackGate();
  const response = player();
  delete response.videoDetails.videoId;
  gate.observe(response);
  assert.equal(response.playabilityStatus.status, 'UNPLAYABLE');
});

test('embedded string and multi-player responses are gated without name matching', () => {
  const gate = createPlaybackGate();
  const response = { args: { player_response: JSON.stringify(player()) },
    playerResponses: [{ playerResponse: player(ALLOWED, 'allowed0001') }] };
  gate.observe(response);
  assert.equal(JSON.parse(response.args.player_response).playabilityStatus.status, 'UNPLAYABLE');
  assert.equal(response.playerResponses[0].playerResponse.playabilityStatus.status, 'OK');
});

test('Shorts reel entries gate embedded player payloads individually', () => {
  const gate = createPlaybackGate();
  const denied = player();
  const allowed = player(ALLOWED, 'allowed0001');
  gate.observe({ entries: [denied, allowed].map(playerResponse => ({
    command: { reelWatchEndpoint: { playerResponse } },
  })) });
  assert.equal(denied.streamingData, undefined);
  assert.equal(allowed.playabilityStatus.status, 'OK');
});

test('fetch JSON and native XHR JSON responses are sanitized before consumers see them', async () => {
  const gate = createPlaybackGate({ logUnknown() {} });
  const tab = browser('#/watch?v=testvideo01');
  const dispose = installPlaybackGate(tab.environment, gate);
  try {
    tab.setPayload(player());
    const fetched = await new tab.environment.Response().json();
    assert.equal(fetched.streamingData, undefined);
    tab.setPayload(player(BLOCKED, 'otherbad001'));
    const xhr = new tab.environment.XMLHttpRequest();
    assert.equal(xhr.response.playabilityStatus.status, 'UNPLAYABLE');
  } finally { dispose(); }
});

test('prefetch of blocked video cannot interrupt unrelated allowed playback', async () => {
  const gate = createPlaybackGate();
  gate.observe(player(ALLOWED));
  const tab = browser('#/watch?v=testvideo01');
  const dispose = installPlaybackGate(tab.environment, gate);
  try {
    gate.observe(player(BLOCKED, 'prefetch001'));
    await Promise.resolve();
    assert.equal(await tab.media.play(), 'playing');
    assert.equal(tab.screens.length, 0);
  } finally { dispose(); }
});

test('late next metadata stops an unknown launch, without recursion or repeated back actions', async () => {
  const gate = createPlaybackGate({ logUnknown() {} });
  const tab = browser('#/watch?v=testvideo01');
  const dispose = installPlaybackGate(tab.environment, gate);
  try {
    await tab.media.play();
    gate.observe(next(BLOCKED));
    await Promise.resolve();
    assert(tab.media.pauses > 0);
    assert.equal(tab.media.loads, 1);
    tab.emit('playing');
    tab.flushTimers();
    assert.equal(tab.backs, 1);
  } finally { dispose(); }
});

test('cached autoplay/queue/cast player metadata is checked at state-change boundary', async () => {
  const gate = createPlaybackGate({ logUnknown() {} });
  const tab = browser('#/');
  const dispose = installPlaybackGate(tab.environment, gate);
  try {
    await tab.media.play();
    tab.setPayload(player());
    tab.playerEvents.dispatchEvent(new Event('onVideoDataChange'));
    await Promise.resolve();
    assert(tab.media.pauses > 0);
    await assert.rejects(tab.media.play(), /Blocked channel/);
  } finally { dispose(); }
});

test('authoritative allowance cancels a pending fallback denial for the same video', async () => {
  const gate = createPlaybackGate();
  gate.observe(next(BLOCKED));
  const tab = browser('#/watch?v=testvideo01');
  const dispose = installPlaybackGate(tab.environment, gate);
  try {
    await assert.rejects(tab.media.play(), /Blocked channel/);
    gate.observe(player(ALLOWED));
    await Promise.resolve();
    assert.equal(await tab.media.play(), 'playing');
    tab.flushTimers();
    assert.equal(tab.backs, 0);
  } finally { dispose(); }
});

test('temporarily unavailable native metadata remains unknown, not a playback failure', async () => {
  const gate = createPlaybackGate({ logUnknown() {} });
  const tab = browser('#/watch?v=testvideo01');
  tab.playerEvents.getVideoData = () => { throw new Error('Not ready'); };
  tab.playerEvents.getPlayerResponse = () => { throw new Error('Not ready'); };
  const dispose = installPlaybackGate(tab.environment, gate);
  try { assert.equal(await tab.media.play(), 'playing'); }
  finally { dispose(); }
});

test('navigation to a new allowed video cancels delayed back; cleanup restores boundaries', async () => {
  const gate = createPlaybackGate();
  gate.observe(player());
  const tab = browser('#/watch?v=testvideo01');
  const originalPlay = tab.environment.HTMLMediaElement.prototype.play;
  const dispose = installPlaybackGate(tab.environment, gate);
  await assert.rejects(tab.media.play(), /Blocked channel/);
  tab.setVideoId('allowed0001');
  gate.observe(player(ALLOWED, 'allowed0001'));
  await Promise.resolve();
  assert.equal(await tab.media.play(), 'playing');
  tab.flushTimers();
  assert.equal(tab.backs, 0);
  dispose();
  assert.equal(tab.environment.HTMLMediaElement.prototype.play, originalPlay);
});
