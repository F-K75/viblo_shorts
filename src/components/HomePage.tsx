import React, { useState } from 'react';
import {
  Youtube,
  Sparkles,
  ArrowRight,
  Play,
  Scissors,
  Flame,
  CheckCircle2,
  Tv,
  Smartphone,
  ShieldCheck,
  Zap,
  TrendingUp,
  Share2,
  Star,
  Layers,
  ChevronRight,
} from 'lucide-react';

interface HomePageProps {
  onStartFree: () => void;
  onSignIn: () => void;
  onTrySample: (url: string) => void;
}

const SAMPLE_CLIPS = [
  {
    title: "Steve Jobs: Don't Waste Your Time",
    author: "Stanford Commencement",
    duration: "33s",
    viralScore: 97,
    url: "https://www.youtube.com/watch?v=UF8uR6Z6KLc",
    tag: "Life & Purpose",
  },
  {
    title: "Huberman on Deep Sleep & Focus",
    author: "Huberman Lab",
    duration: "42s",
    viralScore: 94,
    url: "https://www.youtube.com/watch?v=nm1TxQj94ow",
    tag: "Neuroscience",
  },
  {
    title: "Why 99% Of People Never Start",
    author: "Ali Abdaal",
    duration: "29s",
    viralScore: 91,
    url: "https://www.youtube.com/watch?v=UF8uR6Z6KLc",
    tag: "Productivity",
  },
];

const FEATURES = [
  {
    icon: Scissors,
    title: "Built Around the Original Video",
    desc: "Preview clips on the original YouTube video with synced captions, then export captions (SRT/VTT) and a 9:16 caption render for publishing.",
  },
  {
    icon: Flame,
    title: "AI Viral Hook Detection",
    desc: "Gemini scans audio CC transcripts to pinpoint curiosity gaps, dramatic pauses, and explosive hooks within the first 3 seconds.",
  },
  {
    icon: Sparkles,
    title: "Kinetic Word-by-Word Captions",
    desc: "Hormozi, MrBeast, and TikTok typography presets with dynamic real-time word highlighting calibrated for maximum audience retention.",
  },
  {
    icon: Smartphone,
    title: "9:16 Vertical Video Reframing",
    desc: "Instantly reframe 16:9 widescreen YouTube videos into 9:16 vertical shorts with built-in YouTube UI safe zone guidelines.",
  },
  {
    icon: Zap,
    title: "Studio Direct Export",
    desc: "Render polished shorts directly in your browser at 1080×1920 (FHD) or 720×1280 (HD) with zero watermarks.",
  },
  {
    icon: TrendingUp,
    title: "CTR-Engineered Metadata",
    desc: "Get algorithm-optimized titles, descriptions, and viral hashtag packages ready to paste directly into YouTube Studio.",
  },
];

const METRICS = [
  { label: 'Vertical Format', val: '9:16' },
  { label: 'Caption Styles', val: 'Kinetic' },
  { label: 'Subtitle Export', val: 'SRT · VTT' },
  { label: 'Export Resolution', val: 'Up to 1080p' },
];

export const HomePage: React.FC<HomePageProps> = ({ onStartFree, onSignIn, onTrySample }) => {
  const [quickUrl, setQuickUrl] = useState('');

  const handleQuickSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (quickUrl.trim()) {
      onTrySample(quickUrl.trim());
    } else {
      onStartFree();
    }
  };

  return (
    <div className="min-h-screen bg-[#090c10] text-[#f1f5f9] selection:bg-rose-500 selection:text-white flex flex-col">
      {/* Top Navbar */}
      <header className="sticky top-0 z-40 bg-[#090c10]/90 backdrop-blur-md border-b border-white/8">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-rose-600 flex items-center justify-center text-white font-bold shadow-md shadow-rose-950/50">
              <Youtube className="w-4 h-4 fill-current" />
            </div>
            <span className="font-display text-lg font-bold tracking-tight text-white select-none">
              Forge Studio
            </span>
          </div>

          <nav className="hidden md:flex items-center gap-8 text-xs font-medium text-neutral-400">
            <a href="#features" className="hover:text-white transition">Features</a>
            <a href="#how-it-works" className="hover:text-white transition">How it Works</a>
            <a href="#samples" className="hover:text-white transition">Sample Shorts</a>
            <a href="#pricing" className="hover:text-white transition">Pricing</a>
          </nav>

          <div className="flex items-center gap-3">
            <button
              onClick={onSignIn}
              className="text-xs font-medium text-neutral-300 hover:text-white px-3 py-2 transition"
            >
              Sign In
            </button>
            <button
              onClick={onStartFree}
              className="px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-lg transition shadow-sm flex items-center gap-1.5"
            >
              <span>Get Started Free</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative pt-16 pb-20 px-6 overflow-hidden">
        {/* Subtle background ambient glow */}
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[350px] bg-rose-600/10 blur-[140px] pointer-events-none rounded-full" />

        <div className="max-w-4xl mx-auto text-center relative z-10 space-y-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-xs text-neutral-300">
            <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
            <span>AI Shorts & Kinetic Captions Engine</span>
            <span aria-hidden="true">·</span>
            <span className="text-neutral-400">Captions from real YouTube transcripts</span>
          </div>

          <h1 className="text-3xl sm:text-5xl lg:text-6xl font-display font-extrabold tracking-tight text-white leading-[1.12]">
            Turn Long YouTube Videos Into{' '}
            <span className="bg-gradient-to-r from-rose-400 via-rose-500 to-amber-300 bg-clip-text text-transparent">
              Viral Shorts in Seconds
            </span>
          </h1>

          <p className="text-neutral-400 text-sm sm:text-base max-w-2xl mx-auto leading-relaxed">
            Extract the highest-retention moments from podcasts and speeches. Keep the original video and voice, add synchronized kinetic subtitles, and export directly in 9:16 vertical format.
          </p>

          {/* Quick Start Form */}
          <form
            onSubmit={handleQuickSubmit}
            className="max-w-2xl mx-auto p-2 bg-[#0f141c] border border-white/12 rounded-2xl shadow-2xl flex flex-col sm:flex-row gap-2"
          >
            <div className="relative flex-1">
              <Youtube className="w-5 h-5 text-red-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={quickUrl}
                onChange={(e) => setQuickUrl(e.target.value)}
                placeholder="Paste any YouTube URL (e.g. https://youtube.com/watch?v=...)"
                className="w-full pl-11 pr-3 py-3 bg-[#090c10] border border-white/8 focus:border-rose-500 rounded-xl text-xs sm:text-sm text-white placeholder-neutral-500 focus:outline-none transition shadow-inner font-medium"
              />
            </div>
            <button
              type="submit"
              className="px-6 py-3 bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs sm:text-sm rounded-xl transition flex items-center justify-center gap-2 shadow-md shrink-0"
            >
              <span>Launch Studio</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>

          {/* Quick Sample Links */}
          <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-neutral-400 pt-2">
            <span className="text-[11px] text-neutral-500">Or try popular clips:</span>
            {SAMPLE_CLIPS.map((sample) => (
              <button
                key={sample.title}
                onClick={() => onTrySample(sample.url)}
                className="px-2.5 py-1 rounded-lg bg-black/40 hover:bg-white/10 text-neutral-300 hover:text-white border border-white/8 text-[11px] transition flex items-center gap-1.5"
              >
                <Play className="w-2.5 h-2.5 text-rose-400 fill-current" />
                <span>{sample.title}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Hero Preview Showcase */}
        <div className="max-w-5xl mx-auto mt-14 p-4 rounded-3xl bg-[#0f141c] border border-white/10 shadow-2xl relative">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_320px] gap-6 items-center">
            {/* Left Mockup description */}
            <div className="space-y-4 p-4">
              <div className="flex items-center gap-2 text-xs text-rose-400 font-mono">
                <Sparkles className="w-3.5 h-3.5" />
                <span>KINETIC CAPTIONS</span>
              </div>
              <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
                High-Retention Word Sync with Instant Trimming
              </h2>
              <p className="text-xs text-neutral-400 leading-relaxed">
                Captions come from the video's own transcript when available (or one you paste), with word timings you can fine-tune on the timeline. Choose from Alex Hormozi gold highlights, MrBeast electric cyan, or Vox clean documentary captions.
              </p>
              <div className="grid grid-cols-2 gap-3 pt-2">
                <div className="p-3 rounded-xl bg-black/40 border border-white/6">
                  <div className="text-lg font-mono font-bold text-white">±0.1s</div>
                  <div className="text-[11px] text-neutral-400">Manual timing nudges</div>
                </div>
                <div className="p-3 rounded-xl bg-black/40 border border-white/6">
                  <div className="text-lg font-mono font-bold text-rose-400">Word-level</div>
                  <div className="text-[11px] text-neutral-400">Highlight sync</div>
                </div>
              </div>
            </div>

            {/* Right: Vertical Player Mockup */}
            <div className="flex justify-center">
              <div className="w-[240px] aspect-[9/16] rounded-2xl bg-black border border-white/15 overflow-hidden relative shadow-2xl flex flex-col justify-between p-3">
                {/* Simulated YouTube Video Background */}
                <div className="absolute inset-0 bg-neutral-900 overflow-hidden">
                  <img
                    src="https://i.ytimg.com/vi/UF8uR6Z6KLc/hqdefault.jpg"
                    alt="Video thumbnail"
                    className="w-full h-full object-cover scale-125 blur-xs opacity-75"
                  />
                  <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-black/80" />
                </div>

                {/* Top Badge */}
                <div className="relative z-10 flex items-center justify-between text-[10px] text-white">
                  <span className="px-2 py-0.5 rounded bg-black/70 font-mono">9:16 VERTICAL</span>
                  <span className="px-2 py-0.5 rounded bg-rose-600 font-bold">VIRAL 97</span>
                </div>

                {/* Simulated Kinetic Captions */}
                <div className="relative z-10 text-center space-y-1">
                  <div className="inline-block px-3 py-1.5 rounded-lg bg-black/80 border border-white/10 shadow-lg">
                    <span className="font-extrabold text-white text-sm font-sans tracking-tight">
                      YOUR TIME IS{' '}
                    </span>
                    <span className="font-extrabold text-amber-300 text-sm font-sans tracking-tight">
                      LIMITED
                    </span>
                  </div>
                </div>

                {/* Bottom Controls */}
                <div className="relative z-10 flex items-center justify-between text-[10px] text-neutral-300 bg-black/60 backdrop-blur-xs p-2 rounded-xl">
                  <div className="flex items-center gap-1.5">
                    <Play className="w-3 h-3 text-rose-400 fill-current" />
                    <span className="font-mono">00:15 / 00:48</span>
                  </div>
                  <span className="text-emerald-400 font-medium">Original Audio</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Metrics Row */}
      <section className="border-y border-white/8 bg-[#0c1017] py-8 px-6">
        <div className="max-w-7xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
          {METRICS.map((m, idx) => (
            <div key={idx} className="space-y-1">
              <div className="font-mono text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                {m.val}
              </div>
              <div className="text-xs text-neutral-400">{m.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Features Grid */}
      <section id="features" className="py-20 px-6 max-w-7xl mx-auto space-y-12">
        <div className="text-center space-y-3 max-w-2xl mx-auto">
          <h2 className="text-xs font-mono uppercase tracking-widest text-rose-400 font-semibold">
            Engineered For YouTube Creators
          </h2>
          <h3 className="text-2xl sm:text-4xl font-display font-bold text-white tracking-tight">
            Everything You Need To Dominate YouTube Shorts
          </h3>
          <p className="text-xs sm:text-sm text-neutral-400 leading-relaxed">
            Stop spending hours manually slicing timestamps in Premiere Pro. Forge Studio automates trimming, subtitles, and framing in minutes.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {FEATURES.map((feat, idx) => {
            const Icon = feat.icon;
            return (
              <div
                key={idx}
                className="p-6 rounded-2xl bg-[#0f141c] border border-white/8 hover:border-white/18 transition space-y-3"
              >
                <div className="w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-500/25 flex items-center justify-center text-rose-400">
                  <Icon className="w-5 h-5" />
                </div>
                <h4 className="text-base font-semibold text-white tracking-tight">
                  {feat.title}
                </h4>
                <p className="text-xs text-neutral-400 leading-relaxed">
                  {feat.desc}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="py-16 px-6 bg-[#0c1017] border-y border-white/8">
        <div className="max-w-5xl mx-auto space-y-12">
          <div className="text-center space-y-2">
            <h3 className="text-2xl sm:text-3xl font-display font-bold text-white">
              3 Simple Steps to Viral Content
            </h3>
            <p className="text-xs text-neutral-400">From long-form YouTube video to publishing-ready short</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <div className="p-5 rounded-2xl bg-[#0f141c] border border-white/8 space-y-3">
              <div className="font-mono text-xs font-bold text-rose-400">STEP 01</div>
              <h4 className="text-sm font-semibold text-white">Paste YouTube Link</h4>
              <p className="text-xs text-neutral-400 leading-relaxed">
                Paste any podcast, interview, or tutorial. Gemini analyzes the transcript to find high-impact viral moments.
              </p>
            </div>

            <div className="p-5 rounded-2xl bg-[#0f141c] border border-white/8 space-y-3">
              <div className="font-mono text-xs font-bold text-rose-400">STEP 02</div>
              <h4 className="text-sm font-semibold text-white">Trim & Pick Caption Style</h4>
              <p className="text-xs text-neutral-400 leading-relaxed">
                Fine-tune the start/end window, select Alex Hormozi or MrBeast kinetic captions, and preview in real time.
              </p>
            </div>

            <div className="p-5 rounded-2xl bg-[#0f141c] border border-white/8 space-y-3">
              <div className="font-mono text-xs font-bold text-rose-400">STEP 03</div>
              <h4 className="text-sm font-semibold text-white">Export & Upload</h4>
              <p className="text-xs text-neutral-400 leading-relaxed">
                Download your 1080p vertical short and copy the generated high-CTR title, description, and hashtags.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Samples Showcase */}
      <section id="samples" className="py-20 px-6 max-w-7xl mx-auto space-y-8">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h3 className="text-2xl font-display font-bold text-white">Sample YouTube Clips</h3>
            <p className="text-xs text-neutral-400 mt-1">Explore pre-tested viral moments ready to open in the Studio</p>
          </div>

          <button
            onClick={onStartFree}
            className="text-xs font-medium text-rose-400 hover:text-rose-300 flex items-center gap-1 transition self-start sm:self-auto"
          >
            <span>Open Studio Canvas</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {SAMPLE_CLIPS.map((sample, idx) => (
            <div
              key={idx}
              onClick={() => onTrySample(sample.url)}
              className="group p-5 rounded-2xl bg-[#0f141c] border border-white/8 hover:border-rose-500/50 cursor-pointer transition flex flex-col justify-between space-y-4 shadow-sm"
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="px-2 py-0.5 rounded bg-black/40 text-neutral-400 font-mono text-[11px] border border-white/6">
                    {sample.tag}
                  </span>
                  <span className="font-mono text-amber-400 font-bold text-xs flex items-center gap-1">
                    <Flame className="w-3 h-3" />
                    {sample.viralScore}/100
                  </span>
                </div>

                <h4 className="text-sm font-semibold text-white group-hover:text-rose-300 transition">
                  {sample.title}
                </h4>
                <div className="text-xs text-neutral-400 flex items-center gap-2">
                  <span>{sample.author}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">{sample.duration}</span>
                </div>
              </div>

              <div className="pt-3 border-t border-white/6 flex items-center justify-between text-xs">
                <span className="text-neutral-400">Open in Trimmer</span>
                <ArrowRight className="w-3.5 h-3.5 text-rose-400 group-hover:translate-x-1 transition" />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing / CTA Section */}
      <section id="pricing" className="py-20 px-6 max-w-4xl mx-auto text-center space-y-6">
        <div className="p-8 sm:p-12 rounded-3xl bg-gradient-to-b from-[#141b27] to-[#0f141c] border border-white/12 shadow-2xl space-y-6">
          <h3 className="text-2xl sm:text-4xl font-display font-bold text-white tracking-tight">
            Ready to Accelerate Your Shorts Growth?
          </h3>
          <p className="text-xs sm:text-sm text-neutral-400 max-w-xl mx-auto leading-relaxed">
            Join thousands of YouTube creators and agencies producing retention-engineered Shorts in a fraction of the time.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
            <button
              onClick={onStartFree}
              className="w-full sm:w-auto px-8 py-3.5 bg-rose-600 hover:bg-rose-500 text-white font-semibold text-sm rounded-xl transition shadow-lg shadow-rose-950/50 flex items-center justify-center gap-2"
            >
              <span>Start Clipping Free</span>
              <ArrowRight className="w-4 h-4" />
            </button>
            <button
              onClick={onSignIn}
              className="w-full sm:w-auto px-6 py-3.5 bg-black/40 hover:bg-black/60 text-neutral-300 hover:text-white font-medium text-sm rounded-xl border border-white/10 transition"
            >
              Sign In to Your Account
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-6 pt-4 text-xs text-neutral-500">
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>No credit card required</span>
            </div>
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>Free tier available</span>
            </div>
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>1080p direct export</span>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="mt-auto border-t border-white/8 bg-[#090c10] py-8 px-6 text-xs text-neutral-500">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="font-display font-semibold text-neutral-300">Forge Studio</span>
            <span>— AI YouTube Shorts & Kinetic Subtitles Platform</span>
          </div>

          <div className="flex items-center gap-6">
            <button onClick={onStartFree} className="hover:text-white transition">Studio</button>
            <button onClick={onSignIn} className="hover:text-white transition">Sign In</button>
            <a href="#features" className="hover:text-white transition">Features</a>
          </div>
        </div>
      </footer>
    </div>
  );
};
