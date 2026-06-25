# 📺 SONO Player

A self-hosted IPTV player with live stream transcoding, AI-powered channel search, and favorites management.

**Live App:** [sono-iptv.vercel.app](https://sono-iptv.vercel.app) &nbsp;|&nbsp; **Backend:** hosted on Railway/Render

---

## ✨ Features

- 📋 **M3U Playlist** — paste raw M3U data or load from a URL
- 🔍 **Internet Search** — crawls the IPTV-org registry + web for live streams
- 🤖 **AI Search** — Gemini-powered natural language channel discovery
- ⭐ **Favorites** — star channels, filter by category, badge count
- 🎚️ **Quality Selector** — Auto / 720p / 480p / 360p / 240p to reduce lag
- 🔄 **FFmpeg Proxy** — transcodes any HLS/MP4 stream to browser-compatible format

---

## 🏗️ Architecture

```
┌─────────────────────┐        ┌────────────────────────────┐
│   Vercel (frontend) │──────▶│  Railway/Render (backend)  │
│   public/index.html │        │  server.js + FFmpeg        │
│   Static HTML/JS    │◀──────│  /stream  /playlist  /api  │
└─────────────────────┘        └────────────────────────────┘
```

> **Why split?** Vercel is serverless — it can't run long-lived FFmpeg transcoding processes. The backend needs a persistent server environment.

---

## 🚀 Deployment

### Step 1 — Deploy the Backend (Railway recommended)

1. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**
2. Select `Amrsono/Sono.IPTV`
3. Railway detects `nixpacks.toml` and installs FFmpeg automatically
4. Add environment variable: `GEMINI_API_KEY=your_key_here` (optional)
5. Copy your Railway public URL (e.g. `https://sono-iptv-backend.up.railway.app`)

**Alternative: Render**
1. Go to [render.com](https://render.com) → **New Web Service → Connect GitHub**
2. Select `Amrsono/Sono.IPTV` — Render uses the `Dockerfile` automatically
3. Add `GEMINI_API_KEY` in Environment Variables

---

### Step 2 — Update `vercel.json` with your backend URL

Open `vercel.json` and replace every `REPLACE_WITH_YOUR_BACKEND_URL` with your actual backend URL:

```json
{ "source": "/stream", "destination": "https://sono-iptv-backend.up.railway.app/stream" }
```

Commit and push the change.

---

### Step 3 — Deploy the Frontend to Vercel

1. Go to [vercel.com](https://vercel.com) → **New Project → Import from GitHub**
2. Select `Amrsono/Sono.IPTV`
3. Set **Output Directory** to `public`
4. Set **Build Command** to _(empty)_
5. Click **Deploy**

Vercel will serve `public/index.html` and automatically rewrite all `/stream`, `/api/*`, etc. calls to your backend.

---

## 💻 Local Development

```bash
# Clone
git clone https://github.com/Amrsono/Sono.IPTV.git
cd Sono.IPTV

# Install
npm install

# Run
npm start
# → http://localhost:3000
```

**Requirements:**
- Node.js 18+
- FFmpeg installed and on your `PATH` ([ffmpeg.org/download](https://ffmpeg.org/download.html))

---

## 🔑 Environment Variables

| Variable | Description | Required |
|---|---|---|
| `PORT` | Server port (default: 3000) | No |
| `GEMINI_API_KEY` | Google Gemini API key for AI search | No |

Copy `.env.example` → `.env` for local config.

---

## 📁 Project Structure

```
Sono.IPTV/
├── public/
│   └── index.html        # Full frontend (single-page app)
├── server.js             # Express backend + FFmpeg proxy
├── Dockerfile            # For Railway/Render Docker deploy
├── nixpacks.toml         # For Railway Nixpacks deploy (FFmpeg)
├── render.yaml           # For Render.com one-click deploy
├── vercel.json           # For Vercel frontend + API rewrites
├── .env.example          # Environment variable template
└── package.json
```
