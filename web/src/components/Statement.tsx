import katex from 'katex';
import { useMemo } from 'react';

function decode(s: string) {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

function tex(src: string, display: boolean) {
  try {
    return katex.renderToString(decode(src), { displayMode: display, throwOnError: false });
  } catch {
    return src;
  }
}

export function renderMath(html: string) {
  return html
    .replace(/\$\$\$\$\$\$([\s\S]+?)\$\$\$\$\$\$/g, (_, t) => tex(t, true))
    .replace(/\$\$\$([\s\S]+?)\$\$\$/g, (_, t) => tex(t, false));
}

export default function Statement({ html }: { html: string }) {
  const out = useMemo(() => renderMath(html), [html]);
  return <div className="statement" dangerouslySetInnerHTML={{ __html: out }} />;
}
