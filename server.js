const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

// Disable TLS verification to handle misconfigured or expired IPTV SSL certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Helper to fetch URL content supporting redirects, automatic decompression (gzip/deflate), and custom User-Agent
async function fetchUrl(targetUrl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

  try {
    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*'
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Server returned status code ${response.status}`);
    }

    return await response.text();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('Request timed out after 30 seconds');
    }
    throw err;
  }
}


const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS globally
app.use(cors());
app.use(express.json());

// In-memory store for active streams
// Key: streamId (hash of stream URL), Value: { url, process, lastAccessed }
const activeStreams = new Map();

// Helper to generate unique stream ID
function getStreamId(streamUrl) {
  return crypto.createHash('md5').update(streamUrl).digest('hex');
}

// Temporary directory for streams
const STREAMS_DIR = path.join(__dirname, 'public', 'streams');

// Ensure streams directory exists and is clean at startup
if (fs.existsSync(STREAMS_DIR)) {
  try {
    fs.rmSync(STREAMS_DIR, { recursive: true, force: true });
  } catch (err) {
    console.error('Error clearing streams directory on startup:', err.message);
  }
}
fs.mkdirSync(STREAMS_DIR, { recursive: true });

// Custom middleware to track HLS stream activity and update lastAccessed
app.use('/streams/:streamId', (req, res, next) => {
  const { streamId } = req.params;
  for (const stream of activeStreams.values()) {
    if (stream.id === streamId) {
      stream.lastAccessed = Date.now();
      break;
    }
  }
  next();
});

// Configure HLS MIME Types and serve static streams
app.use('/streams', (req, res, next) => {
  if (req.path.endsWith('.m3u8')) {
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
  } else if (req.path.endsWith('.ts')) {
    res.set('Content-Type', 'video/mp2t');
  }
  next();
}, express.static(STREAMS_DIR));

// Serve other public assets (like frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Persistent directory for user data
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const USER_DATA_FILE = path.join(DATA_DIR, 'userdata.json');

// /api/userdata endpoint to fetch global state
app.get('/api/userdata', (req, res) => {
  try {
    if (fs.existsSync(USER_DATA_FILE)) {
      const data = fs.readFileSync(USER_DATA_FILE, 'utf8');
      res.json(JSON.parse(data));
    } else {
      res.json({});
    }
  } catch (err) {
    console.error('Error reading userdata:', err);
    res.status(500).json({ error: 'Failed to read userdata' });
  }
});

// /api/userdata endpoint to save global state
app.post('/api/userdata', (req, res) => {
  try {
    const data = req.body;
    let existingData = {};
    if (fs.existsSync(USER_DATA_FILE)) {
      try {
        existingData = JSON.parse(fs.readFileSync(USER_DATA_FILE, 'utf8'));
      } catch (e) {}
    }
    
    // Merge updates
    if (data.playlistRegistry !== undefined) existingData.playlistRegistry = data.playlistRegistry;
    if (data.favorites !== undefined) existingData.favorites = data.favorites;
    if (data.xtreamProfiles !== undefined) existingData.xtreamProfiles = data.xtreamProfiles;
    
    fs.writeFileSync(USER_DATA_FILE, JSON.stringify(existingData, null, 2), 'utf8');
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving userdata:', err);
    res.status(500).json({ error: 'Failed to save userdata' });
  }
});

// /playlist endpoint to fetch remote M3U files (bypassing CORS)
app.get('/playlist', async (req, res) => {
  const playlistUrl = req.query.url;
  if (!playlistUrl) {
    return res.status(400).json({ error: 'Missing "url" query parameter.' });
  }
  try {
    const data = await fetchUrl(playlistUrl);
    res.set('Content-Type', 'text/plain');
    res.send(data);
  } catch (err) {
    console.error(`Error fetching playlist ${playlistUrl}:`, err.message);
    res.status(500).json({ error: `Failed to fetch playlist: ${err.message}` });
  }
});

// Cache variables for IPTV-org registry
let iptvOrgChannels = null;
let iptvOrgStreams = null;
let isPreloading = false;

// Async function to load IPTV-org registry into memory
async function loadIptvOrgData() {
  if (iptvOrgChannels && iptvOrgStreams) return;
  if (isPreloading) {
    // Wait until loading finishes (poll briefly)
    while (isPreloading) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return;
  }

  isPreloading = true;
  console.log('Preloading IPTV-org channel registry...');
  try {
    const channelsData = await fetchUrl('https://iptv-org.github.io/api/channels.json');
    iptvOrgChannels = JSON.parse(channelsData);
    console.log(`Loaded ${iptvOrgChannels.length} channels from IPTV-org registry.`);

    const streamsData = await fetchUrl('https://iptv-org.github.io/api/streams.json');
    iptvOrgStreams = JSON.parse(streamsData);
    console.log(`Loaded ${iptvOrgStreams.length} streams from IPTV-org registry.`);
  } catch (err) {
    console.error('Failed to load IPTV-org registry database:', err.message);
  } finally {
    isPreloading = false;
  }
}

// /search-internet endpoint
app.get('/search-internet', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Missing "q" query parameter.' });
  }

  const results = [];
  const queryLower = query.toLowerCase().trim();

  // 1. Search IPTV-org local cache (starts loading asynchronously if not loaded)
  try {
    await loadIptvOrgData();
    if (iptvOrgChannels && iptvOrgStreams) {
      // Find matching channels
      const matchedChannels = iptvOrgChannels.filter(ch =>
        ch.name && ch.name.toLowerCase().includes(queryLower)
      );

      const channelMap = new Map();
      matchedChannels.forEach(ch => channelMap.set(ch.id, ch));

      // Find streams for matching channels
      iptvOrgStreams.forEach(stream => {
        if (channelMap.has(stream.channel)) {
          const ch = channelMap.get(stream.channel);
          results.push({
            name: ch.name,
            logo: ch.logo || '',
            group: ch.categories ? ch.categories.join(', ') : 'Registry',
            url: stream.url,
            source: 'IPTV-org Registry'
          });
        }
      });
    }
  } catch (err) {
    console.error('IPTV-org registry search failed:', err.message);
  }

  // 2. Search DuckDuckGo for direct stream links
  try {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query + ' iptv m3u8')}`;
    const html = await fetchUrl(searchUrl);

    // Extract link URLs matching typical HLS patterns (.m3u8)
    const m3u8Regex = /https?:\/\/[^\s"'><\)]+\.m3u8[^\s"'><\)]*/gi;
    const matches = html.match(m3u8Regex) || [];

    // Clean and de-duplicate links
    const uniqueLinks = Array.from(new Set(matches.map(link => {
      let cleaned = link.replace(/&amp;/g, '&');
      // Remove trailing HTML entities or brackets that regex might catch
      cleaned = cleaned.split('"')[0].split("'")[0].split(')')[0];
      return cleaned;
    })));

    uniqueLinks.forEach((link, idx) => {
      // Exclude generic github project root pages, allow raw files
      if (!link.includes('github.com') || link.includes('/raw/')) {
        results.push({
          name: `${query} (Search Link #${idx + 1})`,
          logo: '',
          group: 'Web Crawler',
          url: link,
          source: 'DuckDuckGo Search'
        });
      }
    });
  } catch (err) {
    console.error('DuckDuckGo search scraper failed:', err.message);
  }

  res.json(results);
});

// Quality presets: resolution scale + video bitrate cap
const QUALITY_PRESETS = {
  auto:    { scale: null,      videoBitrate: null,    label: 'Auto' },
  high:    { scale: '1280:-2', videoBitrate: '2500k', label: '720p' },
  medium:  { scale: '854:-2',  videoBitrate: '1200k', label: '480p' },
  low:     { scale: '640:-2',  videoBitrate: '600k',  label: '360p' },
  verylow: { scale: '426:-2',  videoBitrate: '300k',  label: '240p' },
};

// /stream endpoint to initiate/get transcoding URL
app.get('/stream', async (req, res) => {
  const streamUrl = req.query.url;
  const quality = QUALITY_PRESETS[req.query.quality] ? req.query.quality : 'auto';
  if (!streamUrl) {
    return res.status(400).json({ error: 'Missing "url" query parameter.' });
  }

  // Use url+quality as the cache key so quality changes restart the stream
  const cacheKey = `${streamUrl}::${quality}`;
  const streamId = getStreamId(cacheKey);
  const streamDir = path.join(STREAMS_DIR, streamId);
  const playlistPath = path.join(streamDir, 'playlist.m3u8');

  // Update access time if stream already active
  if (activeStreams.has(cacheKey)) {
    const streamInfo = activeStreams.get(cacheKey);
    streamInfo.lastAccessed = Date.now();
    return res.redirect(`/streams/${streamId}/playlist.m3u8`);
  }

  // Limit concurrent active streams to protect the server
  const MAX_CONCURRENT_STREAMS = 5;
  if (activeStreams.size >= MAX_CONCURRENT_STREAMS) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, streamInfo] of activeStreams.entries()) {
      if (streamInfo.lastAccessed < oldestTime) {
        oldestTime = streamInfo.lastAccessed;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      console.log(`Max concurrent streams reached (${MAX_CONCURRENT_STREAMS}). Terminating oldest stream: ${oldestKey}`);
      cleanupStream(oldestKey);
    }
  }

  // Create workspace for this stream
  if (!fs.existsSync(streamDir)) {
    fs.mkdirSync(streamDir, { recursive: true });
  }

  const preset = QUALITY_PRESETS[quality];
  const isCopy = quality === 'auto';
  console.log(`Starting stream proxy [${quality}] for: ${streamUrl}`);

  // Construct browser-like headers
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
  let referer = '';
  try { referer = new URL(streamUrl).origin; } catch(e) {}
  const headerLines = [];
  if (userAgent) headerLines.push(`User-Agent: ${userAgent}`);
  if (referer) headerLines.push(`Referer: ${referer}`);
  const headers = headerLines.join('\r\n');

  // Build output options
  const outputOpts = [
    '-f hls',
    '-hls_time 2',
    '-hls_list_size 6', // Increased from 3 to 6 to buffer up to 12s of video
    '-hls_flags delete_segments',
    '-copyts',
  ];

  if (!isCopy) {
    outputOpts.push('-preset ultrafast');
    outputOpts.push('-tune zerolatency');
    outputOpts.push('-g 30');
  }

  // Apply quality-specific options
  if (preset.scale) {
    outputOpts.push(`-vf scale=${preset.scale}`);
  }
  if (preset.videoBitrate) {
    outputOpts.push(`-b:v ${preset.videoBitrate}`);
    outputOpts.push(`-maxrate ${preset.videoBitrate}`);
    outputOpts.push(`-bufsize ${preset.videoBitrate}`);
  }

  let command = ffmpeg(streamUrl)
    .addInputOption('-headers', headers)
    .addInputOption('-probesize', '1000000')
    .addInputOption('-analyzeduration', '1000000');

  if (isCopy) {
    command = command
      .videoCodec('copy')
      .audioCodec('copy');
  } else {
    command = command
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('128k');
  }

  command = command
    .outputOptions(outputOpts)
    .output(playlistPath)
    .on('start', (commandLine) => {
      console.log(`Spawned FFmpeg [${quality}]: ${commandLine}`);
    })
    .on('error', (err, stdout, stderr) => {
      console.error(`FFmpeg error for ${streamUrl}:`, err.message);
      cleanupStream(cacheKey);
    })
    .on('end', () => {
      console.log(`FFmpeg process finished for ${streamUrl}`);
      cleanupStream(cacheKey);
    });

  // Save stream details
  activeStreams.set(cacheKey, {
    id: streamId,
    url: streamUrl,
    process: command,
    lastAccessed: Date.now()
  });

  // Execute FFmpeg
  command.run();

  // Wait for playlist to be ready before redirecting
  let attempts = 0;
  const maxAttempts = 30; // Increased to 30 (15 seconds) for slower remote streams
  const checkInterval = 500;

  const waitForPlaylist = setInterval(() => {
    attempts++;
    if (fs.existsSync(playlistPath) && fs.statSync(playlistPath).size > 0) {
      clearInterval(waitForPlaylist);
      return res.redirect(`/streams/${streamId}/playlist.m3u8`);
    }

    if (attempts >= maxAttempts) {
      clearInterval(waitForPlaylist);
      cleanupStream(cacheKey);
      return res.status(504).json({ error: 'Timeout waiting for stream transcoding to initialize.' });
    }
  }, checkInterval);
});


// Stream details API for status debugging
app.get('/api/streams', (req, res) => {
  const streams = Array.from(activeStreams.entries()).map(([url, data]) => ({
    id: data.id,
    url: url,
    lastAccessed: new Date(data.lastAccessed).toISOString(),
    ageSeconds: Math.round((Date.now() - data.lastAccessed) / 1000)
  }));
  res.json(streams);
});

// /api/ai-search endpoint
app.post('/api/ai-search', async (req, res) => {
  const { prompt, apiKey } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Missing "prompt" body parameter.' });
  }

  let searchParams = {
    search_keywords: [],
    category: null,
    language: null,
    country: null,
    ai_explanation: 'Searching the IPTV registry for matches...'
  };

  const keyToUse = apiKey || process.env.GEMINI_API_KEY;

  if (keyToUse) {
    try {
      // Call Gemini API
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${keyToUse}`;
      const response = await fetch(geminiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `You are an AI assistant for an IPTV player. The user is asking to find channels (e.g., "Spanish sports channels", "UK news").
Analyze the user's natural language request: "${prompt}"
And extract search parameters to query our IPTV database.
You must return a JSON object with:
- "search_keywords": array of strings (names or terms to search in channel names, e.g. ["espn", "fox"])
- "category": string (the main category if applicable: "news", "sports", "music", "movies", "kids", "documentary", "entertainment", "general")
- "language": string (3-letter language code, e.g. "eng", "spa", "fra", "deu", "ita", "por", "ara", "rus", "zho", "jpn")
- "country": string (2-letter country code, e.g. "us", "es", "fr", "gb", "de", "it", "pt", "br", "mx", "ar")
- "ai_explanation": a brief friendly message explaining what you are searching for.

Return ONLY a valid JSON object matching this schema. Do not wrap in markdown code blocks. Here is an example of the output structure:
{
  "search_keywords": ["bbc"],
  "category": "news",
  "language": "eng",
  "country": "gb",
  "ai_explanation": "I am searching for English news channels from the UK."
}`
            }]
          }],
          generationConfig: {
            responseMimeType: "application/json"
          }
        })
      });

      if (response.ok) {
        const resultJson = await response.json();
        const text = resultJson.candidates[0].content.parts[0].text;
        const parsed = JSON.parse(text.trim());
        searchParams = { ...searchParams, ...parsed };
      } else {
        console.error('Gemini API call failed status:', response.status);
      }
    } catch (err) {
      console.error('Gemini API call failed error:', err.message);
    }
  } else {
    // Local heuristic fallback parser
    const promptLower = prompt.toLowerCase().trim();
    
    // Extract category
    if (promptLower.includes('sport')) searchParams.category = 'sports';
    else if (promptLower.includes('news')) searchParams.category = 'news';
    else if (promptLower.includes('music')) searchParams.category = 'music';
    else if (promptLower.includes('movie') || promptLower.includes('film') || promptLower.includes('cinema')) searchParams.category = 'movies';
    else if (promptLower.includes('kid') || promptLower.includes('cartoon') || promptLower.includes('children')) searchParams.category = 'kids';
    else if (promptLower.includes('documentary') || promptLower.includes('doc')) searchParams.category = 'documentary';

    // Extract language
    if (promptLower.includes('spanish') || promptLower.includes('espanol') || promptLower.includes('spa')) searchParams.language = 'spa';
    else if (promptLower.includes('english') || promptLower.includes('eng')) searchParams.language = 'eng';
    else if (promptLower.includes('french') || promptLower.includes('francais') || promptLower.includes('fra')) searchParams.language = 'fra';
    else if (promptLower.includes('german') || promptLower.includes('deutsch') || promptLower.includes('deu')) searchParams.language = 'deu';
    else if (promptLower.includes('italian') || promptLower.includes('italiano') || promptLower.includes('ita')) searchParams.language = 'ita';
    else if (promptLower.includes('portuguese') || promptLower.includes('portugues') || promptLower.includes('por')) searchParams.language = 'por';

    // Extract keywords (filter out common helper words)
    const words = promptLower.split(/\s+/).filter(word => 
      !['find', 'me', 'i', 'want', 'to', 'watch', 'channels', 'channel', 'list', 'out', 'of', 'the', 'internet', 'for', 'in', 'show', 'search', 'give', 'sports', 'sport', 'news', 'music', 'movies', 'movie', 'kids', 'kid', 'cartoon', 'spanish', 'english', 'french', 'german', 'italian', 'portuguese'].includes(word)
    );
    if (words.length > 0) {
      searchParams.search_keywords = words;
    }
    
    searchParams.ai_explanation = `(Local Search) Searching for channels${searchParams.category ? ` in category "${searchParams.category}"` : ''}${searchParams.language ? ` in language code "${searchParams.language}"` : ''}${searchParams.search_keywords.length > 0 ? ` matching "${searchParams.search_keywords.join(', ')}"` : ''}.`;
  }

  // Execute Search on loaded data
  const results = [];
  try {
    await loadIptvOrgData();
    if (iptvOrgChannels && iptvOrgStreams) {
      const { category, language, country, search_keywords } = searchParams;
      
      const matchedChannels = iptvOrgChannels.filter(ch => {
        // Category check
        if (category && (!ch.categories || !ch.categories.includes(category))) {
          return false;
        }
        // Language check
        if (language && (!ch.languages || !ch.languages.includes(language))) {
          return false;
        }
        // Country check
        if (country && (!ch.countries || !ch.countries.includes(country))) {
          return false;
        }
        // Keywords check
        if (search_keywords && search_keywords.length > 0) {
          const nameLower = ch.name ? ch.name.toLowerCase() : '';
          const matchKeyword = search_keywords.some(kw => nameLower.includes(kw));
          if (!matchKeyword) return false;
        }
        return true;
      });

      const channelMap = new Map();
      matchedChannels.forEach(ch => channelMap.set(ch.id, ch));

      // Match with active streams
      iptvOrgStreams.forEach(stream => {
        if (channelMap.has(stream.channel)) {
          const ch = channelMap.get(stream.channel);
          results.push({
            name: ch.name,
            logo: ch.logo || '',
            group: ch.categories ? ch.categories.join(', ') : 'Registry',
            url: stream.url,
            source: 'IPTV-org Registry'
          });
        }
      });
    }
  } catch (err) {
    console.error('AI search filtering failed:', err.message);
  }

  // If no results and we have keywords, do a quick DuckDuckGo fallback search
  if (results.length === 0 && searchParams.search_keywords && searchParams.search_keywords.length > 0) {
    try {
      const query = searchParams.search_keywords.join(' ');
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query + ' iptv m3u8')}`;
      const html = await fetchUrl(searchUrl);
      const m3u8Regex = /https?:\/\/[^\s"'><\)]+\.m3u8[^\s"'><\)]*/gi;
      const matches = html.match(m3u8Regex) || [];
      const uniqueLinks = Array.from(new Set(matches.map(link => {
        let cleaned = link.replace(/&amp;/g, '&');
        cleaned = cleaned.split('"')[0].split("'")[0].split(')')[0];
        return cleaned;
      })));

      uniqueLinks.forEach((link, idx) => {
        if (!link.includes('github.com') || link.includes('/raw/')) {
          results.push({
            name: `${query} (AI Web Match #${idx + 1})`,
            logo: '',
            group: 'Web Crawler',
            url: link,
            source: 'DuckDuckGo Search'
          });
        }
      });
    } catch (err) {
      console.error('AI DuckDuckGo fallback search failed:', err.message);
    }
  }

  // Cap results to 30 for performance
  res.json({
    explanation: searchParams.ai_explanation,
    channels: results.slice(0, 30)
  });
});

// Helper function to fetch JSON data from Xtream server with SSL bypass and redirect support
async function fetchXtreamJson(urlStr) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000); // 25s timeout

  try {
    const response = await fetch(urlStr, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Server returned status code ${response.status}`);
    }

    const data = await response.text();
    try {
      return JSON.parse(data);
    } catch (e) {
      if (data.includes('access denied') || data.toLowerCase().includes('authorization failed')) {
        throw new Error('Access Denied: Invalid credentials or account expired.');
      }
      throw new Error('Failed to parse response as JSON. The server might have returned HTML or invalid data.');
    }
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('Connection timed out');
    }
    throw err;
  }
}

// /api/xtream/fetch endpoint to load live, vod, or series
app.post('/api/xtream/fetch', async (req, res) => {
  let { host, username, password, type } = req.body;
  if (!host || !username || !password) {
    return res.status(400).json({ error: 'Missing Host, Username, or Password.' });
  }

  type = type || 'live';

  // Normalize host
  host = host.trim();
  if (!/^https?:\/\//i.test(host)) {
    host = 'http://' + host;
  }
  if (host.endsWith('/')) {
    host = host.slice(0, -1);
  }

  const baseApiUrl = `${host}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  
  let catAction = 'get_live_categories';
  let streamAction = 'get_live_streams';
  let sourceLabel = 'Xtream Live';
  
  if (type === 'movie') {
    catAction = 'get_vod_categories';
    streamAction = 'get_vod_streams';
    sourceLabel = 'Xtream Movie';
  } else if (type === 'series') {
    catAction = 'get_series_categories';
    streamAction = 'get_series';
    sourceLabel = 'Xtream Series';
  }

  const catUrl = `${baseApiUrl}&action=${catAction}`;
  const streamUrl = `${baseApiUrl}&action=${streamAction}`;

  console.log(`Xtream: Fetching ${type} from ${host} for user ${username}`);

  try {
    const [categories, streams] = await Promise.all([
      fetchXtreamJson(catUrl).catch(err => {
        console.warn(`Xtream: Failed to load categories:`, err.message);
        return [];
      }),
      fetchXtreamJson(streamUrl)
    ]);

    if (!Array.isArray(streams)) {
      if (streams && streams.user_info && streams.user_info.auth === 0) {
        return res.status(401).json({ error: 'Authentication failed. Please check your username and password.' });
      }
      return res.status(500).json({ error: 'IPTV server returned an invalid stream list.' });
    }

    const categoryMap = new Map();
    if (Array.isArray(categories)) {
      categories.forEach(cat => {
        if (cat && cat.category_id && cat.category_name) {
          categoryMap.set(String(cat.category_id), cat.category_name);
        }
      });
    }

    const formattedChannels = streams.map(s => {
      const catId = s.category_id ? String(s.category_id) : '0';
      const categoryName = categoryMap.get(catId) || 'Uncategorized';
      
      let playUrl = '';
      if (type === 'live') {
        playUrl = `${host}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${s.stream_id}.ts`;
      } else if (type === 'movie') {
        const ext = s.container_extension || 'mp4';
        playUrl = `${host}/movie/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${s.stream_id}.${ext}`;
      } else if (type === 'series') {
        // Will fetch episodes dynamically when clicked in frontend
        playUrl = `xtream-series://${s.series_id}`;
      }

      return {
        name: s.name || 'Unnamed Stream',
        logo: s.stream_icon || s.cover || '',
        group: categoryName,
        url: playUrl,
        source: sourceLabel,
        isSeries: type === 'series',
        seriesId: s.series_id || null,
        streamId: s.stream_id || null
      };
    });

    res.json(formattedChannels);

  } catch (err) {
    console.error(`Xtream fetch error:`, err.message);
    res.status(500).json({ error: `Failed to fetch from Xtream server: ${err.message}` });
  }
});

// /api/xtream/series-info endpoint to get seasons/episodes
app.post('/api/xtream/series-info', async (req, res) => {
  let { host, username, password, seriesId } = req.body;
  if (!host || !username || !password || !seriesId) {
    return res.status(400).json({ error: 'Missing Host, Username, Password, or Series ID.' });
  }

  host = host.trim();
  if (!/^https?:\/\//i.test(host)) {
    host = 'http://' + host;
  }
  if (host.endsWith('/')) {
    host = host.slice(0, -1);
  }

  const apiUrl = `${host}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_series_info&series_id=${seriesId}`;

  try {
    const data = await fetchXtreamJson(apiUrl);
    const seasons = {};
    if (data && data.episodes) {
      Object.keys(data.episodes).forEach(seasonNum => {
        const episodes = data.episodes[seasonNum] || [];
        seasons[seasonNum] = episodes.map(ep => {
          const ext = ep.container_extension || 'mp4';
          return {
            id: ep.id,
            title: ep.title || `Episode ${ep.episode_num || ep.id}`,
            episodeNum: ep.episode_num,
            url: `${host}/series/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${ep.id}.${ext}`
          };
        });
      });
    }
    
    res.json({
      info: data.info || {},
      seasons: seasons
    });
  } catch (err) {
    console.error(`Xtream series info error:`, err.message);
    res.status(500).json({ error: `Failed to fetch series info: ${err.message}` });
  }
});

// Helper function to stop FFmpeg and clean up files
function cleanupStream(streamUrl) {
  const streamInfo = activeStreams.get(streamUrl);
  if (!streamInfo) return;

  console.log(`Cleaning up stream: ${streamUrl}`);

  try {
    // Kill FFmpeg process
    streamInfo.process.kill('SIGKILL');
  } catch (err) {
    // Ignore if already killed
  }

  // Delete stream directory
  const streamDir = path.join(STREAMS_DIR, streamInfo.id);
  setTimeout(() => {
    try {
      if (fs.existsSync(streamDir)) {
        fs.rmSync(streamDir, { recursive: true, force: true });
        console.log(`Deleted folder for stream ${streamInfo.id}`);
      }
    } catch (err) {
      console.error(`Error deleting stream folder ${streamInfo.id}:`, err.message);
    }
  }, 1000); // Small delay to let files unlock after process kill

  activeStreams.delete(streamUrl);
}

// Cleanup inactive streams periodically (every 10 seconds)
setInterval(() => {
  const now = Date.now();
  const maxInactivity = 60000; // 60 seconds

  for (const [url, streamInfo] of activeStreams.entries()) {
    if (now - streamInfo.lastAccessed > maxInactivity) {
      console.log(`Stream inactive for ${maxInactivity / 1000}s, stopping: ${url}`);
      cleanupStream(url);
    }
  }
}, 10000);

// Start Server
app.listen(PORT, () => {
  console.log(`IPTV Proxy Server running on http://localhost:${PORT}`);
});
