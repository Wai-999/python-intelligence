import { Fragment, type ReactNode } from "react";

/**
 * Safe Markdown subset: paragraphs, "- " lists, "1. " lists, ```python fences, `code`, **bold**, *italic*.
 * Builds React elements only (no innerHTML), so lesson text can never inject markup or script.
 */
export function Prose({ text }: { text: string }) {
  return <div className="prose">{blocks(text)}</div>;
}

function blocks(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") { i++; continue; }
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || "python";
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++; // closing fence
      out.push(<pre key={key++} className="code-block" data-lang={lang}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const ul = /^\s*[-*] /;
    const ol = /^\s*\d+\. /;
    if (ul.test(line) || ol.test(line)) {
      const ordered = ol.test(line);
      const re = ordered ? ol : ul;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i]!)) {
        let item = lines[i++]!.replace(re, "");
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !re.test(lines[i]!)) item += " " + lines[i++]!.trim();
        items.push(item);
      }
      const Tag = ordered ? "ol" : "ul";
      out.push(<Tag key={key++}>{items.map((it, j) => <li key={j}>{inline(it)}</li>)}</Tag>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !lines[i]!.startsWith("```") && !ul.test(lines[i]!) && !ol.test(lines[i]!))
      para.push(lines[i++]!.trim());
    out.push(<p key={key++}>{inline(para.join(" "))}</p>);
  }
  return out;
}

export function inline(s: string): ReactNode {
  const parts: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) parts.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**")) parts.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else parts.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return <Fragment>{parts}</Fragment>;
}
