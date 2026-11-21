import React, { useState } from 'react';
import { AlertOctagon, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, RefreshCw, Sparkles, Wand2 } from 'lucide-react';
import { evidenceLines, titleFor, type QualityCheck, type QualityReport, type RepairAction } from '../utils/quality';

const CLASS_STYLE: Record<string, string> = {
  EXCELLENT: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  GOOD: 'bg-emerald-500/10 text-emerald-200 border-emerald-500/25',
  NEEDS_IMPROVEMENT: 'bg-amber-500/15 text-amber-200 border-amber-500/30',
  POOR: 'bg-rose-500/15 text-rose-200 border-rose-500/30',
};
const CLASS_TEXT: Record<string, string> = { EXCELLENT: 'Excellent', GOOD: 'Good', NEEDS_IMPROVEMENT: 'Needs improvement', POOR: 'Poor' };
/** Buttons offered for recommendations the editor can apply directly (others are guidance). */
const ACTION_BUTTON: Partial<Record<RepairAction, string>> = {
  regenerate_voiceover: 'Use AI voice',
  attach_source: 'Add video file',
  regroup_captions: 'Use phrase captions',
  reposition_captions: 'Move captions up',
  realign_captions: 'Re-align captions',
  replace_scenes: 'Find new footage',
  retrieve_assets: 'Find new footage',
};

const Issue: React.FC<{ c: QualityCheck }> = ({ c }) => {
  const [open, setOpen] = useState(false);
  const color = c.severity === 'critical' ? 'text-rose-300' : c.severity === 'major' ? 'text-amber-200' : 'text-neutral-300';
  return (
    <li className="rounded-lg bg-white/[0.03] px-2 py-1.5">
      <button type="button" onClick={() => setOpen(!open)} className="w-full text-left flex items-start gap-1.5" aria-expanded={open}>
        {open ? <ChevronDown className="w-3 h-3 mt-0.5 shrink-0" /> : <ChevronRight className="w-3 h-3 mt-0.5 shrink-0" />}
        <span className={color}>
          <span className="font-semibold">{titleFor(c.id)}</span>
          <span className="text-neutral-400"> — {c.message}</span>
        </span>
      </button>
      {open && (
        <div className="pl-4 pt-1 space-y-1">
          {c.suggestion && <p className="text-neutral-200">How to fix: {c.suggestion}</p>}
          <ul className="font-mono text-[10px] text-neutral-500 space-y-0.5" data-testid="quality-evidence">
            {evidenceLines(c.evidence).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
};

/**
 * Quality report for a creator: one verdict (score, classification, what to do), then why: critical failures,
 * warnings with their measured evidence, category scores, what was repaired automatically, and the fixes to apply.
 */
export const QualityReportCard: React.FC<{
  report: QualityReport;
  onDownloadAnyway?: () => void;
  onExportAnyway?: () => void;
  onAction?: (action: RepairAction) => void;
  onRecheck?: () => void;
  busy?: boolean;
}> = ({ report, onDownloadAnyway, onExportAnyway, onAction, onRecheck, busy }) => {
  const e = report.result?.evaluation;
  const a = e?.spec.actual;
  const pre = report.phase === 'precheck';
  const cls = report.verified && e ? e.classification : 'UNVERIFIED';
  const critical = e?.problems.filter((p) => p.severity === 'critical') || [];
  const warnings = e?.problems.filter((p) => p.severity !== 'critical') || [];
  return (
    <div data-testid="quality-report" className="rounded-xl border border-white/10 bg-black/30 p-3 text-[11px] text-neutral-300 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-white text-xs">{pre ? 'Check before export' : 'Quality report'}</span>
        <span className={`px-2 py-0.5 rounded-md border font-semibold ${CLASS_STYLE[cls] || 'bg-white/5 text-neutral-300 border-white/10'}`} data-testid="quality-status">
          {pre ? 'Blocked' : CLASS_TEXT[cls] || 'Not verified'}
          {e && report.verified && !pre ? ` · ${Math.round(e.score)}/100` : ''}
        </span>
      </div>

      {e && report.verified && (
        <p className={`flex items-start gap-1.5 font-medium ${e.readyToPublish ? 'text-emerald-300' : critical.length ? 'text-rose-200' : 'text-amber-200'}`} data-testid="quality-verdict">
          {e.readyToPublish ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : critical.length ? <AlertOctagon className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
          <span>
            {pre
              ? `This reel would fail: ${critical.length} problem(s) must be fixed before recording.`
              : `${e.action}. ${e.readyToPublish ? 'This reel meets the publishing bar.' : critical.length ? `${critical.length} critical problem(s) make it unpublishable, whatever the score.` : 'Fix the warnings below, then export again.'}`}
          </span>
        </p>
      )}

      {a ? (
        <p data-testid="quality-spec" className="text-neutral-400">
          File: <span className="font-mono text-white">{a.width}×{a.height}</span> · {a.fps} fps · {a.videoCodec.toUpperCase()} · {a.pixFmt} · {a.audioCodec ? a.audioCodec.toUpperCase() : 'no audio'}
          {a.faststart ? ' · fast start' : ''} · {a.durationS}s · {(a.sizeBytes / 1048576).toFixed(1)} MB
          {e && !e.spec.meetsSpec && <span className="block text-rose-300">Requested {e.spec.requested.width}×{e.spec.requested.height}; the file does not meet the export spec.</span>}
        </p>
      ) : (
        !pre && (
          <p>
            {report.error}
            {report.local ? ` Measured in the browser: ${report.local.width}×${report.local.height}.` : ''} Saved as <span className="font-mono">{report.fileName}</span>.
          </p>
        )
      )}

      {e && report.verified && (
        <>
          {critical.length > 0 && (
            <div>
              <p className="text-rose-300 font-semibold mb-1">Critical — must fix</p>
              <ul className="space-y-1" data-testid="quality-critical">
                {critical.map((p) => <Issue key={p.id} c={p} />)}
              </ul>
            </div>
          )}
          {e.recommendations.length > 0 && (
            <div>
              <p className="text-white font-semibold mb-1 flex items-center gap-1"><Wand2 className="w-3 h-3" /> Suggested improvements</p>
              <ul className="space-y-1" data-testid="quality-recommendations">
                {e.recommendations.slice(0, 6).map((r) => (
                  <li key={r.action} className="flex items-start justify-between gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5">
                    <span>
                      <span className="font-semibold text-neutral-100">{r.title}</span>
                      {r.automatic && <span className="ml-1 text-[9px] uppercase text-emerald-300">auto</span>}
                      <span className="block text-neutral-400">{r.detail}</span>
                    </span>
                    {onAction && ACTION_BUTTON[r.action] && (
                      <button type="button" disabled={busy} onClick={() => onAction(r.action)} className="shrink-0 px-2 py-1 rounded-md bg-rose-600/80 hover:bg-rose-500 text-white text-[10px] font-semibold disabled:opacity-50">
                        {ACTION_BUTTON[r.action]}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!pre && (
            <div className="grid grid-cols-1 gap-1" data-testid="quality-dimensions">
              {e.dimensions.map((d) => {
                const measured = d.checks.some((c) => c.measured !== false);
                return (
                  <div key={d.key} className="flex items-center gap-2">
                    <span className="w-36 shrink-0 truncate">{d.label}</span>
                    <div className="flex-1 h-1.5 rounded bg-white/10 overflow-hidden">
                      {measured && <div className={`h-full ${d.score >= 0.85 ? 'bg-emerald-400' : d.score >= 0.6 ? 'bg-amber-400' : 'bg-rose-400'}`} style={{ width: `${Math.round(d.score * 100)}%` }} />}
                    </div>
                    <span className="w-12 text-right font-mono tabular-nums">{measured ? `${d.points}/${d.weight}` : 'n/a'}</span>
                  </div>
                );
              })}
            </div>
          )}
          {warnings.length > 0 && (
            <details>
              <summary className="cursor-pointer text-amber-200 font-semibold">Warnings ({warnings.length}) — tap for evidence</summary>
              <ul className="space-y-1 mt-1" data-testid="quality-problems">
                {warnings.map((p) => <Issue key={p.id} c={p} />)}
              </ul>
            </details>
          )}
          {e.aiReview && (
            <details>
              <summary className="cursor-pointer flex items-center gap-1 text-neutral-200"><Sparkles className="w-3 h-3" /> AI story review ({e.aiReview.model})</summary>
              <p className="mt-1 text-neutral-400">{e.aiReview.summary}</p>
            </details>
          )}
          {!pre && (
            <p className="text-neutral-500" data-testid="quality-remediation">
              {report.attempts.length > 1 ? `Re-recorded automatically (${report.attempts.length} attempts). ` : 'Recorded once. '}
              {(report.result?.remediation || []).map((r) => (r.ok ? r.detail : `${r.action} failed: ${r.detail}`)).join(' ')}
            </p>
          )}
          <p className="text-neutral-600 text-[10px]">{e.notes.join(' ')}</p>
        </>
      )}
      <div className="flex gap-2">
        {onRecheck && (
          <button type="button" disabled={busy} onClick={onRecheck} className="flex-1 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-white flex items-center justify-center gap-1 disabled:opacity-50" data-testid="quality-recheck">
            <RefreshCw className="w-3 h-3" /> {pre ? 'Check again' : 'Re-export & re-check'}
          </button>
        )}
        {onExportAnyway && (
          <button type="button" disabled={busy} onClick={onExportAnyway} className="flex-1 py-1.5 rounded-lg border border-white/15 text-neutral-300 hover:bg-white/5 disabled:opacity-50">
            Export anyway
          </button>
        )}
        {onDownloadAnyway && (
          <button type="button" onClick={onDownloadAnyway} className="flex-1 py-1.5 rounded-lg border border-white/15 text-neutral-200 hover:bg-white/5">
            Download anyway (not recommended)
          </button>
        )}
      </div>
    </div>
  );
};
