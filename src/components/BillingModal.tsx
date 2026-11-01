import React, { useState, useEffect } from 'react';
import { useEscapeKey } from '../utils/useEscapeKey';
import {
  Zap,
  Check,
  Shield,
  Sparkles,
  CreditCard,
  X,
  ArrowRight,
  TrendingUp,
  Clock,
  Layers,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { UserSubscription } from '../types';
import { apiFetch, apiErrorMessage } from '../utils/api';

interface BillingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPlanChanged?: (newPlan: 'free' | 'pro' | 'studio') => void;
}

export const BillingModal: React.FC<BillingModalProps> = ({
  isOpen,
  onClose,
  onPlanChanged,
}) => {
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [subscription, setSubscription] = useState<UserSubscription | null>(null);
  const [loading, setLoading] = useState(false);
  const [upgradingPlan, setUpgradingPlan] = useState<'free' | 'pro' | 'studio' | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      fetchSubscription();
    }
  }, [isOpen]);

  const fetchSubscription = async () => {
    try {
      const res = await apiFetch('/api/user/subscription');
      if (res.ok) {
        const data = await res.json();
        if (data.subscription) {
          setSubscription(data.subscription);
        }
      }
    } catch (err) {
      console.warn('Failed to load subscription:', err);
    }
  };

  const handleUpgrade = async (targetPlan: 'free' | 'pro' | 'studio') => {
    setUpgradingPlan(targetPlan);
    setLoading(true);
    setSuccessMessage(null);

    try {
      const res = await apiFetch('/api/user/subscription/upgrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: targetPlan }),
      });

      if (!res.ok) {
        setSuccessMessage(null);
        setUpgradeError(await apiErrorMessage(res, 'Plan change failed'));
        return;
      }
      {
        const data = await res.json();
        setSubscription(data.subscription);
        setUpgradeError(null);
        setSuccessMessage(`${data.demo ? '[Demo billing — no payment taken] ' : ''}Switched to ${targetPlan === 'studio' ? 'Studio Team' : targetPlan === 'pro' ? 'Creator Pro' : 'Free Starter'} plan!`);
        onPlanChanged?.(targetPlan);
        setTimeout(() => setSuccessMessage(null), 4000);
      }
    } catch (err) {
      console.error('Upgrade failed:', err);
    } finally {
      setLoading(false);
      setUpgradingPlan(null);
    }
  };

  useEscapeKey(isOpen, onClose);

  if (!isOpen) return null;

  const currentPlan = subscription?.plan || 'free';
  const dailyUsed = subscription?.dailyQuotaUsed || 0;
  const dailyLimit = subscription?.dailyQuotaLimit || 50;
  const renderUsed = subscription?.monthlyRenderMinutesUsed || 0;
  const renderLimit = subscription?.monthlyRenderMinutesLimit || 10;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-4xl bg-[#0d121c] border border-white/12 rounded-3xl p-6 sm:p-8 shadow-2xl overflow-hidden max-h-[90vh] overflow-y-auto">
        {/* Glow ambient background */}
        <div className="absolute top-0 right-1/4 w-96 h-96 bg-rose-600/10 blur-[120px] pointer-events-none rounded-full" />
        <div className="absolute bottom-0 left-1/4 w-96 h-96 bg-indigo-600/10 blur-[120px] pointer-events-none rounded-full" />

        {/* Header */}
        <div className="flex items-center justify-between pb-6 border-b border-white/8 relative z-10">
          <div>
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs font-semibold mb-2">
              <Sparkles className="w-3.5 h-3.5 text-rose-400" />
              <span>SaaS Growth & Monetization (Phase 4)</span>
            </div>
            <h2 className="text-2xl font-bold text-white tracking-tight">Creator Plans & Usage Limits</h2>
            <p className="text-xs text-neutral-400">Manage your subscription, generation quotas, and rendering tier.</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-neutral-400 hover:text-white hover:bg-white/8 transition"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Live Usage Meter Bar */}
        <div className="my-6 p-4 rounded-2xl bg-[#141a26] border border-white/8 relative z-10 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="text-neutral-400 font-medium flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-amber-400" />
                <span>Daily AI Generation Quota</span>
              </span>
              <span className="font-mono font-semibold text-white">
                {dailyUsed} / {dailyLimit} calls
              </span>
            </div>
            <div className="w-full h-2 rounded-full bg-black/40 overflow-hidden border border-white/5">
              <div
                className="h-full bg-gradient-to-r from-amber-500 to-rose-500 rounded-full transition-all"
                style={{ width: `${Math.min(100, (dailyUsed / Math.max(1, dailyLimit)) * 100)}%` }}
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="text-neutral-400 font-medium flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-indigo-400" />
                <span>Monthly Render Bandwidth</span>
              </span>
              <span className="font-mono font-semibold text-white">
                {renderUsed} / {renderLimit} mins
              </span>
            </div>
            <div className="w-full h-2 rounded-full bg-black/40 overflow-hidden border border-white/5">
              <div
                className="h-full bg-gradient-to-r from-indigo-500 to-sky-500 rounded-full transition-all"
                style={{ width: `${Math.min(100, (renderUsed / Math.max(1, renderLimit)) * 100)}%` }}
              />
            </div>
          </div>
        </div>

        {upgradeError && (
          <div role="alert" className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-100">
            {upgradeError}
          </div>
        )}
        {successMessage && (
          <div className="mb-6 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{successMessage}</span>
          </div>
        )}

        {/* Pricing Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 relative z-10">
          {/* Card 1: Free Starter */}
          <div
            className={`rounded-2xl p-5 border flex flex-col justify-between transition ${
              currentPlan === 'free'
                ? 'bg-[#151c28] border-white/30 ring-2 ring-white/10 shadow-lg'
                : 'bg-[#101520] border-white/8 hover:border-white/16'
            }`}
          >
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-white">Free Starter</h3>
                {currentPlan === 'free' && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-white/10 text-white border border-white/15">
                    Current Plan
                  </span>
                )}
              </div>
              <div className="mb-4">
                <span className="text-2xl font-bold text-white">$0</span>
                <span className="text-xs text-neutral-400"> / month</span>
              </div>
              <ul className="space-y-2.5 text-xs text-neutral-300 mb-6">
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>50 AI generations / day</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>720p Canvas Video Export</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>SRT Subtitle Downloads</span>
                </li>
                <li className="flex items-center gap-2 text-neutral-500">
                  <X className="w-3.5 h-3.5 text-neutral-600 shrink-0" />
                  <span>Google Drive Cloud Sync</span>
                </li>
              </ul>
            </div>

            <button
              type="button"
              disabled={currentPlan === 'free' || loading}
              onClick={() => handleUpgrade('free')}
              className={`w-full py-2.5 rounded-xl text-xs font-semibold transition ${
                currentPlan === 'free'
                  ? 'bg-white/5 text-neutral-500 cursor-default'
                  : 'bg-white/10 text-white hover:bg-white/15'
              }`}
            >
              {currentPlan === 'free' ? 'Active' : 'Downgrade to Free'}
            </button>
          </div>

          {/* Card 2: Creator Pro (Featured) */}
          <div
            className={`rounded-2xl p-5 border flex flex-col justify-between relative transition ${
              currentPlan === 'pro'
                ? 'bg-[#181d2e] border-rose-500 ring-2 ring-rose-500/20 shadow-xl'
                : 'bg-[#121724] border-rose-500/40 hover:border-rose-500/70'
            }`}
          >
            <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2.5 py-0.5 rounded-full bg-rose-600 text-white text-[10px] font-bold uppercase tracking-wider shadow-md">
              Most Popular
            </div>

            <div>
              <div className="flex items-center justify-between mb-3 mt-1">
                <h3 className="text-sm font-semibold text-white">Creator Pro</h3>
                {currentPlan === 'pro' && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30">
                    Current Plan
                  </span>
                )}
              </div>
              <div className="mb-4">
                <span className="text-2xl font-bold text-white">$29</span>
                <span className="text-xs text-neutral-400"> / month</span>
              </div>
              <ul className="space-y-2.5 text-xs text-neutral-200 mb-6">
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                  <span>250 AI generations / day</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                  <span>Full 1080x1920 HD Export</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                  <span>Google Drive 1-Click Sync</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                  <span>Alex Hormozi & Beast Subtitle Presets</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                  <span>Priority Gemini LLM Acceleration</span>
                </li>
              </ul>
            </div>

            <button
              type="button"
              disabled={currentPlan === 'pro' || loading}
              onClick={() => handleUpgrade('pro')}
              className={`w-full py-2.5 rounded-xl text-xs font-semibold transition flex items-center justify-center gap-1.5 ${
                currentPlan === 'pro'
                  ? 'bg-rose-500/10 text-rose-300 border border-rose-500/30 cursor-default'
                  : 'bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-950/40'
              }`}
            >
              {upgradingPlan === 'pro' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : currentPlan === 'pro' ? (
                'Active Plan'
              ) : (
                <>
                  <span>Upgrade to Pro</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          </div>

          {/* Card 3: Studio Team */}
          <div
            className={`rounded-2xl p-5 border flex flex-col justify-between transition ${
              currentPlan === 'studio'
                ? 'bg-[#151c28] border-indigo-500 ring-2 ring-indigo-500/20 shadow-xl'
                : 'bg-[#101520] border-white/8 hover:border-white/16'
            }`}
          >
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-white">Studio Team</h3>
                {currentPlan === 'studio' && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                    Current Plan
                  </span>
                )}
              </div>
              <div className="mb-4">
                <span className="text-2xl font-bold text-white">$79</span>
                <span className="text-xs text-neutral-400"> / month</span>
              </div>
              <ul className="space-y-2.5 text-xs text-neutral-300 mb-6">
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  <span>500 AI generations / day</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  <span>Unlimited 600m render bandwidth</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  <span>Multi-platform batch packaging</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  <span>Dedicated cloud queue workers</span>
                </li>
              </ul>
            </div>

            <button
              type="button"
              disabled={currentPlan === 'studio' || loading}
              onClick={() => handleUpgrade('studio')}
              className={`w-full py-2.5 rounded-xl text-xs font-semibold transition flex items-center justify-center gap-1.5 ${
                currentPlan === 'studio'
                  ? 'bg-indigo-500/10 text-indigo-300 border border-indigo-500/30 cursor-default'
                  : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-950/40'
              }`}
            >
              {upgradingPlan === 'studio' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : currentPlan === 'studio' ? (
                'Active Plan'
              ) : (
                <>
                  <span>Upgrade to Studio</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          </div>
        </div>

        {/* Footer Guarantee */}
        <div className="mt-6 pt-4 border-t border-white/8 text-center text-[11px] text-neutral-400 flex items-center justify-center gap-3">
          <span className="flex items-center gap-1">
            <Shield className="w-3.5 h-3.5 text-emerald-400" />
            <span>Encrypted cloud checkout</span>
          </span>
          <span>·</span>
          <span>Cancel or change plans anytime with one click</span>
        </div>
      </div>
    </div>
  );
};
