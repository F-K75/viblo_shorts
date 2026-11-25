// Collects Content-Security-Policy violations in a Playwright page (FS-013: "zero CSP violations in E2E").
// Two independent signals: the `securitypolicyviolation` DOM event (reported through an exposed binding, so it
// survives reloads and navigations) and Chromium's console message for blocked loads. Third-party iframes (YouTube,
// Turnstile, Firebase) enforce their own policies; only violations of OUR policy in our documents are collected.
export interface CspViolation {
  source: 'event' | 'console';
  text: string;
}

export async function watchCspViolations(page: any, appOrigin: string): Promise<CspViolation[]> {
  const violations: CspViolation[] = [];
  const origin = new URL(appOrigin).origin;
  await page.exposeBinding('__reportCspViolation', (src: { frame: any }, text: string) => {
    let frameOrigin = '';
    try {
      frameOrigin = new URL(src.frame.url()).origin;
    } catch {
      // about:blank etc.: treat as ours (it inherits our policy)
    }
    if (!frameOrigin || frameOrigin === 'null' || frameOrigin === origin) violations.push({ source: 'event', text });
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e: SecurityPolicyViolationEvent) => {
      (window as any).__reportCspViolation(`${e.effectiveDirective} blocked ${e.blockedURI || '(inline)'} (${e.sourceFile || ''}:${e.lineNumber})`);
    });
  });
  page.on('console', (msg: any) => {
    const text: string = msg.text();
    if (/Content Security Policy/i.test(text)) violations.push({ source: 'console', text });
  });
  return violations;
}

export const formatViolations = (v: CspViolation[]) => v.map((x) => `[${x.source}] ${x.text}`).join('\n');
