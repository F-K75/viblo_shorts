import React, { useState, useEffect } from 'react';
import {
  FolderKanban,
  X,
  Play,
  Copy,
  Trash2,
  Calendar,
  Clock,
  Sparkles,
  ArrowRight,
  Loader2,
  Plus,
  Film,
  CheckCircle2,
} from 'lucide-react';
import { Project } from '../types';

interface MyProjectsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoadProject: (project: Project) => void;
  onNewProject: () => void;
  currentProjectId?: string;
  userId?: string;
}

export const MyProjectsModal: React.FC<MyProjectsModalProps> = ({
  isOpen,
  onClose,
  onLoadProject,
  onNewProject,
  currentProjectId,
  userId = 'default_user',
}) => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setConfirmDeleteId(null);
      fetchProjects();
    }
  }, [isOpen]);

  const fetchProjects = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/projects', {
        headers: { 'x-user-id': userId },
      });
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects || []);
      }
    } catch (err) {
      console.error('Failed to load projects:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    setConfirmDeleteId(null);
    setActionLoadingId(id);
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: 'DELETE',
        headers: { 'x-user-id': userId },
      });
      if (res.ok) {
        setProjects((prev) => prev.filter((p) => p.id !== id));
      }
    } catch (err) {
      console.error('Delete failed:', err);
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleDuplicate = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setActionLoadingId(id);
    try {
      const res = await fetch(`/api/projects/${id}/duplicate`, {
        method: 'POST',
        headers: { 'x-user-id': userId },
      });
      if (res.ok) {
        const data = await res.json();
        setProjects((prev) => [data.project, ...prev]);
      }
    } catch (err) {
      console.error('Duplicate failed:', err);
    } finally {
      setActionLoadingId(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-4xl bg-[#0d121c] border border-white/12 rounded-3xl p-6 sm:p-8 shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        {/* Glow ambient background */}
        <div className="absolute top-0 right-1/3 w-80 h-80 bg-rose-600/10 blur-[120px] pointer-events-none rounded-full" />

        {/* Modal Header */}
        <div className="flex items-center justify-between pb-5 border-b border-white/8 relative z-10 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400">
              <FolderKanban className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white tracking-tight">Saved Shorts Projects</h2>
              <p className="text-xs text-neutral-400">Persistent project storage, timelines, and clip configurations</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                onClose();
                onNewProject();
              }}
              className="px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow-lg shadow-rose-950/40 transition"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Short</span>
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-neutral-400 hover:text-white hover:bg-white/8 transition"
              title="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Projects List */}
        <div className="py-6 overflow-y-auto relative z-10 flex-1 space-y-4">
          {loading ? (
            <div className="py-16 text-center text-neutral-400 flex flex-col items-center justify-center gap-3">
              <Loader2 className="w-6 h-6 animate-spin text-rose-500" />
              <span className="text-xs">Loading your saved projects...</span>
            </div>
          ) : projects.length === 0 ? (
            <div className="py-16 text-center text-neutral-400 flex flex-col items-center justify-center gap-3 border border-dashed border-white/8 rounded-2xl p-8">
              <Film className="w-8 h-8 text-neutral-500" />
              <div className="space-y-1">
                <p className="text-sm font-semibold text-white">No saved projects yet</p>
                <p className="text-xs text-neutral-500 max-w-sm">
                  Create your first Short in the Studio and click "Save Project" to store your timeline and kinetic captions.
                </p>
              </div>
              <button
                onClick={() => {
                  onClose();
                  onNewProject();
                }}
                className="mt-2 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold"
              >
                Create First Short
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {projects.map((proj) => {
                const isCurrent = proj.id === currentProjectId;
                const thumb = proj.thumbnail || proj.videoInfo?.thumbnailUrl || 'https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=1080&h=1920&fit=crop&q=80';
                const beatCount = proj.script?.beats?.length || 0;

                return (
                  <div
                    key={proj.id}
                    onClick={() => {
                      onLoadProject(proj);
                      onClose();
                    }}
                    className={`group rounded-2xl border p-3 flex flex-col justify-between cursor-pointer transition relative overflow-hidden ${
                      isCurrent
                        ? 'bg-[#181e2b] border-rose-500/50 ring-2 ring-rose-500/20'
                        : 'bg-[#111622] border-white/8 hover:border-white/20 hover:bg-[#141b29]'
                    }`}
                  >
                    <div>
                      {/* Thumbnail Banner */}
                      <div className="relative aspect-[16/9] rounded-xl overflow-hidden mb-3 bg-black/60">
                        <img
                          src={thumb}
                          alt={proj.title}
                          className="w-full h-full object-cover group-hover:scale-105 transition duration-500"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                        <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between text-[10px] text-white/90">
                          <span className="px-1.5 py-0.5 rounded bg-black/60 font-mono font-medium">
                            {proj.duration ? `${proj.duration}s` : '30s'}
                          </span>
                          <span className="px-1.5 py-0.5 rounded bg-rose-600/90 font-semibold uppercase tracking-wider text-[9px]">
                            {proj.creationMode === 'youtube' ? 'YouTube' : 'Idea'}
                          </span>
                        </div>
                      </div>

                      {/* Title & Metadata */}
                      <h3 className="text-xs font-semibold text-white line-clamp-1 group-hover:text-rose-300 transition mb-1">
                        {proj.title}
                      </h3>
                      <p className="text-[11px] text-neutral-400 line-clamp-1 mb-2">
                        {proj.topic}
                      </p>
                      <div className="flex items-center gap-2 text-[10px] text-neutral-500 mb-3">
                        <span>{beatCount} beats</span>
                        <span>·</span>
                        <span>{new Date(proj.updatedAt || proj.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>

                    {/* Bottom Action Bar */}
                    <div className="pt-2 border-t border-white/6 flex items-center justify-between text-xs">
                      <span className="text-[11px] text-rose-400 font-medium group-hover:underline flex items-center gap-1">
                        <span>Open in Studio</span>
                        <ArrowRight className="w-3 h-3 group-hover:translate-x-0.5 transition" />
                      </span>

                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={(e) => handleDuplicate(proj.id, e)}
                          disabled={actionLoadingId === proj.id}
                          className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-white/8 transition"
                          title="Duplicate Short"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => handleDelete(proj.id, e)}
                          disabled={actionLoadingId === proj.id}
                          className={`p-1.5 rounded-lg transition text-xs font-semibold flex items-center gap-1 ${
                            confirmDeleteId === proj.id
                              ? 'bg-rose-600 text-white px-2'
                              : 'text-neutral-400 hover:text-rose-400 hover:bg-rose-500/10'
                          }`}
                          title={confirmDeleteId === proj.id ? 'Click again to permanently delete' : 'Delete Short'}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          {confirmDeleteId === proj.id && <span>Delete?</span>}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="pt-4 border-t border-white/8 text-xs text-neutral-400 flex items-center justify-between relative z-10 shrink-0">
          <span>{projects.length} saved project{projects.length === 1 ? '' : 's'} in cloud store</span>
          <span className="text-[11px] text-neutral-500">Auto-saved to Forge Studio backend database</span>
        </div>
      </div>
    </div>
  );
};
