const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const cron = require('node-cron');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 }); // 1 hour cache

// Environment variables (set these in your hosting platform)
const PORT = process.env.PORT || 3000;
const TMDB_API_KEY = process.env.TMDB_API_KEY || 'your_tmdb_api_key';
const RD_API_KEY = process.env.RD_API_KEY || 'your_real_debrid_api_key';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'your_openai_api_key';
const ADDON_URL = process.env.ADDON_URL || 'https://your-app.railway.app';

app.use(cors());
app.use(express.json());

// Add-on manifest
const manifest = {
    id: 'ai.enhanced.realdebrid.addon',
    version: '1.0.0',
    name: 'AI Enhanced Real-Debrid',
    description: 'Smart content discovery with Real-Debrid integration and AI recommendations',
    logo: 'https://via.placeholder.com/256x256/000000/FFFFFF/?text=AI+RD',
    resources: ['catalog', 'stream'],
    types: ['movie', 'series'],
    catalogs: [
        {
            type: 'movie',
            id: 'ai-recommendations',
            name: 'AI Recommended Movies',
            extra: [{ name: 'skip', isRequired: false }]
        },
        {
            type: 'movie',
            id: 'trending-movies',
            name: 'Trending Movies',
            extra: [{ name: 'skip', isRequired: false }]
        },
        {
            type: 'series',
            id: 'ai-recommendations',
            name: 'AI Recommended Series',
            extra: [{ name: 'skip', isRequired: false }]
        },
        {
            type: 'series',
            id: 'trending-series',
            name: 'Trending Series',
            extra: [{ name: 'skip', isRequired: false }]
        },
        {
            type: 'movie',
            id: 'quality-picks',
            name: 'Quality Picks (AI Curated)',
            extra: [{ name: 'skip', isRequired: false }]
        }
    ],
    idPrefixes: ['tt']
};

// Utility functions
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const makeRequest = async (url, headers = {}, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await axios.get(url, { headers, timeout: 10000 });
            return response.data;
        } catch (error) {
            console.log(`Request failed (attempt ${i + 1}):`, error.message);
            if (i === retries - 1) throw error;
            await sleep(1000 * (i + 1));
        }
    }
};

// TMDB API functions
const getTMDBData = async (endpoint) => {
    const cacheKey = `tmdb:${endpoint}`;
    let data = cache.get(cacheKey);
    
    if (!data) {
        const url = `https://api.themoviedb.org/3/${endpoint}?api_key=${TMDB_API_KEY}`;
        data = await makeRequest(url);
        cache.set(cacheKey, data, 1800); // 30 min cache
    }
    
    return data;
};

const searchTMDB = async (query, type = 'multi') => {
    const endpoint = `search/${type}?query=${encodeURIComponent(query)}`;
    return await getTMDBData(endpoint);
};

// Real-Debrid API functions
const checkRDAvailability = async (magnetLink) => {
    try {
        const response = await axios.get('https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/' + 
            encodeURIComponent(magnetLink), {
            headers: { 'Authorization': `Bearer ${RD_API_KEY}` },
            timeout: 5000
        });
        return Object.keys(response.data).length > 0;
    } catch (error) {
        console.log('RD availability check failed:', error.message);
        return false;
    }
};

const getRDStreamLink = async (magnetLink) => {
    try {
        // Add magnet to RD
        const addResponse = await axios.post('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', 
            `magnet=${encodeURIComponent(magnetLink)}`, {
            headers: {
                'Authorization': `Bearer ${RD_API_KEY}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        const torrentId = addResponse.data.id;
        
        // Select files (automatically select largest video file)
        await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, 
            'files=all', {
            headers: {
                'Authorization': `Bearer ${RD_API_KEY}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        // Get torrent info and download link
        const infoResponse = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, {
            headers: { 'Authorization': `Bearer ${RD_API_KEY}` }
        });

        if (infoResponse.data.status === 'downloaded' && infoResponse.data.links.length > 0) {
            const unlockResponse = await axios.post('https://api.real-debrid.com/rest/1.0/unrestrict/link',
                `link=${encodeURIComponent(infoResponse.data.links[0])}`, {
                headers: {
                    'Authorization': `Bearer ${RD_API_KEY}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });
            
            return unlockResponse.data.download;
        }
        
        return null;
    } catch (error) {
        console.log('RD stream generation failed:', error.message);
        return null;
    }
};

// AI recommendation functions
const getAIRecommendations = async (type = 'movie', mood = 'popular') => {
    const cacheKey = `ai:${type}:${mood}`;
    let recommendations = cache.get(cacheKey);
    
    if (!recommendations && OPENAI_API_KEY && OPENAI_API_KEY !== 'your_openai_api_key') {
        try {
            const prompt = type === 'movie' ? 
                `Recommend 10 high-quality ${mood} movies from 2020-2024 that are likely available on torrents. Include a mix of popular and hidden gems. Return only movie titles, one per line.` :
                `Recommend 10 excellent ${mood} TV series from 2020-2024 that are worth binge-watching. Include both popular and underrated shows. Return only series titles, one per line.`;
            
            const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: 'gpt-3.5-turbo',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 200,
                temperature: 0.8
            }, {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });
            
            const titles = response.data.choices[0].message.content
                .split('\n')
                .filter(line => line.trim())
                .map(line => line.replace(/^\d+\.?\s*/, '').trim())
                .slice(0, 10);
            
            recommendations = titles;
            cache.set(cacheKey, recommendations, 7200); // 2 hour cache
        } catch (error) {
            console.log('AI recommendation failed:', error.message);
            recommendations = [];
        }
    }
    
    return recommendations || [];
};

// Mock torrent search (replace with real torrent APIs)
const searchTorrents = async (query, type = 'movie') => {
    // This is a simplified mock - in reality you'd integrate with torrent APIs
    // Popular free APIs: 1337x, RARBG alternatives, etc.
    const mockResults = [
        {
            title: `${query} (2024) [1080p]`,
            magnet: `magnet:?xt=urn:btih:${Buffer.from(query).toString('hex').slice(0, 40)}&dn=${encodeURIComponent(query)}`,
            seeds: Math.floor(Math.random() * 1000) + 100,
            size: '2.1 GB'
        }
    ];
    
    return mockResults;
};

// Convert content to Stremio format
const formatForStremio = async (content, type) => {
    const formatted = {
        id: content.imdb_id || `tt${content.id}`,
        type: type,
        name: content.title || content.name,
        poster: content.poster_path ? `https://image.tmdb.org/t/p/w500${content.poster_path}` : null,
        background: content.backdrop_path ? `https://image.tmdb.org/t/p/w1280${content.backdrop_path}` : null,
        description: content.overview,
        year: content.release_date ? new Date(content.release_date).getFullYear() : 
              content.first_air_date ? new Date(content.first_air_date).getFullYear() : null,
        imdbRating: content.vote_average,
        genres: content.genres ? content.genres.map(g => g.name) : []
    };
    
    return formatted;
};

// Routes
app.get('/', (req, res) => {
    res.json(manifest);
});

app.get('/manifest.json', (req, res) => {
    res.json(manifest);
});

app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
    try {
        const { type, id } = req.params;
        const skip = parseInt(req.query.skip) || 0;
        let metas = [];
        
        switch (id) {
            case 'ai-recommendations':
                const aiTitles = await getAIRecommendations(type, 'trending');
                for (const title of aiTitles.slice(skip, skip + 20)) {
                    try {
                        const searchResult = await searchTMDB(title, type);
                        if (searchResult.results && searchResult.results.length > 0) {
                            const formatted = await formatForStremio(searchResult.results[0], type);
                            metas.push(formatted);
                        }
                    } catch (error) {
                        console.log(`Failed to process AI recommendation: ${title}`);
                    }
                }
                break;
                
            case 'trending-movies':
                const trending = await getTMDBData(`trending/movie/week`);
                for (const movie of trending.results.slice(skip, skip + 20)) {
                    metas.push(await formatForStremio(movie, 'movie'));
                }
                break;
                
            case 'trending-series':
                const trendingSeries = await getTMDBData(`trending/tv/week`);
                for (const series of trendingSeries.results.slice(skip, skip + 20)) {
                    metas.push(await formatForStremio(series, 'series'));
                }
                break;
                
            case 'quality-picks':
                const qualityTitles = await getAIRecommendations('movie', 'high-rated hidden gems');
                for (const title of qualityTitles.slice(skip, skip + 20)) {
                    try {
                        const searchResult = await searchTMDB(title, 'movie');
                        if (searchResult.results && searchResult.results.length > 0) {
                            const formatted = await formatForStremio(searchResult.results[0], 'movie');
                            metas.push(formatted);
                        }
                    } catch (error) {
                        console.log(`Failed to process quality pick: ${title}`);
                    }
                }
                break;
        }
        
        res.json({ metas: metas.filter(m => m.id) });
    } catch (error) {
        console.log('Catalog error:', error.message);
        res.json({ metas: [] });
    }
});

app.get('/stream/:type/:id.json', async (req, res) => {
    try {
        const { type, id } = req.params;
        
        // Get TMDB details for the content
        let tmdbData;
        if (id.startsWith('tt')) {
            // IMDB ID - need to find via external_ids
            const findResult = await getTMDBData(`find/${id}?external_source=imdb_id`);
            tmdbData = findResult.movie_results[0] || findResult.tv_results[0];
        } else {
            tmdbData = await getTMDBData(`${type}/${id}`);
        }
        
        if (!tmdbData) {
            return res.json({ streams: [] });
        }
        
        const title = tmdbData.title || tmdbData.name;
        const year = tmdbData.release_date ? new Date(tmdbData.release_date).getFullYear() : 
                    tmdbData.first_air_date ? new Date(tmdbData.first_air_date).getFullYear() : '';
        
        // Search for torrents
        const searchQuery = `${title} ${year}`;
        const torrents = await searchTorrents(searchQuery, type);
        
        const streams = [];
        
        for (const torrent of torrents.slice(0, 5)) { // Limit to 5 results
            try {
                // Check RD availability
                const isAvailable = await checkRDAvailability(torrent.magnet);
                
                if (isAvailable) {
                    streams.push({
                        name: `RD: ${torrent.title}`,
                        title: `💎 Real-Debrid\n${torrent.size} | ${torrent.seeds} seeds`,
                        url: `${ADDON_URL}/rd-stream/${encodeURIComponent(torrent.magnet)}`,
                        behaviorHints: {
                            notWebReady: true
                        }
                    });
                }
            } catch (error) {
                console.log('Stream processing error:', error.message);
            }
        }
        
        res.json({ streams });
    } catch (error) {
        console.log('Stream error:', error.message);
        res.json({ streams: [] });
    }
});

// Real-Debrid stream endpoint
app.get('/rd-stream/:magnet', async (req, res) => {
    try {
        const magnetLink = decodeURIComponent(req.params.magnet);
        const streamUrl = await getRDStreamLink(magnetLink);
        
        if (streamUrl) {
            res.redirect(streamUrl);
        } else {
            res.status(404).send('Stream not available');
        }
    } catch (error) {
        console.log('RD stream error:', error.message);
        res.status(500).send('Stream generation failed');
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Automated content updates (runs every 6 hours)
cron.schedule('0 */6 * * *', async () => {
    console.log('Running automated content update...');
    try {
        // Clear AI recommendations cache to force refresh
        const keys = cache.keys();
        keys.forEach(key => {
            if (key.startsWith('ai:')) {
                cache.del(key);
            }
        });
        
        // Pre-populate cache with fresh data
        await getAIRecommendations('movie', 'trending');
        await getAIRecommendations('series', 'trending');
        await getTMDBData('trending/movie/week');
        await getTMDBData('trending/tv/week');
        
        console.log('Content update completed');
    } catch (error) {
        console.log('Content update failed:', error.message);
    }
});

app.listen(PORT, () => {
    console.log(`Stremio add-on running on port ${PORT}`);
    console.log(`Manifest: http://localhost:${PORT}/manifest.json`);
});

module.exports = app;
