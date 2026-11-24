import { useEffect, useMemo, useRef, useState } from 'react';
import fontUrl from '../assets/fonts/Geist-Variable.woff2?url';
import { api } from '../api';

// Mail HTML is rendered in a sandboxed iframe: no scripts (sandbox without
// allow-scripts), a strict CSP, and links opened in the system browser.
// The base styles below are only defaults: the sender's own <style> blocks and inline
// styles come later / are more specific, so their fonts and spacing win, as in Outlook.

function srcdoc(html: string, dark: boolean): string {
  const font = new URL(fontUrl, window.location.href).href;
  const text = dark ? '#E6E8EB' : '#1F2328';
  const link = dark ? '#5A98E8' : '#0B5CC4';
  const csp = "default-src 'none'; img-src data: cid: https: http:; style-src 'unsafe-inline'; font-src 'self' data: " + new URL(font).origin;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="color-scheme" content="${dark ? 'dark' : 'light'}">
<style>
@font-face{font-family:Geist;src:url(${font}) format('woff2');font-weight:100 900}
html{color-scheme:${dark ? 'dark' : 'light'}}
html,body{margin:0;padding:0;background:transparent}
body{font-family:Geist,system-ui,sans-serif;font-size:15px;line-height:1.4;color:${text};overflow-wrap:anywhere}
body>:last-child{margin-bottom:0}
img{max-width:100%;height:auto}
a{color:${link}}
blockquote{margin:0 0 1em;padding-left:12px;border-left:3px solid #DDE1E6;color:#4A5260}
table{max-width:100%}
hr{border:none;border-top:1px solid #E4E7EB;margin:16px 0}
</style></head><body>${html}</body></html>`;
}

// Last measured height per message, so reopening one lays out at its real size at once.
const heights = new Map<string, number>();
function remember(key: string, h: number) {
  heights.delete(key);
  heights.set(key, h);
  if (heights.size > 500) heights.delete(heights.keys().next().value!);
}

export function MessageBody({ html, cacheKey }: { html: string; cacheKey?: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const cached = cacheKey ? heights.get(cacheKey) : undefined;
  const [height, setHeight] = useState(cached ?? 48);
  // Hidden until first measured: a frame or two of nothing beats a clipped box that jumps.
  const [measured, setMeasured] = useState(cached !== undefined);
  const dark = document.documentElement.dataset.theme === 'dark';
  const doc = useMemo(() => srcdoc(html, dark), [html, dark]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;
    let attached: Document | null = null;
    let raf = 0;
    // Size the frame as soon as the srcdoc is parsed, not on `load`: `load` waits for
    // every remote image, which can take seconds on a newsletter.
    const attach = () => {
      const d = frame.contentDocument;
      if (!d || d === attached || d.URL !== 'about:srcdoc' || !d.body) return false;
      attached = d;
      const measure = () => {
        const h = Math.max(24, d.documentElement.scrollHeight);
        setHeight(h);
        setMeasured(true);
        if (cacheKey) remember(cacheKey, h);
      };
      measure();
      observer?.disconnect();
      observer = new ResizeObserver(measure);
      observer.observe(d.body);
      d.addEventListener('click', (e) => {
        const a = (e.target as Element).closest?.('a');
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute('href') ?? '';
        if (/^(https?:|mailto:)/i.test(href)) api.openExternal(href);
      });
      // Re-measure after fonts and images settle.
      setTimeout(measure, 100);
      setTimeout(measure, 600);
      return true;
    };
    const poll = () => {
      if (!attach()) raf = requestAnimationFrame(poll);
    };
    poll();
    const onLoad = () => {
      attach();
      setMeasured(true);
    };
    frame.addEventListener('load', onLoad);
    return () => {
      cancelAnimationFrame(raf);
      frame.removeEventListener('load', onLoad);
      observer?.disconnect();
    };
  }, [doc, cacheKey]);

  return <iframe ref={ref} className="message-body-frame" title="Message" sandbox="allow-same-origin" srcDoc={doc} style={{ height, visibility: measured ? undefined : 'hidden', colorScheme: dark ? 'dark' : 'light' }} />;
}
