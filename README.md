# Stremio AI Real-Debrid Add-on

AI-powered Stremio add-on with Real-Debrid integration for smart content discovery.

## Features

- 🤖 AI-powered content recommendations using ChatGPT
- 💎 Real-Debrid premium streaming integration
- 🔄 Automatic content updates every 6 hours
- 📱 Multiple content catalogs (trending, AI picks, quality selections)
- ⚡ Smart caching for fast performance
- 🛡️ Error handling and graceful fallbacks

## Quick Deploy

### Railway (Recommended)
1. Fork this repository
2. Connect to Railway
3. Set environment variables:
   - `TMDB_API_KEY`: Your TMDB API key
   - `RD_API_KEY`: Your Real-Debrid API token
   - `OPENAI_API_KEY`: Your OpenAI API key (optional)
   - `ADDON_URL`: Your Railway app URL

### Environment Variables Required

```env
TMDB_API_KEY=your_tmdb_api_key_here
RD_API_KEY=your_real_debrid_token_here
OPENAI_API_KEY=your_openai_api_key_here
ADDON_URL=https://your-app-name.railway.app
