const axios = require('axios');
const cfg   = require('./config');

const YT_API = 'https://www.googleapis.com/youtube/v3';

function extractVideoId(url) {
  const m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function _channelParams(url) {
  const handle  = url.match(/youtube\.com\/@([a-zA-Z0-9_.-]+)/);
  if (handle)  return { forHandle: handle[1] };
  const chanId  = url.match(/youtube\.com\/channel\/([a-zA-Z0-9_-]+)/);
  if (chanId)  return { id: chanId[1] };
  const named   = url.match(/youtube\.com\/(?:c|user)\/([^/?#]+)/);
  if (named)   return { forUsername: named[1] };
  return null;
}

function _mapChannel(item) {
  const s = item.snippet;
  const st = item.statistics || {};
  return {
    id:          item.id,
    title:       s.title,
    handle:      s.customUrl || null,
    thumbnail:   s.thumbnails?.high?.url || s.thumbnails?.default?.url || null,
    subscribers: parseInt(st.subscriberCount || '0'),
    videos:      parseInt(st.videoCount      || '0'),
    totalViews:  parseInt(st.viewCount       || '0'),
    hiddenSubs:  st.hiddenSubscriberCount    || false,
  };
}

async function getVideoInfo(videoId) {
  const { data } = await axios.get(`${YT_API}/videos`, {
    params: { part: 'snippet,statistics', id: videoId, key: cfg.YOUTUBE_API_KEY },
    timeout: 10000,
  });
  const item = data.items?.[0];
  if (!item) return null;
  const s  = item.snippet;
  const st = item.statistics;
  return {
    id:          item.id,
    title:       s.title,
    channelId:   s.channelId,
    channelTitle: s.channelTitle,
    publishedAt: s.publishedAt,
    thumbnail:   s.thumbnails?.high?.url || s.thumbnails?.medium?.url || null,
    views:       parseInt(st.viewCount   || '0'),
    likes:       parseInt(st.likeCount   || '0'),
    comments:    parseInt(st.commentCount|| '0'),
  };
}

async function getChannelByUrl(url) {
  const params = _channelParams(url);
  if (!params) return null;
  const { data } = await axios.get(`${YT_API}/channels`, {
    params: { part: 'snippet,statistics', key: cfg.YOUTUBE_API_KEY, ...params },
    timeout: 10000,
  });
  const item = data.items?.[0];
  return item ? _mapChannel(item) : null;
}

async function getChannelById(channelId) {
  const { data } = await axios.get(`${YT_API}/channels`, {
    params: { part: 'snippet,statistics', id: channelId, key: cfg.YOUTUBE_API_KEY },
    timeout: 10000,
  });
  const item = data.items?.[0];
  return item ? _mapChannel(item) : null;
}

module.exports = { extractVideoId, getVideoInfo, getChannelByUrl, getChannelById };
