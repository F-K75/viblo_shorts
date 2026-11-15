import type express from 'express';
import type { Repo } from '../lib/repo.ts';

export interface ProjectRoutesDeps {
  rateLimit: (group: string, maxPerMinute: number, opts?: { ai?: boolean }) => express.RequestHandler;
  getRepo: () => Repo;
  uid: (req: express.Request) => string;
  isAdmin: (req: express.Request) => boolean;
  sampleProject: any;
  sampleId: string;
  adminListLimit: number;
  projectIdRe: RegExp;
  projectFields: readonly string[];
  maxProjectBytes: number;
  newProjectId: () => string;
  sanitizeString: (input: unknown, maxLength?: number) => string;
}

const byUpdatedDesc = (a: any, b: any) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();

/**
 * Registers owner-isolated project CRUD and duplication endpoints.
 */
export function registerProjectRoutes(app: express.Express, deps: ProjectRoutesDeps): void {
  const {
    rateLimit,
    getRepo,
    uid,
    isAdmin,
    sampleProject,
    sampleId,
    adminListLimit,
    projectIdRe,
    projectFields,
    maxProjectBytes,
    newProjectId,
    sanitizeString,
  } = deps;

  /** The project if the caller may read it (owner or admin); otherwise null (callers answer 404, never 403). */
  async function readableProject(req: express.Request, id: string) {
    const found = await getRepo().getProject(id);
    if (!found || !(found.ownerId === uid(req) || isAdmin(req))) return null;
    return found;
  }

  app.get('/api/projects', rateLimit('projects-read', 120), async (req, res) => {
    const repo = getRepo();
    if (isAdmin(req) && req.query.all === '1') {
      const { projects, unreadable } = await repo.listAllProjects(adminListLimit);
      return res.json({ success: true, projects: [...projects.sort(byUpdatedDesc), sampleProject], unreadableShards: unreadable });
    }
    const mine = (await repo.listProjects(uid(req))).sort(byUpdatedDesc);
    res.json({ success: true, projects: [...mine, sampleProject] });
  });

  app.get('/api/projects/:id', rateLimit('projects-read', 120), async (req, res) => {
    if (req.params.id === sampleId) return res.json({ success: true, project: sampleProject });
    const found = await readableProject(req, req.params.id);
    // 404 (not 403) for other users' projects so ids cannot be enumerated.
    if (!found) return res.status(404).json({ error: 'Project not found' });
    res.json({ success: true, project: found.project });
  });

  app.post('/api/projects', rateLimit('projects-write', 60), async (req, res) => {
    const payload = req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ error: 'Invalid project payload' });
    }
    const title = sanitizeString(payload.title, 200);
    if (!title) return res.status(400).json({ error: 'Project title is required' });
    if (payload.id !== undefined && (typeof payload.id !== 'string' || !projectIdRe.test(payload.id))) {
      return res.status(400).json({ error: 'Invalid project id format' });
    }
    if (payload.id === sampleId) {
      return res.status(409).json({ error: 'The sample project is read-only. Save it as a new project instead.', code: 'sample_read_only' });
    }
    if (payload.script !== undefined && (typeof payload.script !== 'object' || !Array.isArray(payload.script?.beats))) {
      return res.status(400).json({ error: 'script.beats must be an array' });
    }

    const clean: Record<string, any> = {};
    for (const f of projectFields) if (payload[f] !== undefined) clean[f] = payload[f];
    clean.title = title;
    if (Buffer.byteLength(JSON.stringify(clean)) > maxProjectBytes) {
      return res.status(413).json({ error: `Project is too large (max ${Math.round(maxProjectBytes / 1024)} KB).`, code: 'project_too_large' });
    }

    const repo = getRepo();
    const userId = uid(req);
    let id: string = payload.id;
    let existing: any = null;
    if (id) {
      const found = await repo.getProject(id);
      if (found && found.ownerId !== userId) return res.status(404).json({ error: 'Project not found' });
      existing = found?.project ?? null;
      // Ids are always server-issued: an unknown client id is treated as a new project with a fresh id.
      if (!existing) id = newProjectId();
    } else {
      id = newProjectId();
    }
    const now = new Date().toISOString();
    const project = { ...clean, id, userId, createdAt: existing?.createdAt || now, updatedAt: now };
    // Ownership and quotas are re-checked atomically inside saveProject (ProjectOwnershipError -> 404). An update must
    // not re-create a project deleted since it was read above (F8: ProjectNotFoundError -> the same 404).
    await repo.saveProject(userId, project, { mustExist: Boolean(existing) });
    res.json({ success: true, project });
  });

  app.delete('/api/projects/:id', rateLimit('projects-write', 60), async (req, res) => {
    if (req.params.id === sampleId) return res.status(400).json({ error: 'Cannot delete the built-in sample project' });
    const found = await readableProject(req, req.params.id);
    if (!found || !(await getRepo().deleteProject(found.ownerId, req.params.id))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json({ success: true, message: 'Project deleted' });
  });

  app.post('/api/projects/:id/duplicate', rateLimit('projects-write', 60), async (req, res) => {
    const existing = req.params.id === sampleId ? sampleProject : (await readableProject(req, req.params.id))?.project;
    if (!existing) return res.status(404).json({ error: 'Source project not found' });
    const now = new Date().toISOString();
    const { isSample: _ignored, ...rest } = JSON.parse(JSON.stringify(existing));
    const duplicated = {
      ...rest,
      id: newProjectId(),
      userId: uid(req),
      title: `${existing.title} (Copy)`.slice(0, 200),
      createdAt: now,
      updatedAt: now,
    };
    await getRepo().saveProject(uid(req), duplicated);
    res.json({ success: true, project: duplicated });
  });
}

