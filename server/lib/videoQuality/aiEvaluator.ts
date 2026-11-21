import { GoogleGenAI, Type } from '@google/genai';
import type { AiCreativeFinding, AiCreativeReview, Timeline } from './models.ts';

/**
 * AI-assisted creative storytelling evaluator using Gemini (`gemini-4-hydrogen`).
 * Evaluates subjective creative properties (3-second hook strength, narrative continuity,
 * visual-to-script relevance, ending & CTA quality) and ALWAYS requires concrete evidence
 * and explanations — never arbitrary scores.
 *
 * When GEMINI_API_KEY is not configured or the API is unavailable, cleanly returns
 * `mode: 'deterministic_only'` without fabricating AI scores.
 */

const VALID_CRITERIA = new Set(['hook', 'narrative_continuity', 'visual_relevance', 'ending_cta']);

export async function evaluateStoryWithAi(
  timeline: Timeline | null,
  opts: { apiKey?: string; model?: string; timeoutMs?: number; baseUrl?: string } = {},
): Promise<AiCreativeReview> {
  if (!timeline || timeline.beats.length === 0) {
    return {
      mode: 'deterministic_only',
      summary: 'No script beats supplied for creative evaluation.',
      findings: [],
    };
  }
  const apiKey = opts.apiKey?.trim();
  if (!apiKey || apiKey.length < 10 || apiKey.startsWith('MY_') || apiKey.startsWith('your_')) {
    return {
      mode: 'deterministic_only',
      summary: 'Creative storytelling evaluated using deterministic structural checks (GEMINI_API_KEY not configured for AI narrative critique).',
      findings: [],
    };
  }

  const model = opts.model || process.env.QUALITY_AI_MODEL || 'gemini-4-hydrogen';
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: timeoutMs,
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      headers: { 'User-Agent': 'aistudio-build' },
    },
  });

  const sceneList = timeline.beats
    .map((b, i) => `Scene ${i + 1} [${b.start_s.toFixed(1)}s–${b.end_s.toFixed(1)}s] (role: ${b.role || 'unspecified'}, kind: ${b.kind || 'unknown'}, visual: "${b.visual_keywords || b.asset || 'none'}"): "${b.text}"`)
    .join('\n');

  const prompt = `You are a senior short-form video quality director auditing a vertical reel (YouTube Shorts / Reels / TikTok).
Evaluate ONLY the 4 creative criteria below based strictly on the script and scene plan provided.
For EVERY criterion, you MUST cite verbatim evidence from the scenes and explain your reasoning concisely. Do not invent facts.

Total duration: ${timeline.durationS.toFixed(1)}s
Scenes:
${sceneList}

Criteria:
1. "hook": Does the first 3 seconds immediately stop the scroll with curiosity, tension, a sharp question, or a bold claim?
2. "narrative_continuity": Does each beat logically build on the previous beat with clear information progression?
3. "visual_relevance": Do the planned visuals match what is being spoken in each scene without feeling generic or repetitive?
4. "ending_cta": Does the reel land on a satisfying takeaway, payoff, or clear call-to-action?`;

  try {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction: 'Return strict JSON matching the schema. Be calibrated and honest: weak hooks or repetitive visuals should score low with specific evidence.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            findings: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  criterion: { type: Type.STRING },
                  passed: { type: Type.BOOLEAN },
                  score: { type: Type.INTEGER },
                  evidence: { type: Type.STRING },
                  explanation: { type: Type.STRING },
                  suggestion: { type: Type.STRING },
                },
                required: ['criterion', 'passed', 'score', 'evidence', 'explanation'],
              },
            },
          },
          required: ['summary', 'findings'],
        },
        abortSignal: AbortSignal.timeout(timeoutMs),
      },
    });
    const raw = (response.text || '').trim();
    if (!raw) throw new Error('Empty AI evaluation response');
    const parsed = JSON.parse(raw);
    const findings: AiCreativeFinding[] = (Array.isArray(parsed?.findings) ? parsed.findings : [])
      .filter((f: any) => VALID_CRITERIA.has(String(f?.criterion)))
      .map((f: any) => ({
        criterion: f.criterion,
        passed: Boolean(f.passed),
        score: Math.max(0, Math.min(100, Math.round(Number(f.score) || 0))),
        evidence: String(f.evidence || '').slice(0, 300),
        explanation: String(f.explanation || '').slice(0, 400),
        suggestion: f.suggestion ? String(f.suggestion).slice(0, 240) : undefined,
      }));
    if (findings.length === 0) throw new Error('AI evaluation returned no valid criteria');
    return {
      mode: 'ai_assisted',
      model,
      summary: String(parsed.summary || '').slice(0, 400),
      findings,
    };
  } catch (err: any) {
    return {
      mode: 'deterministic_only',
      summary: `AI creative review unavailable (${String(err?.message || err).slice(0, 120)}); evaluated with deterministic narrative checks.`,
      findings: [],
    };
  }
}
