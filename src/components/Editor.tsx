import { useRef, type KeyboardEvent } from "react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onRun?: () => void;
  label: string;
  id: string;
}

const INDENT = "    ";

/** Plain <textarea> editor: fully accessible to screen readers. Tab indents; Ctrl/Cmd+Enter runs; Esc leaves. */
export function Editor({ value, onChange, onRun, label, id }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const rows = Math.min(24, Math.max(4, value.split("\n").length + 1));

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onRun?.();
      return;
    }
    if (e.key === "Escape") { ta.blur(); return; } // keyboard users must be able to leave the editor
    if (e.key !== "Tab") return;
    e.preventDefault();
    const { selectionStart: s, selectionEnd: end } = ta;
    const lineStart = value.lastIndexOf("\n", s - 1) + 1;
    if (e.shiftKey) {
      const line = value.slice(lineStart);
      const n = line.startsWith(INDENT) ? 4 : (line.match(/^ +/)?.[0].length ?? 0);
      if (!n) return;
      onChange(value.slice(0, lineStart) + value.slice(lineStart + n));
      requestAnimationFrame(() => ta.setSelectionRange(Math.max(lineStart, s - n), Math.max(lineStart, end - n)));
    } else {
      onChange(value.slice(0, s) + INDENT + value.slice(end));
      requestAnimationFrame(() => ta.setSelectionRange(s + INDENT.length, s + INDENT.length));
    }
  };

  return (
    <div className="editor">
      <label htmlFor={id} className="sr-only">{label}</label>
      <textarea
        ref={ref}
        id={id}
        className="editor-input"
        value={value}
        rows={rows}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        aria-describedby={`${id}-help`}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <p id={`${id}-help`} className="editor-help">Tab indents · Shift+Tab dedents · Ctrl/⌘+Enter runs · Esc leaves the editor</p>
    </div>
  );
}
