import React, { useState, useEffect } from 'react';
import {
  X,
  CloudUpload,
  CheckCircle2,
  ExternalLink,
  Loader2,
  FileText,
  FileVideo,
  Download,
  Folder,
  ShieldCheck,
  LogOut,
  AlertCircle,
  Copy,
  Check,
} from 'lucide-react';
import { User } from 'firebase/auth';
import {
  initDriveAuth,
  signInWithGoogleDrive,
  signOutGoogleDrive,
  getDriveAccessToken,
  exportShortToGoogleDrive,
  DriveExportResult,
} from '../utils/googleDrive';
import { ShortScript } from '../types';
import { generateSrtFromBeats } from '../utils/pipeline';

interface GoogleDriveExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  script: ShortScript | null;
  topic: string;
}

export const GoogleDriveExportModal: React.FC<GoogleDriveExportModalProps> = ({
  isOpen,
  onClose,
  script,
  topic,
}) => {
  const [googleUser, setGoogleUser] = useState<User | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [fileName, setFileName] = useState('');
  const [includeJsonPack, setIncludeJsonPack] = useState(true);
  const [includeSrt, setIncludeSrt] = useState(true);

  const [isExporting, setIsExporting] = useState(false);
  const [exportStep, setExportStep] = useState('');
  const [exportPercent, setExportPercent] = useState(0);
  const [exportResult, setExportResult] = useState<DriveExportResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const [showConfirm, setShowConfirm] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    // Reset results when modal opens
    setExportResult(null);
    setExportError(null);
    setShowConfirm(false);

    // Initial file name from script or topic
    const base = script?.title || topic || 'Forge-Short';
    const cleaned = base
      .replace(/#shorts/gi, '')
      .replace(/[^a-zA-Z0-9\s-_]/g, '')
      .trim()
      .replace(/\s+/g, '-');
    setFileName(cleaned || 'Forge-Short');

    const unsubscribe = initDriveAuth(
      (user, token) => {
        setGoogleUser(user);
        setHasToken(Boolean(token));
      },
      () => {
        setGoogleUser(null);
        setHasToken(false);
      }
    );

    // Check if token already in memory
    getDriveAccessToken().then((token) => {
      setHasToken(Boolean(token));
    });

    return () => {
      unsubscribe();
    };
  }, [isOpen, script, topic]);

  if (!isOpen) return null;

  const handleGoogleSignIn = async () => {
    setIsSigningIn(true);
    setAuthError(null);
    try {
      const res = await signInWithGoogleDrive();
      if (res) {
        setGoogleUser(res.user);
        setHasToken(true);
      }
    } catch (err: any) {
      console.error('Google Drive sign in failed:', err);
      setAuthError(err?.message || 'Failed to authenticate with Google.');
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleGoogleSignOut = async () => {
    await signOutGoogleDrive();
    setGoogleUser(null);
    setHasToken(false);
  };

  const handleExecuteExport = async () => {
    if (!script) return;
    setIsExporting(true);
    setExportError(null);
    setShowConfirm(false);

    try {
      const fullText = script.beats.map((b) => b.text).join(' ');
      const duration = script.beats && script.beats.length > 0
        ? script.beats[script.beats.length - 1].end_s
        : 30;
      const srtText = includeSrt ? generateSrtFromBeats(script.beats) : undefined;

      const result = await exportShortToGoogleDrive(
        {
          title: fileName || script.title,
          description: script.description || '',
          hashtags: script.hashtags || ['#shorts'],
          beatsText: fullText,
          duration,
          sourceType: script.sourceYouTubeId ? 'youtube' : 'prompt',
          sourceUrl: script.sourceYouTubeId ? `https://www.youtube.com/watch?v=${script.sourceYouTubeId}` : undefined,
          srtContent: srtText,
        },
        (step, pct) => {
          setExportStep(step);
          setExportPercent(pct);
        }
      );

      setExportResult(result);
    } catch (err: any) {
      console.error('Export to Drive failed:', err);
      setExportError(err?.message || 'Failed to complete export to Google Drive.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleDownloadLocalJson = () => {
    if (!script) return;
    const data = {
      title: script.title,
      description: script.description,
      hashtags: script.hashtags,
      viralScore: script.viralScore,
      clipReasoning: script.clipReasoning,
      hook: script.hook,
      beats: script.beats,
      sourceYouTubeId: script.sourceYouTubeId,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileName || 'Forge-Short'}-package.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadLocalSrt = () => {
    if (!script) return;
    const srt = generateSrtFromBeats(script.beats);
    const blob = new Blob([srt], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileName || 'Forge-Short'}-captions.srt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="bg-[#0f141c] border border-white/10 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-white/8 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
              <CloudUpload className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white tracking-tight">Export to Google Drive</h3>
              <p className="text-[11px] text-neutral-400">Save publishing bundle and assets directly to your Drive</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-neutral-400 hover:text-white rounded-lg transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 overflow-y-auto flex-1">
          {/* Auth State */}
          {!hasToken ? (
            <div className="p-5 rounded-xl bg-black/40 border border-white/8 text-center space-y-4">
              <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 mx-auto flex items-center justify-center">
                <CloudUpload className="w-6 h-6" />
              </div>
              <div>
                <h4 className="text-sm font-semibold text-white">Connect Google Drive</h4>
                <p className="text-xs text-neutral-400 mt-1 max-w-xs mx-auto">
                  Sign in with your Google account to grant Forge Studio permission to upload short videos and publishing packs to Google Drive.
                </p>
              </div>

              {/* Official Google Sign-In Styled Button as per workspace skill instructions */}
              <div className="pt-2 flex justify-center">
                <button
                  type="button"
                  onClick={handleGoogleSignIn}
                  disabled={isSigningIn}
                  className="inline-flex items-center gap-3 px-5 py-2.5 bg-white hover:bg-neutral-100 text-neutral-800 text-xs font-semibold rounded-lg shadow transition border border-neutral-300 disabled:opacity-60 cursor-pointer"
                >
                  <svg className="w-4 h-4 shrink-0" viewBox="0 0 48 48">
                    <path
                      fill="#EA4335"
                      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                    />
                    <path
                      fill="#4285F4"
                      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                    />
                    <path
                      fill="#34A853"
                      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                    />
                  </svg>
                  <span>{isSigningIn ? 'Connecting...' : 'Sign in with Google'}</span>
                </button>
              </div>

              {authError && (
                <div className="p-2.5 rounded-lg bg-red-950/40 border border-red-800/40 text-[11px] text-red-300">
                  {authError}
                </div>
              )}
            </div>
          ) : (
            <div className="p-3 rounded-xl bg-black/30 border border-white/6 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                {googleUser?.photoURL ? (
                  <img
                    src={googleUser.photoURL}
                    alt={googleUser.displayName || 'Google User'}
                    className="w-7 h-7 rounded-full border border-white/10"
                  />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-emerald-600 flex items-center justify-center text-white text-xs font-bold">
                    {googleUser?.email?.[0]?.toUpperCase() || 'G'}
                  </div>
                )}
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-white">{googleUser?.displayName || 'Connected User'}</span>
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  </div>
                  <span className="text-[10px] text-neutral-400 font-mono">{googleUser?.email}</span>
                </div>
              </div>

              <button
                type="button"
                onClick={handleGoogleSignOut}
                className="text-xs text-neutral-400 hover:text-rose-400 p-1 rounded transition flex items-center gap-1"
                title="Disconnect Google Account"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span className="text-[11px]">Disconnect</span>
              </button>
            </div>
          )}

          {/* Export Settings Form */}
          <div className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-white block mb-1.5">Export Project Name</label>
              <input
                type="text"
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                placeholder="e.g. Steve-Jobs-Short"
                className="w-full px-3 py-2 bg-[#090c10] border border-white/10 rounded-xl text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-rose-500 font-mono"
              />
            </div>

            {/* Target Folder Details */}
            <div className="p-3 rounded-xl bg-black/40 border border-white/6 flex items-center gap-2.5 text-xs text-neutral-300">
              <Folder className="w-4 h-4 text-amber-400 shrink-0" />
              <div className="min-w-0">
                <span className="text-neutral-400 text-[11px] block">Target Destination:</span>
                <span className="font-semibold text-white truncate block">Google Drive / Forge Studio Shorts /</span>
              </div>
            </div>

            {/* Package Components */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-white block">Package Inclusions</label>
              <div className="space-y-1.5">
                <label className="flex items-center gap-2.5 p-2 rounded-lg bg-[#090c10] border border-white/6 cursor-pointer text-xs text-neutral-200">
                  <input
                    type="checkbox"
                    checked={includeJsonPack}
                    onChange={(e) => setIncludeJsonPack(e.target.checked)}
                    className="accent-rose-500 rounded"
                  />
                  <FileText className="w-3.5 h-3.5 text-rose-400" />
                  <div className="flex-1">
                    <span className="font-medium">Publishing Pack (.json)</span>
                    <span className="text-[10px] text-neutral-400 block">Title, description, viral hashtags, timestamps, hook score</span>
                  </div>
                </label>

                <label className="flex items-center gap-2.5 p-2 rounded-lg bg-[#090c10] border border-white/6 cursor-pointer text-xs text-neutral-200">
                  <input
                    type="checkbox"
                    checked={includeSrt}
                    onChange={(e) => setIncludeSrt(e.target.checked)}
                    className="accent-rose-500 rounded"
                  />
                  <FileVideo className="w-3.5 h-3.5 text-emerald-400" />
                  <div className="flex-1">
                    <span className="font-medium">Subtitles & Closed Captions (.srt)</span>
                    <span className="text-[10px] text-neutral-400 block">Synchronized word-by-word timing file ready for YouTube Shorts upload</span>
                  </div>
                </label>
              </div>
            </div>
          </div>

          {/* Progress / Status */}
          {isExporting && (
            <div className="p-4 rounded-xl bg-black/50 border border-emerald-500/30 space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 text-emerald-300">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>{exportStep || 'Uploading to Google Drive...'}</span>
                </div>
                <span className="font-mono text-emerald-400 font-bold">{exportPercent}%</span>
              </div>
              <div className="w-full h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all duration-300 rounded-full"
                  style={{ width: `${exportPercent}%` }}
                />
              </div>
            </div>
          )}

          {/* Success Card */}
          {exportResult && (
            <div className="p-4 rounded-xl bg-emerald-950/30 border border-emerald-500/40 space-y-3">
              <div className="flex items-center gap-2 text-emerald-400 text-xs font-semibold">
                <CheckCircle2 className="w-4 h-4" />
                <span>Successfully exported to Google Drive!</span>
              </div>
              <p className="text-xs text-neutral-300">
                File <strong className="text-white font-mono">{exportResult.fileName}</strong> was created in {exportResult.folderId ? 'your "Forge Studio Shorts" folder' : 'your Google Drive (My Drive)'}.
              </p>
              <div className="pt-1 flex flex-wrap gap-2">
                {exportResult.webViewLink && (
                  <a
                    href={exportResult.webViewLink}
                    target="_blank"
                    rel="noreferrer"
                    className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 transition shadow"
                  >
                    <span>Open in Google Drive</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (exportResult.webViewLink) {
                      navigator.clipboard.writeText(exportResult.webViewLink);
                      setCopiedLink(true);
                      setTimeout(() => setCopiedLink(false), 2000);
                    }
                  }}
                  className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-neutral-300 text-xs font-medium flex items-center gap-1.5 transition border border-white/8"
                >
                  {copiedLink ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedLink ? 'Link Copied' : 'Copy Link'}</span>
                </button>
              </div>
            </div>
          )}

          {exportError && (
            <div className="p-3.5 rounded-xl bg-red-950/40 border border-red-800/50 text-xs text-red-200 flex flex-col gap-2">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <span>{exportError}</span>
              </div>
              {(exportError.includes('expired') || exportError.includes('sign in') || !hasToken) && (
                <button
                  type="button"
                  onClick={handleGoogleSignIn}
                  disabled={isSigningIn}
                  className="self-start mt-1 px-3 py-1.5 rounded-lg bg-white text-neutral-900 text-xs font-semibold hover:bg-neutral-100 transition shadow"
                >
                  {isSigningIn ? 'Connecting...' : 'Reconnect Google Account'}
                </button>
              )}
            </div>
          )}

          {/* Mandatory Confirmation Step for mutative Workspace operations */}
          {showConfirm && (
            <div className="p-4 rounded-xl bg-amber-950/30 border border-amber-500/40 space-y-3">
              <div className="flex items-center gap-2 text-amber-300 text-xs font-semibold">
                <AlertCircle className="w-4 h-4" />
                <span>Confirm Google Drive Upload</span>
              </div>
              <p className="text-xs text-neutral-300 leading-relaxed">
                Forge Studio will create files in your Google Drive under the folder <strong className="text-white">Forge Studio Shorts</strong> with permission from your account. Do you wish to proceed?
              </p>
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleExecuteExport}
                  className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition"
                >
                  Confirm & Upload
                </button>
                <button
                  type="button"
                  onClick={() => setShowConfirm(false)}
                  className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-neutral-300 text-xs transition border border-white/8"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/8 bg-black/20 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-neutral-400">
            <span>Also available:</span>
            <button
              type="button"
              onClick={handleDownloadLocalJson}
              className="text-neutral-300 hover:text-white hover:underline flex items-center gap-1"
            >
              <Download className="w-3 h-3" />
              <span>JSON Pack</span>
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={handleDownloadLocalSrt}
              className="text-neutral-300 hover:text-white hover:underline flex items-center gap-1"
            >
              <Download className="w-3 h-3" />
              <span>SRT Captions</span>
            </button>
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 sm:flex-none px-4 py-2 text-xs font-medium text-neutral-300 hover:text-white bg-white/5 hover:bg-white/10 rounded-xl transition border border-white/8"
            >
              Close
            </button>

            {!exportResult && (
              <button
                type="button"
                disabled={isExporting || !hasToken || showConfirm}
                onClick={() => setShowConfirm(true)}
                className="flex-1 sm:flex-none px-5 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-xl transition flex items-center justify-center gap-2 shadow-sm"
              >
                {isExporting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Exporting...</span>
                  </>
                ) : (
                  <>
                    <CloudUpload className="w-3.5 h-3.5" />
                    <span>Export to Google Drive</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
