import katex from 'katex';
import { useMemo } from 'react';

function decode(s: string) {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

function tex(src: string, display: boolean) {
  try {
    return katex.renderToString(src, { displayMode: display, throwOnError: false });
  } catch {
    return src;
  }
}

// Statements scraped after MathJax ran contain its rendered spans plus the original TeX in <script type="math/tex">.
const MATHJAX_OUTPUT = '.MathJax_Preview, .MathJax, .MathJax_Display, .MathJax_CHTML, .MathJax_SVG, .MJX_Assistive_MathML, .mjx-chtml';

export function renderMath(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.body.querySelectorAll(MATHJAX_OUTPUT).forEach((el) => el.remove());
  doc.body.querySelectorAll('script[type^="math/tex"]').forEach((script) => {
    const span = doc.createElement('span');
    span.innerHTML = tex(script.textContent ?? '', /mode=display/.test(script.getAttribute('type') ?? ''));
    script.replaceWith(span);
  });
  return doc.body.innerHTML
    .replace(/\$\$\$\$\$\$([\s\S]+?)\$\$\$\$\$\$/g, (_, t) => tex(decode(t), true))
    .replace(/\$\$\$([\s\S]+?)\$\$\$/g, (_, t) => tex(decode(t), false));
}

export default function Statement({ html }: { html: string }) {
  const out = useMemo(() => renderMath(html), [html]);
  return <div className="statement" dangerouslySetInnerHTML={{ __html: out }} />;
}
