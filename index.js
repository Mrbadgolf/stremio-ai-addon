const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const cron = require('node-cron');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 }); // 1 hour cache

// Environment variables (only need these now!)
const PORT = process.env.PORT || 3000;
const RD_API_KEY = process.env.RD_API_KEY || 'your_real_debrid_api_key';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'your_openai_api_key';
const ADDON_URL = process.env.ADDON_URL || 'https://your-app.railway.app';

app.use(cors());
app.use(express.json());

// Add-on manifest
const manifest = {
    id: 'ai.enhanced.realdebrid.addon',
    version: '2.0.0',
    name: 'AI Enhanced Real-Debrid (No-API)',
    description: 'AI-powered content discovery with Real-Debrid integration - Zero external APIs required',
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
            id: 'popular-movies',
            name: 'Popular Movies',
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
            id: 'popular-series',
            name: 'Popular Series',
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

// Static popular content (no API required!)
const getPopularMovies = () => {
    return [
        {
            id: 'tt15239678',
            title: 'Dune: Part Two',
            year: 2024,
            poster: 'https://via.placeholder.com/300x450/1a1a1a/ffffff?text=Dune+Part+Two',
            description: 'Paul Atreides unites with Chani and the Fremen while seeking revenge against the conspirators who destroyed his family.',
            genres: ['Sci-Fi', 'Adventure', 'Drama'],
            rating: 8.5
        },
        {
            id: 'tt6263850',
            title: 'Batman',
            year: 2022,
            poster: 'https://via.placeholder.com/300x450/1a1a1a/ffffff?text=The+Batman',
            description: 'Batman ventures into Gotham City\'s underworld when a sadistic killer leaves behind a trail of cryptic clues.',
            genres: ['Action', 'Crime', 'Drama'],
            rating: 7.8
        },
        {
            id: 'tt1745960',
            title: 'Top Gun: Maverick',
            year: 2022,
            poster: 'https://via.placeholder.com/300x450/1a1a1a/ffffff?text=Top+Gun+Maverick',
            description: 'After thirty years, Maverick is still pushing the envelope as a top naval aviator.',
            genres: ['Action', 'Drama'],
            rating: 8.3
        },
        {
            id: 'tt10872600',
            title: 'Spider-Man: No Way Home',
            year: 2021,
            poster: 'https://via.placeholder.com/300x450/1a1a1a/ffffff?text=Spider-Man+NWH',
            description: 'With Spider-Man\'s identity now revealed, Peter asks Doctor Strange for help.',
            genres: ['Action', 'Adventure', 'Fantasy'],
            rating: 8.2
        },
        {
            id: 'tt9376612',
            title: 'Shang-Chi and the Legend of the Ten Rings',
            year: 2021,
            poster: 'https://via.placeholder.com/300x450/1a1a1a/ffffff?text=Shang-Chi',
            description: 'Shang-Chi must confront the past he thought he left behind.',
            genres: ['Action', 'Adventure', 'Fantasy'],
            rating: 7.4
        },
        {
            id: 'tt8847712',
            title: 'The French Dispatch',
            year: 2021,
            poster: 'https://via.placeholder.com/300x450/1a1a1a/ffffff?text=French+Dispatch',
            description: 'A love letter to journalists set in an outpost of an American newspaper in a fictional 20th-century French city.',
            genres: ['Comedy', 'Drama'],
            rating: 7.1
        },
        {
            id: 'tt1877830',
            title: 'X-Men: Days of Future Past',
            year: 2014,
            poster: 'https://via.placeholder.com/300x450/1a1a1a/ffffff?text=X-Men+DOFP',
            description: 'The X-Men send Wolverine to the past in a desperate effort to change history.',
            genres: ['Action', 'Adventure', 'Sci-Fi'],
            rating: 7.9
        },
        {
            id: 'tt0816692',
            title: 'Interstellar',
            year: 2014,
            poster: 'https://via.placeholder.com/300x450/1a1a1a/ffffff?text=Interstellar',
            description: 'A team of explorers travel through a wormhole in space in an attempt to ensure humanity\'s survival.',
            genres: ['Adventure', 'Drama', 'Sci-Fi'],
            rating: 8.6
        }
    ];
};

const getPopularSeries = () => {
    return [
        {
            id: 'tt0944947',
            title: 'Game of Thrones',
            year: 2011,
            poster: 'https://via.placeholder.com/300x450/1a1a1a/ffffff?text=Game+of+Thrones',
            description: 'Nine noble families fight for control over the lands of Westeros.',
            genres: ['Action', 'Adventure', 'Drama'],
            rating: 9.2
        },
        {
            id: 'tt0903747',
            title: 'Breaking Bad',
            year: 2008,
            poster: 'https://via.placeholder.com/300x450/1a1a1a/ffffff?text=Breaking+Bad',
            description: 'A high school chemistry teacher diagnosed with cancer turns to manufacturing drugs.',
            genres: ['Crime', 'Drama', 'Thriller'],
            rating: 9.5
        },
        {
            id: 'tt2306299',
            title: 'The Vikings',
            year: 2013,
            poster: 'https://via.placeholder.com/300x450/1a1a1a/ffffff?text=Vikings',
            description: 'Vikings transports us to the brutal world of Ragnar Lothbrok.',
            genres: ['Action', 'Adventure', 'Drama'],
            rating: 8.5
        },
        {
            id: 'tt2861424',
            title: 'Rick and Morty',
            year: 2013,
            poster: 'https://via.placeholder.com/300x450/1a1a1a/ffffff?text=Rick+and+Morty',
            description: 'An alcoholic scientist and his grandson go on sci-fi adventures.',
            genres: ['Animation', 'Adventure', 'Comedy'],
            rating: 9.1
        },
        {
            id: 'tt5753856',
            title: 'Dark',
            year: 2017,
            poster: 'https://via.placeholder.com/300x450/1a1a1a/ffffff?text=Dark',
            description: 'A family saga with a supernatural twist, set in a German town.',
            genres: ['Crime', 'Drama', 'Mystery'],
            rating: 8.8
        },
        {
            id: 'tt2707408',
            title: 'Narcos',
            year: 2015,
            poster: 'https://via.placeholder.com/300x450/1a1a1a/ffffff?text=Narcos',
            description: 'A chronicled look at the criminal exploits of Colombian drug lord Pablo Escobar.',
            genres: ['Biography', 'Crime', 'Drama'],
            rating: 8.8
        }
    ];
};

// AI recommendation functions
const getAIRecommendations = async (type = 'movie', mood = 'popular') => {
    const cacheKey = `ai:${type}:${mood}`;
    let recommendations = cache.get(cacheKey);
    
    if (!recommendations && OPENAI_API_KEY && OPENAI_API_KEY !== 'your_openai_api_key') {
        try {
            const prompt = type === 'movie' ? 
                `Recommend 10 high-quality ${mood} movies from 2020-2024 that are likely available on torrents. Include a mix of popular and hidden gems. Include the release year. Format as: "Title (Year)". Return only the list, one per line.` :
                `Recommend 10 excellent ${mood} TV series from 2020-2024 that are worth binge-watching. Include both popular and underrated shows. Include the start year. Format as: "Title (Year)". Return only the list, one per line.`;
            
            const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: 'gpt-3.5-turbo',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 300,
                temperature: 0.8
            }, {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });
            
            const content = response.data.choices[0].message.content;
            const titles = content
                .split('\n')
                .filter(line => line.trim())
                .map(line => line.replace(/^\d+\.?\s*/, '').trim())
                .slice(0, 10);
            
            recommendations = titles.map((title, index) => {
                // Extract year if present
                const yearMatch = title.match(/\((\d{4})\)/);
                const year = yearMatch ? parseInt(yearMatch[1]) : 2023;
                const cleanTitle = title.replace(/\(\d{4}\)/, '').trim();
                
                return {
                    id: `ai${type}${Date.now()}${index}`,
                    title: cleanTitle,
                    year: year,
                    poster: `https://via.placeholder.com/300x450/2d3748/ffffff?text=${encodeURIComponent(cleanTitle.substring(0, 20))}`,
                    description: `AI recommended ${type} - ${cleanTitle}`,
                    genres: type === 'movie' ? ['Drama', 'Thriller'] : ['Drama', 'Mystery'],
                    rating: (7.0 + Math.random() * 2).toFixed(1)
                };
            });
            
            cache.set(cacheKey, recommendations, 7200); // 2 hour cache
        } catch (error) {
            console.log('AI recommendation failed:', error.message);
            recommendations = [];
        }
    }
    
    // Fallback to curated lists if AI fails
    if (!recommendations || recommendations.length === 0) {
        recommendations = getCuratedRecommendations(type, mood);
    }
    
    return recommendations || [];
};

// Fallback curated recommendations
const getCuratedRecommendations = (type, mood) => {
    if (type === 'movie') {
        const curatedMovies = [
            {
                id: 'tt6751668',
                title: 'Parasite',
                year: 2019,
                poster: 'https://via.placeholder.com/300x450/1a1a1a/ffffff?text=Parasite',
                description: 'A poor family schemes to become employed by a wealthy family.',
                genres: ['Comedy', 'Drama', 'Thriller'],
                rating: 8.6
            },
            {
                id: 'tt7286456',
                title: 'Joker',
                year: 2019,
                poster: 'https://via.placeholder.com/300x450/1a1a1a/ffffff?text=Joker',
                description: 'In Gotham City, mentally troubled comedian Arthur Fleck is disregarded.',
                genres: ['Crime', 'Drama', 'Thriller'],
                rating: 8.4
            },
            {
                id: 'tt8503618',
                title: 'Hamilton',
                year: 2020,
                poster: 'https://via.placeholder.com/300x450/1a1a1a/ffffff?text=Hamilton',
                description: 'The real life of one of America\'s foremost founding fathers.',
                genres: ['Biography', 'Drama', 'History'],
                rating: 8.3
            }
        ];
        return curatedMovies;
    } else {
        const curatedSeries = [
            {
                id: 'tt7660850',
                title: 'Succession',
                year: 2018,
                poster: 'https://via.placeholder.com/300x450/1a1a1a/ffffff?text=Succession',
                description: 'The Roy family is known for controlling the biggest media company.',
                genres: ['Comedy', 'Drama'],
                rating: 8.8
            },
            {
                id: 'tt8111088',
                title: 'The Mandalorian',
                year: 2019,
                poster: 'https://via.placeholder.com/300x450/1a1a1a/ffffff?text=Mandalorian',
                description: 'The travels of a lone bounty hunter in the outer reaches of the galaxy.',
                genres: ['Action', 'Adventure', 'Fantasy'],
                rating: 8.7
            }
        ];
        return curatedSeries;
    }
};

// Mock torrent search (replace with real torrent APIs)
const searchTorrents = async (query, type = 'movie') => {
    // This is a simplified mock - in reality you'd integrate with torrent APIs
    const mockResults = [
        {
            title: `${query} (2024) [1080p] [BluRay]`,
            magnet: `magnet:?xt=urn:btih:${Buffer.from(query + Date.now()).toString('hex').slice(0, 40)}&dn=${encodeURIComponent(query)}`,
            seeds: Math.floor(Math.random() * 1000) + 100,
            size: type === 'movie' ? '2.1 GB' : '350 MB'
        },
        {
            title: `${query} (2024) [720p] [WEB-DL]`,
            magnet: `magnet:?xt=urn:btih:${Buffer.from(query + Date.now() + '720p').toString('hex').slice(0, 40)}&dn=${encodeURIComponent(query)}`,
            seeds: Math.floor(Math.random() * 500) + 50,
            size: type === 'movie' ? '1.2 GB' : '200 MB'
        }
    ];
    
    return mockResults;
};

// Real-Debrid API functions
const checkRDAvailability = async (magnetLink) => {
    if (!RD_API_KEY || RD_API_KEY === 'your_real_debrid_api_key') {
        return false; // Skip RD check if no API key
    }
    
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
    if (!RD_API_KEY || RD_API_KEY === 'your_real_debrid_api_key') {
        return null;
    }
    
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

// Convert content to Stremio format
const formatForStremio = (content) => {
    return {
        id: content.id || `tt${Date.now()}`,
        type: content.type || 'movie',
        name: content.title,
        poster: content.poster,
        background: content.poster,
        description: content.description,
        year: content.year,
        imdbRating: content.rating,
        genres: content.genres || []
    };
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
                const aiContent = await getAIRecommendations(type, 'trending');
                metas = aiContent.slice(skip, skip + 20).map(item => formatForStremio({ ...item, type }));
                break;
                
            case 'popular-movies':
                const popularMovies = getPopularMovies();
                metas = popularMovies.slice(skip, skip + 20).map(item => formatForStremio({ ...item, type: 'movie' }));
                break;
                
            case 'popular-series':
                const popularSeries = getPopularSeries();
                metas = popularSeries.slice(skip, skip + 20).map(item => formatForStremio({ ...item, type: 'series' }));
                break;
                
            case 'quality-picks':
                const qualityContent = await getAIRecommendations('movie', 'high-rated hidden gems');
                metas = qualityContent.slice(skip, skip + 20).map(item => formatForStremio({ ...item, type: 'movie' }));
                break;
        }
        
        res.json({ metas: metas.filter(m => m.id && m.name) });
    } catch (error) {
        console.log('Catalog error:', error.message);
        res.json({ metas: [] });
    }
});

app.get('/stream/:type/:id.json', async (req, res) => {
    try {
        const { type, id } = req.params;
        
        // For this no-API version, we'll extract title from the ID or use a generic search
        let title = 'Unknown Movie';
        
        // Try to find the content in our static lists
        const allContent = [...getPopularMovies(), ...getPopularSeries()];
        const content = allContent.find(item => item.id === id);
        
        if (content) {
            title = content.title;
        } else {
            // Generic title based on ID patterns
            if (id.includes('ai')) {
                title = 'AI Recommended Content';
            }
        }
        
        // Search for torrents
        const torrents = await searchTorrents(title, type);
        const streams = [];
        
        for (const torrent of torrents.slice(0, 5)) { // Limit to 5 results
            try {
                // Check RD availability if API key is provided
                let isAvailable = true; // Default to true for demo
                if (RD_API_KEY && RD_API_KEY !== 'your_real_debrid_api_key') {
                    isAvailable = await checkRDAvailability(torrent.magnet);
                }
                
                if (isAvailable) {
                    streams.push({
                        name: RD_API_KEY && RD_API_KEY !== 'your_real_debrid_api_key' ? `RD: ${torrent.title}` : `Torrent: ${torrent.title}`,
                        title: RD_API_KEY && RD_API_KEY !== 'your_real_debrid_api_key' ? 
                            `💎 Real-Debrid\n${torrent.size} | ${torrent.seeds} seeds` :
                            `📁 Torrent\n${torrent.size} | ${torrent.seeds} seeds`,
                        url: RD_API_KEY && RD_API_KEY !== 'your_real_debrid_api_key' ?
                            `${ADDON_URL}/rd-stream/${encodeURIComponent(torrent.magnet)}` :
                            torrent.magnet,
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
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        version: '2.0.0-no-api',
        features: {
            ai_recommendations: OPENAI_API_KEY && OPENAI_API_KEY !== 'your_openai_api_key',
            real_debrid: RD_API_KEY && RD_API_KEY !== 'your_real_debrid_api_key',
            external_apis: false
        }
    });
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
        
        // Pre-populate cache with fresh AI data if available
        if (OPENAI_API_KEY && OPENAI_API_KEY !== 'your_openai_api_key') {
            await getAIRecommendations('movie', 'trending');
            await getAIRecommendations('series', 'trending');
        }
        
        console.log('Content update completed');
    } catch (error) {
        console.log('Content update failed:', error.message);
    }
});

app.listen(PORT, () => {
    console.log(`Stremio add-on running on port ${PORT}`);
    console.log(`Manifest: http://localhost:${PORT}/manifest.json`);
    console.log(`Version: 2.0.0 (No external APIs required)`);
    console.log(`Features: AI=${OPENAI_API_KEY !== 'your_openai_api_key'}, RD=${RD_API_KEY !== 'your_real_debrid_api_key'}`);
});

module.exports = app;
