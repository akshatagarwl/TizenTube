import { playbackGate } from '../utils/playbackBlocklist.js';

const RETURN_DELAY_MS = 1200;

export function installPlaybackGate(environment = window, gate = playbackGate) {
  const document = environment.document;
  const restorers = [];
  let screen;
  let returnTimer;
  let deniedVideo;
  let stopping = false;
  let returnedVideo;

  function playerValue(method) {
    const player = document.querySelector('.html5-video-player');
    try {
      return player?.[method]?.();
    } catch (error) {
      console.warn('TizenTube: playback metadata unavailable', method, error.message);
      return null;
    }
  }

  function currentVideoId() {
    const data = playerValue('getVideoData');
    if (data?.video_id) return data.video_id;
    const hash = environment.location.hash;
    const watch = /[?&]v=([\w-]+)/.exec(hash);
    const short = /\/shorts\/([\w-]+)/.exec(hash);
    return watch?.[1] ?? short?.[1] ?? null;
  }

  function goBack() {
    for (const value of Object.values(environment._yttv ?? {})) {
      if (value?.instance?.resolveCommand) {
        value.instance.resolveCommand({ signalServiceEndpoint: { signal: 'HISTORY_BACK' } });
        return;
      }
    }
    if (environment.history.length > 1) environment.history.back();
    else environment.location.hash = '#/';
  }

  function removeScreen() {
    screen?.remove();
    screen = null;
    deniedVideo = null;
    environment.clearTimeout(returnTimer);
  }

  function refuse(videoId, media) {
    if (stopping) return;
    const videos = media ? [media] : document.querySelectorAll('video, audio');
    stopping = true;
    try {
      for (const video of videos) {
        video.pause();
        const hasSource = video.getAttribute('src') || video.querySelector('source[src]');
        if (!hasSource && !video.srcObject) continue;
        video.removeAttribute('src');
        video.srcObject = null;
        video.querySelectorAll('source').forEach(source => source.removeAttribute('src'));
        video.load();
      }
    } finally {
      stopping = false;
    }
    if (deniedVideo === videoId || returnedVideo === videoId) return;
    removeScreen();
    deniedVideo = videoId;
    screen = document.createElement('div');
    screen.setAttribute('role', 'alert');
    screen.textContent = 'Blocked channel';
    screen.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;'
      + 'align-items:center;justify-content:center;background:#111;color:white;font-size:32px';
    (document.body ?? document.documentElement).appendChild(screen);
    returnTimer = environment.setTimeout(() => {
      if (currentVideoId() === videoId) {
        returnedVideo = videoId;
        goBack();
      }
      removeScreen();
    }, RETURN_DELAY_MS);
  }

  function check(media) {
    const videoId = currentVideoId();
    if (returnedVideo !== videoId) returnedVideo = null;
    const payload = playerValue('getPlayerResponse');
    if (payload?.videoDetails?.videoId === videoId) gate.observe(payload);
    if (gate.decision(videoId).blocked) {
      refuse(videoId, media);
      return false;
    }
    if (deniedVideo) removeScreen();
    returnedVideo = null;
    return true;
  }

  const mediaPrototype = environment.HTMLMediaElement?.prototype;
  if (mediaPrototype) {
    const originalPlay = mediaPrototype.play;
    mediaPrototype.play = function (...args) {
      if (check(this)) return originalPlay.apply(this, args);
      const error = new Error('Blocked channel');
      error.name = 'NotAllowedError';
      return Promise.reject(error);
    };
    restorers.push(() => { mediaPrototype.play = originalPlay; });
  }

  function onMediaEvent(event) {
    if (!['VIDEO', 'AUDIO'].includes(event.target?.tagName)) return;
    check(event.target);
  }
  for (const event of ['loadstart', 'play', 'playing', 'loadedmetadata']) {
    document.addEventListener(event, onMediaEvent, true);
    restorers.push(() => document.removeEventListener(event, onMediaEvent, true));
  }

  // Parsed metadata may arrive after an unknown-channel launch has started.
  restorers.push(gate.subscribe(videoId => {
    Promise.resolve().then(() => {
      if (currentVideoId() === videoId) check();
    });
  }));

  const players = new Set();
  function attachPlayer() {
    for (const player of players) {
      if (player.isConnected !== false) continue;
      player.removeEventListener('onStateChange', onPlayerChange);
      player.removeEventListener('onVideoDataChange', onPlayerChange);
      players.delete(player);
    }
    const player = document.querySelector('.html5-video-player');
    if (!player || players.has(player)) return;
    players.add(player);
    player.addEventListener('onStateChange', onPlayerChange);
    player.addEventListener('onVideoDataChange', onPlayerChange);
    onPlayerChange();
  }
  function onPlayerChange() {
    const payload = playerValue('getPlayerResponse');
    if (payload) gate.observe(payload);
    check();
  }
  attachPlayer();
  if (environment.MutationObserver) {
    const observer = new environment.MutationObserver(attachPlayer);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    restorers.push(() => observer.disconnect());
  }
  restorers.push(() => {
    for (const player of players) {
      player.removeEventListener('onStateChange', onPlayerChange);
      player.removeEventListener('onVideoDataChange', onPlayerChange);
    }
  });

  const responsePrototype = environment.Response?.prototype;
  if (responsePrototype?.json) {
    const originalJson = responsePrototype.json;
    responsePrototype.json = async function (...args) {
      return gate.observe(await originalJson.apply(this, args));
    };
    restorers.push(() => { responsePrototype.json = originalJson; });
  }

  const xhrPrototype = environment.XMLHttpRequest?.prototype;
  const response = xhrPrototype && Object.getOwnPropertyDescriptor(xhrPrototype, 'response');
  if (response?.get && response.configurable) {
    Object.defineProperty(xhrPrototype, 'response', {
      ...response,
      get() { return gate.observe(response.get.call(this)); },
    });
    restorers.push(() => Object.defineProperty(xhrPrototype, 'response', response));
  }

  return () => {
    restorers.reverse().forEach(restore => restore());
    removeScreen();
  };
}

if (typeof document !== 'undefined') installPlaybackGate();
