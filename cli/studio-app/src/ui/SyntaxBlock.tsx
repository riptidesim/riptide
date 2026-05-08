import type { CSSProperties, ReactNode } from "react";

type SyntaxLanguage = "plain" | "toml";

interface SyntaxBlockProps {
  content: string;
  language?: SyntaxLanguage;
  maxHeight?: number;
  ariaLabel?: string;
}

interface SyntaxToken {
  text: string;
  kind?: "bare" | "bool" | "comment" | "key" | "number" | "operator" | "punct" | "section" | "string";
}

export function SyntaxBlock({ content, language = "plain", maxHeight = 520, ariaLabel }: SyntaxBlockProps) {
  const lines = content.split(/\r?\n/);
  const displayLines = lines.length > 1 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  const lineCountWidth = String(Math.max(displayLines.length, 1)).length;

  return (
    <pre
      className="syntax-block"
      aria-label={ariaLabel}
      style={{
        maxHeight,
        "--syntax-line-number-width": `${Math.max(3, lineCountWidth + 1)}ch`
      } as CSSProperties}
    >
      {displayLines.map((line, index) => (
        <span className="syntax-line" key={index}>
          <span className="syntax-line__number">{index + 1}</span>
          <code className="syntax-line__code">
            {renderTokens(language === "toml" ? tokenizeTomlLine(line) : [{ text: line }], index)}
          </code>
        </span>
      ))}
    </pre>
  );
}

function renderTokens(tokens: SyntaxToken[], lineIndex: number): ReactNode {
  if (tokens.length === 0 || tokens.every((token) => token.text.length === 0)) {
    return "\u00a0";
  }
  return tokens.map((token, tokenIndex) => {
    if (!token.kind) return token.text;
    return (
      <span className={`syntax-token syntax-token--${token.kind}`} key={`${lineIndex}:${tokenIndex}`}>
        {token.text}
      </span>
    );
  });
}

function tokenizeTomlLine(line: string): SyntaxToken[] {
  const commentIndex = findTomlCommentIndex(line);
  const body = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
  const comment = commentIndex >= 0 ? line.slice(commentIndex) : "";
  const tokens = tokenizeTomlBody(body);
  if (comment) tokens.push({ text: comment, kind: "comment" });
  return tokens;
}

function tokenizeTomlBody(body: string): SyntaxToken[] {
  const section = body.match(/^(\s*)(\[\[?)([^\]]+)(\]\]?)(\s*)$/);
  if (section) {
    const tokens: SyntaxToken[] = [
      { text: section[1] ?? "" },
      { text: section[2] ?? "", kind: "punct" },
      { text: section[3] ?? "", kind: "section" },
      { text: section[4] ?? "", kind: "punct" },
      { text: section[5] ?? "" }
    ];
    return tokens.filter((token) => token.text.length > 0);
  }

  const equalsIndex = findTomlEqualsIndex(body);
  if (equalsIndex >= 0) {
    const keySide = body.slice(0, equalsIndex);
    const valueSide = body.slice(equalsIndex + 1);
    const keyParts = keySide.match(/^(\s*)(.*?)(\s*)$/);
    const tokens: SyntaxToken[] = [
      { text: keyParts?.[1] ?? "" },
      { text: keyParts?.[2] ?? keySide.trim(), kind: "key" },
      { text: keyParts?.[3] ?? "" },
      { text: "=", kind: "operator" },
      ...tokenizeTomlValue(valueSide)
    ];
    return tokens.filter((token) => token.text.length > 0);
  }

  return tokenizeTomlValue(body);
}

function tokenizeTomlValue(value: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    const char = value[cursor]!;
    if (/\s/.test(char)) {
      const start = cursor;
      while (cursor < value.length && /\s/.test(value[cursor]!)) cursor++;
      tokens.push({ text: value.slice(start, cursor) });
      continue;
    }

    if (char === "\"" || char === "'") {
      const end = findTomlStringEnd(value, cursor, char);
      tokens.push({ text: value.slice(cursor, end), kind: "string" });
      cursor = end;
      continue;
    }

    if ("[]{}(),.".includes(char)) {
      tokens.push({ text: char, kind: "punct" });
      cursor++;
      continue;
    }

    const rest = value.slice(cursor);
    const number = rest.match(/^[-+]?(?:0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][-+]?\d[\d_]*)?)/);
    if (number) {
      tokens.push({ text: number[0], kind: "number" });
      cursor += number[0].length;
      continue;
    }

    const bool = rest.match(/^(true|false)\b/);
    if (bool) {
      tokens.push({ text: bool[0], kind: "bool" });
      cursor += bool[0].length;
      continue;
    }

    const bare = rest.match(/^[^\s\[\]{}(),.]+/);
    if (bare) {
      tokens.push({ text: bare[0], kind: "bare" });
      cursor += bare[0].length;
      continue;
    }

    tokens.push({ text: char });
    cursor++;
  }

  return tokens;
}

function findTomlCommentIndex(line: string): number {
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quote) {
      if (quote === "\"" && char === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (char === quote && !escaped) quote = null;
      escaped = false;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      escaped = false;
      continue;
    }
    if (char === "#") return index;
  }
  return -1;
}

function findTomlEqualsIndex(line: string): number {
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quote) {
      if (quote === "\"" && char === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (char === quote && !escaped) quote = null;
      escaped = false;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      escaped = false;
      continue;
    }
    if (char === "=") return index;
  }
  return -1;
}

function findTomlStringEnd(value: string, start: number, quote: string): number {
  let escaped = false;
  for (let index = start + 1; index < value.length; index++) {
    const char = value[index]!;
    if (quote === "\"" && char === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if (char === quote && !escaped) return index + 1;
    escaped = false;
  }
  return value.length;
}
