import React, { useState } from 'react';
import {
  Youtube,
  ArrowRight,
  Lock,
  Mail,
  User,
  Eye,
  EyeOff,
  CheckCircle2,
  Sparkles,
  ShieldCheck,
  ChevronLeft,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithPopup,
  GoogleAuthProvider,
  updateProfile,
} from 'firebase/auth';
import { auth } from '../utils/googleDrive';
import { ensureGuestSession, clearGuestSession } from '../utils/api';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  avatar: string;
  plan: 'free' | 'pro';
}

interface AuthPageProps {
  onSuccess: (user: AuthUser) => void;
  onBackToHome: () => void;
  initialMode?: 'signin' | 'signup';
}

export const AuthPage: React.FC<AuthPageProps> = ({
  onSuccess,
  onBackToHome,
  initialMode = 'signin',
}) => {
  const [mode, setMode] = useState<'signin' | 'signup'>(initialMode);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);

    const cleanEmail = email.trim();
    const cleanPassword = password.trim();

    if (!cleanEmail || !cleanPassword) {
      setError('Please provide an email and password.');
      return;
    }

    if (cleanPassword.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    if (mode === 'signup' && !name.trim()) {
      setError('Please enter your creator name.');
      return;
    }

    setIsLoading(true);

    try {
      if (mode === 'signup') {
        const cred = await createUserWithEmailAndPassword(auth, cleanEmail, cleanPassword);
        const displayName = name.trim() || cleanEmail.split('@')[0] || 'Shorts Creator';
        try {
          await updateProfile(cred.user, { displayName });
        } catch {
          // ignore profile update error if already set
        }
        const user: AuthUser = {
          id: cred.user.uid,
          name: displayName,
          email: cred.user.email || cleanEmail,
          avatar: cred.user.photoURL || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(cred.user.uid)}`,
          plan: 'free',
        };
        clearGuestSession();
        setIsLoading(false);
        onSuccess(user);
      } else {
        const cred = await signInWithEmailAndPassword(auth, cleanEmail, cleanPassword);
        const displayName = cred.user.displayName || cleanEmail.split('@')[0] || 'Shorts Creator';
        const user: AuthUser = {
          id: cred.user.uid,
          name: displayName,
          email: cred.user.email || cleanEmail,
          avatar: cred.user.photoURL || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(cred.user.uid)}`,
          plan: 'free',
        };
        clearGuestSession();
        setIsLoading(false);
        onSuccess(user);
      }
    } catch (err: any) {
      setIsLoading(false);
      const code = err?.code || '';
      console.warn('[Firebase Auth] Authentication error:', code, err?.message);

      if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
        setError('Incorrect password or email credentials.');
      } else if (code === 'auth/user-not-found') {
        setError('No account found with this email. Click "Sign Up" above to create one.');
      } else if (code === 'auth/email-already-in-use') {
        setError('An account already exists with this email. Please sign in instead.');
      } else if (code === 'auth/invalid-email') {
        setError('Invalid email address format.');
      } else if (code === 'auth/operation-not-allowed') {
        setError('Email/password sign-in is disabled in Firebase console. You can sign in with Google or continue as Guest.');
      } else {
        setError(err?.message || 'Authentication failed. Please check your credentials or continue as Guest.');
      }
    }
  };

  const handleGoogleSignIn = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const cred = await signInWithPopup(auth, provider);
      const displayName = cred.user.displayName || cred.user.email?.split('@')[0] || 'Creator';
      const user: AuthUser = {
        id: cred.user.uid,
        name: displayName,
        email: cred.user.email || '',
        avatar: cred.user.photoURL || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(cred.user.uid)}`,
        plan: 'free',
      };
      clearGuestSession();
      setIsLoading(false);
      onSuccess(user);
    } catch (err: any) {
      setIsLoading(false);
      const code = err?.code || '';
      console.warn('[Firebase Google Auth] Error:', code, err?.message);
      if (code === 'auth/popup-closed-by-user') {
        setError('Google sign-in popup was closed before completion.');
      } else if (code === 'auth/popup-blocked') {
        setError('Popup was blocked by your browser. Please allow popups for this site.');
      } else {
        setError(err?.message || 'Google sign-in encountered an issue. You can continue as Guest.');
      }
    }
  };

  const handleForgotPassword = async () => {
    setError(null);
    setInfoMessage(null);

    const cleanEmail = email.trim();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setError('Please enter a valid email address to reset your password.');
      return;
    }

    setIsLoading(true);
    try {
      await sendPasswordResetEmail(auth, cleanEmail);
      setInfoMessage(`Password reset email sent to ${cleanEmail}. Check your inbox and spam folder.`);
    } catch (err: any) {
      const code = err?.code || '';
      console.warn('[Firebase Auth] Password reset error:', code, err?.message);
      if (code === 'auth/invalid-email') {
        setError('Invalid email address format.');
      } else if (code === 'auth/user-not-found') {
        setError('No account found with this email address.');
      } else if (code === 'auth/too-many-requests') {
        setError('Too many reset requests. Please wait a moment and try again.');
      } else if (code === 'auth/network-request-failed') {
        setError('Network error. Please check your connection and try again.');
      } else {
        setError(err?.message || 'Failed to send password reset email. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleGuestSignIn = async () => {
    setIsLoading(true);
    setError(null);
    try {
      // The server issues a signed guest session; the guest id is never chosen by the client.
      const { userId } = await ensureGuestSession();
      const user: AuthUser = {
        id: userId,
        name: 'Guest Creator',
        email: '',
        avatar: `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(userId)}`,
        plan: 'free',
      };
      onSuccess(user);
    } catch (err: any) {
      setError(err?.message || 'Could not start a guest session. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#090c10] text-[#f1f5f9] flex flex-col justify-center py-12 sm:px-6 lg:px-8 relative overflow-hidden">
      {/* Background ambient lighting */}
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[300px] bg-rose-600/10 blur-[130px] pointer-events-none rounded-full" />

      {/* Back to Home Button */}
      <div className="max-w-md w-full mx-auto px-4 mb-4">
        <button
          onClick={onBackToHome}
          className="inline-flex items-center gap-1.5 text-xs text-neutral-400 hover:text-white transition group"
        >
          <ChevronLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition" />
          <span>Back to Home</span>
        </button>
      </div>

      <div className="sm:mx-auto sm:w-full sm:max-w-md px-4">
        {/* Brand header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-rose-600 shadow-xl shadow-rose-950/60 mb-2">
            <Youtube className="w-6 h-6 text-white fill-current" />
          </div>
          <h2 className="text-2xl font-display font-extrabold text-white tracking-tight">
            {mode === 'signin' ? 'Sign in to Forge Studio' : 'Create your Creator Account'}
          </h2>
          <p className="text-xs text-neutral-400">
            {mode === 'signin'
              ? 'Access your saved shorts, kinetic typography, and YouTube clip trimmer'
              : 'Start converting long YouTube videos into viral 9:16 Shorts today'}
          </p>
        </div>

        {/* Main Card */}
        <div className="mt-8 bg-[#0f141c] border border-white/10 rounded-3xl p-6 sm:p-8 shadow-2xl space-y-6">
          {/* Segmented Auth Mode Switcher */}
          <div className="grid grid-cols-2 p-1 bg-[#090c10] border border-white/8 rounded-xl text-xs font-semibold">
            <button
              type="button"
              onClick={() => {
                setMode('signin');
                setError(null);
              }}
              className={`py-2 rounded-lg transition ${
                mode === 'signin' ? 'bg-[#1e2638] text-white shadow-sm' : 'text-neutral-400 hover:text-white'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('signup');
                setError(null);
              }}
              className={`py-2 rounded-lg transition ${
                mode === 'signup' ? 'bg-[#1e2638] text-white shadow-sm' : 'text-neutral-400 hover:text-white'
              }`}
            >
              Create Account
            </button>
          </div>

          {/* Social / Google Sign-in */}
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={isLoading}
            className="w-full py-2.5 px-4 rounded-xl bg-white hover:bg-neutral-100 text-neutral-900 font-semibold text-xs flex items-center justify-center gap-2.5 shadow-sm transition disabled:opacity-50"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
              />
            </svg>
            <span>Continue with Google</span>
          </button>

          {/* Divider */}
          <div className="relative flex items-center justify-center">
            <div className="border-t border-white/8 w-full" />
            <span className="bg-[#0f141c] px-3 text-[11px] text-neutral-500 uppercase tracking-wider">
              Or with email
            </span>
          </div>

          {/* Email / Password Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'signup' && (
              <div>
                <label className="block text-xs font-semibold text-white mb-1.5">
                  Creator / Channel Name
                </label>
                <div className="relative">
                  <User className="w-4 h-4 text-neutral-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Alex Rivera"
                    className="w-full pl-10 pr-3 py-2.5 bg-[#090c10] border border-white/10 focus:border-rose-500 rounded-xl text-xs text-white placeholder-neutral-500 focus:outline-none transition shadow-inner font-medium"
                  />
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-white mb-1.5">
                Email Address
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-neutral-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="creator@example.com"
                  className="w-full pl-10 pr-3 py-2.5 bg-[#090c10] border border-white/10 focus:border-rose-500 rounded-xl text-xs text-white placeholder-neutral-500 focus:outline-none transition shadow-inner font-medium"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-semibold text-white">Password</label>
                {mode === 'signin' && (
                  <button
                    type="button"
                    onClick={handleForgotPassword}
                    disabled={isLoading}
                    className="text-[11px] text-rose-400 hover:text-rose-300 transition disabled:opacity-50"
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <div className="relative">
                <Lock className="w-4 h-4 text-neutral-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full pl-10 pr-10 py-2.5 bg-[#090c10] border border-white/10 focus:border-rose-500 rounded-xl text-xs text-white placeholder-neutral-500 focus:outline-none transition shadow-inner font-medium"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-white transition"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {infoMessage && (
              <div className="p-3 rounded-xl bg-blue-950/40 border border-blue-800/50 text-xs text-blue-200">
                {infoMessage}
              </div>
            )}

            {error && (
              <div className="p-3 rounded-xl bg-red-950/40 border border-red-800/50 text-xs text-red-200">
                {error}
              </div>
            )}

            <div className="flex items-center justify-between pt-1">
              <label className="flex items-center gap-2 cursor-pointer text-xs text-neutral-400">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="rounded bg-neutral-900 border-white/20 text-rose-600 focus:ring-0 cursor-pointer"
                />
                <span>Remember me on this browser</span>
              </label>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3 px-4 bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs rounded-xl shadow-lg shadow-rose-950/50 transition flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Signing in...</span>
                </>
              ) : (
                <>
                  <span>{mode === 'signin' ? 'Sign In to Studio' : 'Create Creator Account'}</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          </form>

          {/* Quick Instant Demo / Guest Button */}
          <div className="pt-2 border-t border-white/6 text-center">
            <button
              type="button"
              onClick={handleGuestSignIn}
              className="text-xs text-neutral-400 hover:text-white transition inline-flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5 text-rose-400" />
              <span>Explore as Guest without signing in</span>
            </button>
          </div>
        </div>

        {/* Security badge footer */}
        <div className="mt-6 text-center flex items-center justify-center gap-2 text-xs text-neutral-500">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <span>SSL 256-Bit Encrypted Session</span>
        </div>
      </div>
    </div>
  );
};
