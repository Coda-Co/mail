import { useEffect, useMemo, useRef, useState } from 'react';
import fontUrl from '../assets/fonts/Geist-Variable.woff2?url';
import { api } from '../api';

// Mail HTML is rendered in a sandboxed iframe: no scripts (sandbox without
// allow-scripts), a strict CSP, and links opened in the system browser.

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
body{font-family:Geist,system-ui,sans-serif;font-size:15px;line-height:1.65;color:${text};overflow-wrap:anywhere}
p{margin:0 0 1.65em}p:last-child{margin-bottom:0}
img{max-width:100%;height:auto}
a{color:${link}}
blockquote{margin:0 0 1em;padding-left:12px;border-left:3px solid #DDE1E6;color:#4A5260}
table{max-width:100%}
hr{border:none;border-top:1px solid #E4E7EB;margin:16px 0}
</style></head><body>${html}</body></html>`;
}

export function MessageBody({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(48);
  const dark = document.documentElement.dataset.theme === 'dark';
  const doc = useMemo(() => srcdoc(html, dark), [html, dark]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;
    const onLoad = () => {
      const d = frame.contentDocument;
      if (!d) return;
      const measure = () => setHeight(Math.max(24, d.documentElement.scrollHeight));
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
    };
    frame.addEventListener('load', onLoad);
    return () => {
      frame.removeEventListener('load', onLoad);
      observer?.disconnect();
    };
  }, [doc]);

  return <iframe ref={ref} className="message-body-frame" title="Message" sandbox="allow-same-origin" srcDoc={doc} style={{ height, colorScheme: dark ? 'dark' : 'light' }} />;
}
