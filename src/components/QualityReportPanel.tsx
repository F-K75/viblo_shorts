import React, { useState } from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Wrench,
  RefreshCw,
  Download,
  ChevronDown,
  ChevronUp,
  Sparkles,
  ShieldCheck,
} from 'lucide-react';
import type { QualityClassification, QualityReport, RepairActionType, RepairRecommendation } from '../utils/quality';

interface QualityReportPanelProps {
  report: QualityReport;
  isReevaluating?: boolean;
  onDownloadAnyway?: () => void;
  onReevaluate?: () => void;
  onReexport?: () => void;
  onApplyRepair?: (action: RepairActionType, rec: RepairRecommendation) => void;
}

const CLASSIFICATION_STYLES: Record<QualityClassification, { badge: string; bar: string; border: string }> = {
  Excellent: {
    badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35',
    bar: 'bg-emerald-400',
    border: 'border-emerald-500/25',
  },
  Good: {
    badge: 'bg-sky-500/15 text-sky-300 border-sky-500/35',
    bar: 'bg-sky-400',
    border: 'border-sky-500/25',
  },
  'Needs improvement': {
    badge: 'bg-amber-500/15 text-amber-200 border-amber-500/35',
    bar: 'bg-amber-400',
    border: 'border-amber-500/25',
  },
  Poor: {
    badge: 'bg-rose-500/15 text-rose-200 border-rose-500/35',
    bar: 'bg-rose-400',
    border: 'border-rose-500/30',
  },
};

const GATE_LABEL: Record<string, string> = {
  PASS: 'Pass',
  NEEDS_IMPROVEMENT: 'Needs improvement',
  REJECTED: 'Rejected',
};

/**
 * Creator-facing Forge Reel Quality Evaluation report:
 * - Overall 0–100 score + 4-tier classification (Excellent / Good / Needs improvement / Poor)
 * - Publishing readiness status + critical failure override banner
 * - All 7 weighted dimensions with expandable check evidence
 * - Actionable repair recommendations with safe 1-click repair controls
 * - Re-evaluate after edits & Re-export controls
 */
export const QualityReportPanel: React.FC<QualityReportPanelProps> = ({
  report,
  isReevaluating = false,
  onDownloadAnyway,
  onReevaluate,
  onReexport,
  onApplyRepair,
}) => {
  const [expandedDim, setExpandedDim] = useState<string | null>(null);
  const [appliedRecs, setAppliedRecs] = useState<Record<string, boolean>>({});
  const e = report.result?.evaluation;
  const a = e?.spec.actual;
  const isPreflight = report.mode === 'preflight';
  const classification: QualityClassification =
    e?.classification ||
    (e?.status === 'PASS' ? (e.score >= 90 ? 'Excellent' : 'Good') : e?.status === 'NEEDS_IMPROVEMENT' ? 'Needs improvement' : 'Poor');
  const style = CLASSIFICATION_STYLES[classification];
  const gateText = e ? GATE_LABEL[e.status] || e.status : 'Not verified';

  const handleRepair = (rec: RepairRecommendation) => {
    if (!onApplyRepair) return;
    onApplyRepair(rec.repairAction, rec);
    setAppliedRecs((prev) => ({ ...prev, [rec.id]: true }));
  };

  return (
    <div
      data-testid="quality-report"
      className={`rounded-xl border ${e && report.verified ? style.border : 'border-white/10'} bg-[#0b1018] p-3.5 text-[11px] text-neutral-300 space-y-3`}
    >
      {/* Header: Title, Score, Classification & Publishing Readiness */}
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-rose-400 shrink-0" />
            <span className="font-semibold text-white text-xs">
              {isPreflight ? 'Pre-Export Quality Check' : 'Reel Quality Report'}
            </span>
          </div>
          {e && report.verified && (
            <p className="text-[11px] text-neutral-400">
              {e.readyToPublish ? (
                <span className="text-emerald-300 font-medium">{e.action}</span>
              ) : (
                <span className={e.criticalOverride ? 'text-rose-300 font-medium' : 'text-amber-200 font-medium'}>
                  {e.action}
                </span>
              )}
              {e.criticalOverride && ' · Critical gate triggered'}
            </p>
          )}
        </div>

        <div className="flex flex-col items-end gap-1">
          <span
            data-testid="quality-status"
            className={`px-2 py-0.5 rounded-md border font-semibold whitespace-nowrap ${
              e && report.verified ? style.badge : 'bg-white/5 text-neutral-300 border-white/10'
            }`}
          >
            {e && report.verified ? `${classification} (${gateText}) · ${Math.round(e.score)}/100` : 'Not verified'}
          </span>
        </div>
      </div>

      {/* Measured Export Specification */}
      {a ? (
        <p data-testid="quality-spec" className="text-[10.5px] leading-relaxed bg-black/35 rounded-lg px-2.5 py-1.5 border border-white/6">
          Delivered: <span className="font-mono text-white">{a.width}×{a.height}</span> · {a.fps} fps · {a.videoCodec.toUpperCase()} · {a.pixFmt} ·{' '}
          {a.audioCodec ? a.audioCodec.toUpperCase() : 'no audio'}
          {a.faststart ? ' · fast start' : ''} · {(a.sizeBytes / 1048576).toFixed(1)} MB
          {e && !e.spec.meetsSpec && (
            <span className="block text-rose-300 mt-0.5 font-medium">
              Requested {e.spec.requested.width}×{e.spec.requested.height}; the file does not meet the export spec.
            </span>
          )}
        </p>
      ) : !isPreflight ? (
        <p className="text-[10.5px] text-neutral-400">
          {report.error}
          {report.local ? ` Measured in the browser: ${report.local.width}×${report.local.height}.` : ''} Saved as{' '}
          <span className="font-mono text-white">{report.fileName}</span>.
        </p>
      ) : null}

      {/* Critical Failures Callout */}
      {e && report.verified && e.criticalDefects.length > 0 && (
        <div className="rounded-lg border border-rose-500/35 bg-rose-500/10 p-2.5 space-y-1">
          <div className="flex items-center gap-1.5 text-rose-200 font-semibold text-[11px]">
            <XCircle className="w-3.5 h-3.5 shrink-0" />
            <span>
              {e.criticalDefects.length} Critical {e.criticalDefects.length === 1 ? 'Failure' : 'Failures'} Blocking Publish
            </span>
          </div>
          <ul className="space-y-0.5 text-rose-100/90 text-[10.5px]">
            {e.criticalDefects.map((c) => (
              <li key={c.id}>• {c.message}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 7-Dimension Weighted Breakdown */}
      {e && report.verified && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
            <span>Dimension Breakdown</span>
            <span>Weighted Score</span>
          </div>
          <div className="space-y-1">
            {e.dimensions.map((d) => {
              const measured = d.checks.some((c) => c.measured !== false);
              const isOpen = expandedDim === d.key;
              const failedCount = d.checks.filter((c) => !c.passed && c.measured !== false).length;
              return (
                <div key={d.key} className="rounded-lg bg-black/25 border border-white/5 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setExpandedDim(isOpen ? null : d.key)}
                    className="w-full px-2 py-1.5 flex items-center gap-2 hover:bg-white/[0.03] transition text-left"
                  >
                    <span className="w-36 shrink-0 truncate text-neutral-200 font-medium">{d.label}</span>
                    <div className="flex-1 h-1.5 rounded bg-white/10 overflow-hidden">
                      {measured && (
                        <div
                          className={`h-full transition-all ${
                            d.score >= 0.85 ? 'bg-emerald-400' : d.score >= 0.65 ? 'bg-amber-400' : 'bg-rose-400'
                          }`}
                          style={{ width: `${Math.round(d.score * 100)}%` }}
                        />
                      )}
                    </div>
                    <span className="w-12 text-right font-mono tabular-nums text-[10.5px] text-neutral-300">
                      {measured ? `${d.points}/${d.weight}` : 'pending'}
                    </span>
                    {d.checks.length > 0 &&
                      (isOpen ? (
                        <ChevronUp className="w-3 h-3 text-neutral-500 shrink-0" />
                      ) : (
                        <ChevronDown className="w-3 h-3 text-neutral-500 shrink-0" />
                      ))}
                  </button>
                  {isOpen && d.checks.length > 0 && (
                    <div className="px-2.5 pb-2 pt-1 border-t border-white/5 space-y-1 bg-black/30">
                      {d.checks.map((ck) => (
                        <div key={ck.id} className="flex items-start gap-1.5 text-[10px]">
                          {ck.passed ? (
                            <CheckCircle2 className="w-3 h-3 text-emerald-400 mt-0.5 shrink-0" />
                          ) : ck.severity === 'critical' ? (
                            <XCircle className="w-3 h-3 text-rose-400 mt-0.5 shrink-0" />
                          ) : (
                            <AlertTriangle className="w-3 h-3 text-amber-300 mt-0.5 shrink-0" />
                          )}
                          <div className="min-w-0">
                            <span className={ck.passed ? 'text-neutral-300' : ck.severity === 'critical' ? 'text-rose-200' : 'text-amber-100'}>
                              {ck.message}
                            </span>
                            {!ck.passed && ck.suggestion && (
                              <span className="block text-neutral-500">{ck.suggestion}</span>
                            )}
                          </div>
                        </div>
                      ))}
                      {failedCount === 0 && <span className="text-[10px] text-emerald-400/80">All checks passed.</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* AI Creative Review Summary (when Gemini key active) */}
      {e?.aiReview?.mode === 'ai_assisted' && e.aiReview.findings.length > 0 && (
        <div className="rounded-lg border border-purple-500/25 bg-purple-500/10 p-2.5 space-y-1">
          <div className="flex items-center gap-1.5 text-purple-200 font-semibold text-[10.5px]">
            <Sparkles className="w-3 h-3 shrink-0" />
            <span>AI Narrative Review ({e.aiReview.model})</span>
          </div>
          <p className="text-[10.5px] text-purple-100/90">{e.aiReview.summary}</p>
        </div>
      )}

      {/* Detected Problems List (preserving data-testid="quality-problems") */}
      {e && report.verified && e.problems.length > 0 && (
        <div className="space-y-1">
          <span className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">Detected Issues</span>
          <ul className="space-y-1" data-testid="quality-problems">
            {e.problems.slice(0, 8).map((p) => (
              <li
                key={p.id}
                className={`text-[10.5px] leading-snug ${
                  p.severity === 'critical' ? 'text-rose-300' : p.severity === 'major' ? 'text-amber-200' : 'text-neutral-400'
                }`}
              >
                <span className="uppercase text-[9px] font-bold mr-1.5 px-1 py-0.5 rounded bg-white/5">{p.severity}</span>
                {p.message}
                {p.suggestion && <span className="text-neutral-500"> {p.suggestion}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Actionable Repair Recommendations with Safe 1-Click Fixes */}
      {e && report.verified && e.recommendations && e.recommendations.length > 0 && (
        <div className="space-y-1.5 pt-1 border-t border-white/8">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-neutral-400 font-semibold">
            <Wrench className="w-3 h-3 text-rose-400" />
            <span>Recommended Repairs</span>
          </div>
          <div className="space-y-1.5">
            {e.recommendations.slice(0, 5).map((rec) => {
              const applied = appliedRecs[rec.id];
              const canOneClick =
                onApplyRepair &&
                (rec.repairAction === 'enable_phrase_captions' ||
                  rec.repairAction === 'adjust_caption_safe_zone' ||
                  rec.repairAction === 'realign_captions' ||
                  rec.repairAction === 'diversify_visuals' ||
                  rec.repairAction === 'rerecord_export');
              return (
                <div
                  key={rec.id}
                  className="rounded-lg bg-black/35 border border-white/8 px-2.5 py-2 flex items-start justify-between gap-2"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="text-[11px] font-semibold text-white">{rec.title}</div>
                    <p className="text-[10px] text-neutral-400 leading-snug">{rec.description}</p>
                  </div>
                  {canOneClick && (
                    <button
                      type="button"
                      onClick={() => handleRepair(rec)}
                      disabled={applied}
                      className={`shrink-0 px-2 py-1 rounded-md text-[10px] font-semibold border transition ${
                        applied
                          ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                          : 'bg-rose-600/20 hover:bg-rose-600/35 border-rose-500/35 text-rose-200'
                      }`}
                    >
                      {applied ? 'Applied' : 'Fix'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Conform / Remediation Audit Line */}
      {!isPreflight && (
        <p className="text-[10px] text-neutral-500 leading-snug" data-testid="quality-remediation">
          {report.attempts.length > 1 ? `Re-recorded automatically (${report.attempts.length} attempts). ` : 'Recorded once. '}
          {(report.result?.remediation || []).map((r) => (r.ok ? r.detail : `${r.action} failed: ${r.detail}`)).join(' ')}
        </p>
      )}

      {/* Action Footer: Re-evaluate, Re-export, Download anyway */}
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        {onReevaluate && (
          <button
            type="button"
            onClick={onReevaluate}
            disabled={isReevaluating}
            className="flex-1 py-1.5 px-2.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-neutral-200 font-medium text-[11px] flex items-center justify-center gap-1.5 transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${isReevaluating ? 'animate-spin' : ''}`} />
            <span>{isReevaluating ? 'Checking…' : 'Re-evaluate'}</span>
          </button>
        )}
        {onReexport && (
          <button
            type="button"
            onClick={onReexport}
            className="flex-1 py-1.5 px-2.5 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/35 text-rose-200 font-medium text-[11px] flex items-center justify-center gap-1.5 transition"
          >
            <Download className="w-3 h-3" />
            <span>Re-export</span>
          </button>
        )}
        {onDownloadAnyway && (
          <button
            type="button"
            onClick={onDownloadAnyway}
            className="w-full py-1.5 rounded-lg border border-white/15 text-neutral-300 hover:bg-white/5 text-[11px] transition"
          >
            Download anyway (not recommended)
          </button>
        )}
      </div>
    </div>
  );
};
