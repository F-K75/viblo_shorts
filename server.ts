import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);

app.use(cors());
app.use(express.json());

// High quality vertical stock video collection for instant preview / offline fallback
const FALLBACK_VERTICAL_VIDEOS = [
  {
    keywords: ['laptop', 'code', 'typing', 'study', 'work', 'desk', 'computer'],
    url: 'https://assets.mixkit.co/videos/preview/mixkit-vertical-shot-of-a-person-typing-on-a-laptop-42994-large.mp4',
    thumbnail: 'https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=600&auto=format&fit=crop&q=80',
    duration: 12,
  },
  {
    keywords: ['timer', 'clock', 'alarm', 'habit', 'morning', 'wake', 'time'],
    url: 'https://assets.mixkit.co/videos/preview/mixkit-close-up-of-an-alarm-clock-ringing-50952-large.mp4',
    thumbnail: 'https://images.unsplash.com/photo-1509114397022-ed747cca3f65?w=600&auto=format&fit=crop&q=80',
    duration: 8,
  },
  {
    keywords: ['coffee', 'focus', 'morning', 'cup', 'drink', 'desk', 'tea'],
    url: 'https://assets.mixkit.co/videos/preview/mixkit-steaming-coffee-cup-in-the-morning-light-42525-large.mp4',
    thumbnail: 'https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=600&auto=format&fit=crop&q=80',
    duration: 10,
  },
  {
    keywords: ['city', 'walking', 'street', 'night', 'lights', 'travel', 'commute'],
    url: 'https://assets.mixkit.co/videos/preview/mixkit-vertical-view-of-a-woman-walking-down-a-city-street-41712-large.mp4',
    thumbnail: 'https://images.unsplash.com/photo-1519501025264-65ba15a82390?w=600&auto=format&fit=crop&q=80',
    duration: 14,
  },
  {
    keywords: ['gym', 'workout', 'fitness', 'exercise', 'weights', 'training', 'running'],
    url: 'https://assets.mixkit.co/videos/preview/mixkit-vertical-shot-of-a-man-lifting-weights-in-a-gym-42618-large.mp4',
    thumbnail: 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=600&auto=format&fit=crop&q=80',
    duration: 9,
  },
  {
    keywords: ['phone', 'scroll', 'screen', 'social', 'app', 'mobile', 'hands'],
    url: 'https://assets.mixkit.co/videos/preview/mixkit-hands-of-a-person-holding-a-smartphone-vertical-shot-42995-large.mp4',
    thumbnail: 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=600&auto=format&fit=crop&q=80',
    duration: 11,
  },
  {
    keywords: ['reading', 'book', 'pages', 'notes', 'journal', 'library', 'write'],
    url: 'https://assets.mixkit.co/videos/preview/mixkit-vertical-shot-of-a-person-turning-the-page-of-a-book-43003-large.mp4',
    thumbnail: 'https://images.unsplash.com/photo-1497633762265-9d179a990aa6?w=600&auto=format&fit=crop&q=80',
    duration: 10,
  },
  {
    keywords: ['nature', 'forest', 'trees', 'sunlight', 'outdoors', 'sky', 'calm'],
    url: 'https://assets.mixkit.co/videos/preview/mixkit-sunbeams-shining-through-forest-trees-vertical-41711-large.mp4',
    thumbnail: 'https://images.unsplash.com/photo-1448375240586-882707db888b?w=600&auto=format&fit=crop&q=80',
    duration: 15,
  }
];

// Fallback script templates if no AI key configured
const FALLBACK_SCRIPTS: Record<string, any> = {
  productivity: {
    hook: "Most people ruin their entire day within the first 10 minutes of waking up.",
    title: "5 Habits That Actually Double Your Output #shorts",
    description: "Stop falling into the productivity trap. These 5 evidence-backed micro-habits will transform your workflow.",
    hashtags: ["#shorts", "#productivity", "#habits", "#selfimprovement", "#focus"],
    beats: [
      {
        text: "Most people ruin their entire day within the first 10 minutes of waking up.",
        visual_keywords: "person waking up alarm clock morning"
      },
      {
        text: "The moment you check notifications, your brain switches to reactive panic mode.",
        visual_keywords: "hands scrolling phone screen notification"
      },
      {
        text: "Instead, try the 10-3-2-1 rule: No phone for 10 minutes, 3 big priorities identified.",
        visual_keywords: "writing notes journal desk coffee"
      },
      {
        text: "Next, work in strict 45-minute sprint blocks with zero browser tabs open.",
        visual_keywords: "person typing laptop focused work night"
      },
      {
        text: "Stop multitasking. Every switch drains 20% of your cognitive energy.",
        visual_keywords: "clock ticking fast time lapse"
      },
      {
        text: "Master your morning, and the rest of the day takes care of itself.",
        visual_keywords: "city skyline sunrise person walking confident"
      }
    ]
  }
};

const SYSTEM_PROMPT = `You write scripts for viral YouTube Shorts (vertical, 30-58 seconds).
You always respond with ONLY a single valid JSON object, no markdown fences, no commentary.

JSON shape:
{
  "hook": "<first spoken line, <=12 words, must create curiosity or tension>",
  "beats": [
    {"text": "<one sentence or short clause of voiceover>", "visual_keywords": "<2-4 word stock-footage search query matching this beat>"}
  ],
  "title": "<YouTube title, <=60 chars, punchy>",
  "description": "<1-2 sentence YouTube description>",
  "hashtags": ["#tag1", "#tag2", "#tag3"]
}

Rules:
- The hook IS the first beat's text as well — do not duplicate it separately in the spoken flow, just make beats[0].text equal to the hook.
- Total spoken words across all beats must be between 75 and 130 (fits ~30-50s at natural speaking pace).
- Total beats must be between 4 and 7 beats.
- Each beat is short (6-15 words) so it maps to one punchy visual clip.
- visual_keywords must describe a concrete, filmable, stock-footage-searchable scene (e.g. "person typing laptop night", "city skyline sunrise drone", "alarm clock ringing", "coffee cup steam morning") — never abstract ("success", "growth").
- No emojis in spoken text. Hashtags must include YouTube Shorts-relevant tags plus 2 topic-specific ones.`;

// Server info endpoint
app.get('/api/config', (req, res) => {
  res.json({
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
    hasPexelsKey: Boolean(process.env.PEXELS_API_KEY),
    defaultVoice: process.env.TTS_VOICE || 'en-US-GuyNeural',
  });
});

// Script generator endpoint
app.post('/api/generate-script', async (req, res) => {
  const { topic, audience = 'general YouTube audience', tone = 'energetic, direct, no fluff' } = req.body;

  if (!topic || typeof topic !== 'string') {
    return res.status(400).json({ error: 'Topic is required' });
  }

  const userPrompt = `Topic / idea: ${topic}\nTarget audience: ${audience}\nTone: ${tone}\n\nWrite the Short script now, as the exact JSON object described.`;

  // 1. Try Gemini API first if key is present
  if (process.env.GEMINI_API_KEY) {
    try {
      const ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: userPrompt,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              hook: { type: Type.STRING, description: 'First spoken line, <=12 words' },
              title: { type: Type.STRING, description: 'YouTube Shorts title <=60 chars' },
              description: { type: Type.STRING, description: 'Short description for YouTube' },
              hashtags: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: '3-5 hashtags'
              },
              beats: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    text: { type: Type.STRING, description: 'Voiceover text for beat' },
                    visual_keywords: { type: Type.STRING, description: '2-4 words concrete stock video query' }
                  },
                  required: ['text', 'visual_keywords']
                }
              }
            },
            required: ['hook', 'beats', 'title', 'description', 'hashtags']
          }
        },
      });

      const text = response.text;
      if (text) {
        const parsed = JSON.parse(text);
        if (parsed.beats && parsed.beats.length > 0) {
          return res.json(parsed);
        }
      }
    } catch (err: any) {
      console.warn('Gemini script generation failed, checking alternatives:', err?.message || err);
    }
  }

  // 2. Try Anthropic if key is present
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg = await anthropic.messages.create({
        model: process.env.SCRIPT_MODEL || 'claude-3-5-sonnet-20241022',
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const raw = msg.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('');

      const cleanJson = raw.replace(/^```(json)?/m, '').replace(/```$/m, '').trim();
      const parsed = JSON.parse(cleanJson);
      if (parsed.beats && parsed.beats.length > 0) {
        return res.json(parsed);
      }
    } catch (err: any) {
      console.warn('Anthropic script generation failed:', err?.message || err);
    }
  }

  // 3. High quality tailored fallback for instant demo
  const topicLower = topic.toLowerCase();
  let baseTemplate = FALLBACK_SCRIPTS.productivity;

  const beats = [
    {
      text: `Here is the brutal truth about ${topic.slice(0, 35)} that nobody talks about.`,
      visual_keywords: 'person looking serious city street'
    },
    {
      text: 'Most people spend months preparing, waiting for the perfect timing or motivation.',
      visual_keywords: 'clock ticking desk night laptop'
    },
    {
      text: 'The secret is aggressive simplicity: focus on just one daily high-leverage action.',
      visual_keywords: 'person writing notes notebook focused'
    },
    {
      text: 'Track your streak publicly, remove distractions, and don’t look back.',
      visual_keywords: 'person walking sunrise morning confident'
    },
    {
      text: `Start today with ${topic.slice(0, 25)}. Consistency beats perfection every single time.`,
      visual_keywords: 'city skyline drone sunset forward'
    }
  ];

  return res.json({
    hook: beats[0].text,
    beats,
    title: `${topic.slice(0, 45)}: What Nobody Tells You #shorts`,
    description: `The unfiltered reality about ${topic}. Learn how to take action and build real momentum starting today.`,
    hashtags: ['#shorts', '#viral', '#motivation', '#selfimprovement', '#mindset']
  });
});

// Stock footage fetcher / search endpoint
app.post('/api/stock-footage', async (req, res) => {
  const { query, orientation = 'portrait' } = req.body;

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Query is required' });
  }

  // 1. If Pexels API key is configured, search real Pexels stock video library
  if (process.env.PEXELS_API_KEY) {
    try {
      const pexelsUrl = new URL('https://api.pexels.com/videos/search');
      pexelsUrl.searchParams.set('query', query);
      pexelsUrl.searchParams.set('orientation', orientation);
      pexelsUrl.searchParams.set('per_page', '8');

      const resp = await fetch(pexelsUrl.toString(), {
        headers: {
          Authorization: process.env.PEXELS_API_KEY,
        },
      });

      if (resp.ok) {
        const data = await resp.json();
        const videos = data.videos || [];

        if (videos.length > 0) {
          const results = videos.map((v: any) => {
            // Find best portrait or HD video file
            const files = v.video_files || [];
            const portrait = files.find((f: any) => f.height > f.width && f.quality === 'hd') ||
                           files.find((f: any) => f.height > f.width) ||
                           files.find((f: any) => f.quality === 'hd') ||
                           files[0];

            return {
              id: v.id,
              url: portrait?.link || files[0]?.link,
              thumbnail: v.image,
              duration: v.duration,
              width: portrait?.width,
              height: portrait?.height,
              user: v.user?.name,
            };
          }).filter((v: any) => Boolean(v.url));

          if (results.length > 0) {
            return res.json({ results, source: 'pexels' });
          }
        }
      }
    } catch (err: any) {
      console.warn('Pexels API fetch failed:', err?.message || err);
    }
  }

  // 2. Curated royalty-free vertical video fallback matched to visual keywords
  const qTokens = query.toLowerCase().split(/\s+/);
  let bestMatch = FALLBACK_VERTICAL_VIDEOS[0];
  let maxScore = -1;

  for (const item of FALLBACK_VERTICAL_VIDEOS) {
    let score = 0;
    for (const token of qTokens) {
      if (item.keywords.some(k => k.includes(token) || token.includes(k))) {
        score += 2;
      }
    }
    if (score > maxScore) {
      maxScore = score;
      bestMatch = item;
    }
  }

  // Return formatted results
  const results = FALLBACK_VERTICAL_VIDEOS.map((item, idx) => ({
    id: `fallback-${idx}`,
    url: item.url,
    thumbnail: item.thumbnail,
    duration: item.duration,
    keywords: item.keywords,
    width: 1080,
    height: 1920,
    isCuratedFallback: true,
  }));

  // Put best match first
  const sorted = [
    { ...bestMatch, id: 'best-match', width: 1080, height: 1920 },
    ...results.filter(r => r.url !== bestMatch.url)
  ];

  return res.json({
    results: sorted,
    source: 'curated_library',
    matched: bestMatch.url,
  });
});

// Setup Vite or static serving
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        host: '0.0.0.0',
        port,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`[Viblo Shorts] Server is running on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
