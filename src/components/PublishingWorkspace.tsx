"use client";

import { track } from "@/lib/firebase";
import { useEffect, useRef, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { toast } from "sonner";
import {
  Copy,
  FileText,
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  Settings,
  BookOpen,
  RefreshCw,
  ImageIcon,
  Table,
  X,
  HelpCircle,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ArticleRef {
  label: string;
  file: string;
  title: string;
  words: number;
  slug: string;
}

// ── Markdown checker ──────────────────────────────────────────────────────────
// Standard markdown correctness + Medium-conversion gotchas. Each issue carries
// the 1-based line it sits on so it can be shown inline in the editor gutter.

type IssueLevel = "error" | "warn" | "info";
interface Issue {
  level: IssueLevel;
  msg: string;
  line: number;
}

function lintMarkdown(md: string): Issue[] {
  const issues: Issue[] = [];
  if (!md.trim()) return issues;
  const lines = md.split("\n");
  const lineAt = (index: number) => md.slice(0, index).split("\n").length;

  // — Markdown correctness —
  const fenceLines = lines.flatMap((ln, i) => (/^```/.test(ln) ? [i + 1] : []));
  if (fenceLines.length % 2 !== 0)
    issues.push({ level: "error", line: fenceLines[fenceLines.length - 1], msg: "Unclosed code fence — ``` markers must come in pairs" });

  [...md.matchAll(/!\[([^\]]*)\]\(([^)]*)\)/g)].forEach((m, i) => {
    const line = lineAt(m.index ?? 0);
    if (!m[2].trim()) issues.push({ level: "error", line, msg: `Image ${i + 1} has an empty URL` });
    else if (!m[1].trim()) issues.push({ level: "warn", line, msg: `Image ${i + 1} has no alt text` });
  });

  [...md.matchAll(/(?<!!)\[([^\]]*)\]\(([^)]*)\)/g)].forEach((m) => {
    const line = lineAt(m.index ?? 0);
    if (!m[2].trim()) issues.push({ level: "error", line, msg: `Link "${m[1] || "?"}" has an empty URL` });
    else if (!m[1].trim()) issues.push({ level: "warn", line, msg: "A link has empty text" });
  });

  // — Headings (Medium supports H1–H3; first H1 becomes the title) —
  let h1Count = 0;
  lines.forEach((ln, idx) => {
    const h = ln.match(/^(#{1,6})\s*(.*)$/);
    if (!h) return;
    const line = idx + 1;
    const level = h[1].length;
    if (!h[2].trim()) issues.push({ level: "warn", line, msg: "Empty heading" });
    if (level > 3) issues.push({ level: "warn", line, msg: `Heading level ${level} — Medium supports only H1–H3` });
    if (level === 1) {
      h1Count++;
      if (h1Count === 2) issues.push({ level: "info", line, msg: "Second H1 — Medium uses only the first as the article title" });
    }
  });

  // — Medium-conversion gotchas — (tables are handled by the Tables panel, so no warning)
  lines.forEach((ln, idx) => {
    const line = idx + 1;
    if (/\[\^[^\]]+\]/.test(ln))
      issues.push({ level: "warn", line, msg: "Medium doesn't support footnotes" });
    if (!/^```/.test(ln) && /<\/?[a-zA-Z][^>]*>/.test(ln))
      issues.push({ level: "info", line, msg: "Raw HTML is usually stripped by Medium on paste" });
  });

  return issues.sort((a, b) => a.line - b.line);
}

// ── Tables → image (Medium has no native tables) ──────────────────────────────

type Align = "left" | "center" | "right";
interface ParsedTable {
  n: number;
  headers: string[];
  rows: string[][];
  align: Align[];
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function parseTables(md: string): ParsedTable[] {
  const lines = md.split("\n");
  const tables: ParsedTable[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i];
    const sep = lines[i + 1];
    const isHead = head.includes("|");
    const isSep = sep && /^\s*\|?[\s:|-]+\|[\s:|-]+\s*$/.test(sep);
    if (isHead && isSep) {
      const headers = splitRow(head);
      const align: Align[] = splitRow(sep).map((c) => {
        const l = c.startsWith(":");
        const r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : "left";
      });
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes("|")) {
        rows.push(splitRow(lines[j]));
        j++;
      }
      tables.push({ n: tables.length + 1, headers, rows, align });
      i = j - 1;
    }
  }
  return tables;
}

// One styled span of a cell (markdown emphasis becomes real font styling)
interface Run { t: string; b?: boolean; i?: boolean; m?: boolean; }

function inlineRuns(s: string): Run[] {
  const clean = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\(([^)]+)\)/g, "$1");
  const runs: Run[] = [];
  const re = /(\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|`([^`]+)`)/g;
  let last = 0;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(clean))) {
    if (mm.index > last) runs.push({ t: clean.slice(last, mm.index) });
    if (mm[2] != null) runs.push({ t: mm[2], b: true, i: true });
    else if (mm[3] != null) runs.push({ t: mm[3], b: true });
    else if (mm[4] != null) runs.push({ t: mm[4], b: true });
    else if (mm[5] != null) runs.push({ t: mm[5], i: true });
    else if (mm[6] != null) runs.push({ t: mm[6], i: true });
    else if (mm[7] != null) runs.push({ t: mm[7], m: true });
    last = re.lastIndex;
  }
  if (last < clean.length) runs.push({ t: clean.slice(last) });
  return runs.length ? runs : [{ t: clean }];
}

function stripInline(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\(([^)]+)\)/g, "$1")
    .replace(/(\*{1,3}|_{1,3})([^*_]+)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1");
}

// Render a table to a crisp PNG following IMAGE-STYLE-GUIDE: white canvas,
// deep-indigo header band with ALL-CAPS white labels, ink body, hairline grid.
// Inline markdown inside cells (**bold**, *italic*, `code`, [text](url)) is honored.
async function renderTablePng(t: ParsedTable): Promise<Blob> {
  const SANS = 'Inter, "Helvetica Neue", Arial, sans-serif';
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  const INK = "#0F172A";
  const INDIGO = "#312E81";
  const HAIRLINE = "#E2E8F0";
  const VLINE = "#EEF1F5";
  try { await (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready; } catch { /* ignore */ }

  const dpr = 2;
  const padX = 24;
  const headerSize = 13;
  const bodySize = 16;
  const headerPadY = 16;
  const bodyPadY = 14;
  const cols = t.headers.length;
  const headerFont = `700 ${headerSize}px ${SANS}`;
  const runFont = (r: Run) => `${r.i ? "italic " : ""}${r.b ? "700 " : "400 "}${bodySize}px ${r.m ? MONO : SANS}`;
  const headerText = t.headers.map((h) => stripInline(h).toUpperCase());
  const bodyRuns = t.rows.map((row) => Array.from({ length: cols }, (_, ci) => inlineRuns(row[ci] ?? "")));

  const m = document.createElement("canvas").getContext("2d")!;
  const runWidth = (r: Run) => { m.font = runFont(r); return m.measureText(r.t).width; };
  const cellWidth = (runs: Run[]) => runs.reduce((w, r) => w + runWidth(r), 0);

  const colW = new Array(cols).fill(0);
  m.font = headerFont;
  m.letterSpacing = "0.06em";
  headerText.forEach((h, ci) => { colW[ci] = Math.max(colW[ci], m.measureText(h).width); });
  m.letterSpacing = "0px";
  bodyRuns.forEach((row) => {
    for (let ci = 0; ci < cols; ci++) colW[ci] = Math.max(colW[ci], cellWidth(row[ci]));
  });
  const colWidths = colW.map((w) => Math.ceil(w) + padX * 2);
  const headerH = headerSize + headerPadY * 2;
  const bodyH = bodySize + bodyPadY * 2;
  const tableW = colWidths.reduce((a, b) => a + b, 0);
  const tableH = headerH + bodyH * t.rows.length;

  const canvas = document.createElement("canvas");
  canvas.width = tableW * dpr;
  canvas.height = tableH * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, tableW, tableH);
  ctx.fillStyle = INDIGO;
  ctx.fillRect(0, 0, tableW, headerH);
  ctx.textBaseline = "middle";

  const colX: number[] = [];
  let acc = 0;
  for (let c = 0; c < cols; c++) { colX[c] = acc; acc += colWidths[c]; }

  // Header — uppercase, letter-spaced, centered/aligned per column
  ctx.font = headerFont;
  ctx.fillStyle = "#FFFFFF";
  ctx.letterSpacing = "0.06em";
  ctx.textAlign = "left";
  headerText.forEach((h, ci) => {
    const align = t.align[ci] ?? "left";
    const w = m.measureText(h).width; // measuring ctx still has header font + spacing
    let x = colX[ci] + padX;
    if (align === "right") x = colX[ci] + colWidths[ci] - padX - w;
    else if (align === "center") x = colX[ci] + (colWidths[ci] - w) / 2;
    ctx.fillText(h, x, headerH / 2);
  });
  ctx.letterSpacing = "0px";

  // Body — draw each run with its own font, advancing x
  ctx.fillStyle = INK;
  ctx.textAlign = "left";
  bodyRuns.forEach((row, ri) => {
    const y = headerH + ri * bodyH + bodyH / 2;
    for (let ci = 0; ci < cols; ci++) {
      const runs = row[ci];
      const align = t.align[ci] ?? "left";
      const w = cellWidth(runs);
      let x = colX[ci] + padX;
      if (align === "right") x = colX[ci] + colWidths[ci] - padX - w;
      else if (align === "center") x = colX[ci] + (colWidths[ci] - w) / 2;
      for (const r of runs) {
        ctx.font = runFont(r);
        ctx.fillStyle = r.m ? "#334155" : INK;
        ctx.fillText(r.t, x, y);
        x += runWidth(r);
      }
    }
  });

  ctx.lineWidth = 1;
  ctx.strokeStyle = VLINE;
  for (let c = 1; c < cols; c++) {
    ctx.beginPath();
    ctx.moveTo(colX[c] + 0.5, headerH);
    ctx.lineTo(colX[c] + 0.5, tableH);
    ctx.stroke();
  }
  ctx.strokeStyle = HAIRLINE;
  for (let r = 1; r < t.rows.length; r++) {
    const y = headerH + r * bodyH + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(tableW, y);
    ctx.stroke();
  }
  ctx.strokeRect(0.5, 0.5, tableW - 1, tableH - 1);

  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png")
  );
}

// ── Markdown guide ────────────────────────────────────────────────────────────

const GUIDE: { md: string; note: string }[] = [
  { md: "# Heading 1", note: "Article title (one per piece)" },
  { md: "## Heading 2", note: "Section — make it a claim" },
  { md: "**bold**  ·  *italic*", note: "Emphasis" },
  { md: "[link text](https://url)", note: "Link" },
  { md: "![alt text](image.png)", note: "Image — local images paste via the Images panel" },
  { md: "> quote", note: "Blockquote (Medium pull-quote)" },
  { md: "- item", note: "Bullet list" },
  { md: "1. item", note: "Numbered list" },
  { md: "`code`", note: "Inline code" },
  { md: "```\nblock\n```", note: "Code block" },
  { md: "---", note: "Section divider" },
  { md: "| a | b |\n|---|---|", note: "Table" },
];

function MarkdownGuide({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center pt-20" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[70vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-3 border-b border-[#E2E8F0]">
          <span className="font-semibold text-sm">Markdown cheatsheet</span>
          <button onClick={onClose} className="p-1 rounded hover:bg-[#F1F5F9] text-[#64748B]"><X className="w-4 h-4" /></button>
        </div>
        <div className="overflow-y-auto custom-scroll p-3 space-y-1.5">
          {GUIDE.map((g) => (
            <div key={g.note} className="flex items-center gap-3 text-sm">
              <code className="flex-1 bg-[#F8FAFC] border border-[#E2E8F0] rounded px-2 py-1 font-mono text-xs whitespace-pre text-[#0F172A]">{g.md}</code>
              <span className="flex-1 text-[#64748B] text-xs">{g.note}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Setup screen ─────────────────────────────────────────────────────────────

function SetupScreen({ onSave, onEditorOnly }: { onSave: (p: string) => void; onEditorOnly: () => void }) {
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save(pathStr: string) {
    const trimmed = pathStr.trim();
    if (!trimmed) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ articlesPath: trimmed }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Directory not found — paste the full absolute path");
      } else {
        onSave(trimmed);
      }
    } catch {
      setError("Could not reach server");
    } finally {
      setSaving(false);
    }
  }

  function handleSave() {
    save(input);
  }

  // Open the native OS folder dialog (server-side) and save the chosen path
  async function handleBrowse() {
    setError("");
    try {
      const res = await fetch("/api/pick-folder", { method: "POST" });
      const data = await res.json() as { path?: string; error?: string };
      if (res.ok && data.path) {
        setInput(data.path);
        await save(data.path);
      } else if (data.error && data.error !== "canceled") {
        setError("Native picker unavailable — paste the path below instead");
      }
    } catch {
      setError("Native picker unavailable — paste the path below instead");
    }
  }

  return (
    <div className="flex flex-col items-center justify-center h-screen bg-white text-[#0F172A]">
      <div className="w-full max-w-md px-8">
        <div className="flex items-center gap-3 mb-8">
          <span className="bg-[#4F46E5] text-white text-sm font-bold w-8 h-8 flex items-center justify-center rounded">
            M
          </span>
          <span className="text-xl font-semibold tracking-tight">Medium Workspace</span>
        </div>

        <h1 className="text-2xl font-bold mb-2">Set your articles folder</h1>
        <p className="text-[#64748B] text-sm mb-6">
          Point to the directory that contains your article subfolders. Each
          subfolder should hold a <code className="bg-[#F1F5F9] px-1 py-0.5 rounded text-xs">.medium.md</code> file and any images.
        </p>

        {/* Native OS folder picker */}
        <button
          type="button"
          onClick={handleBrowse}
          disabled={saving}
          className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-[#E2E8F0] rounded-lg py-4 text-sm text-[#64748B] hover:border-[#4F46E5] hover:text-[#4F46E5] transition-colors mb-3 cursor-pointer disabled:opacity-50"
        >
          <FolderOpen className="w-5 h-5" />
          {saving ? "Opening…" : "Choose folder…"}
        </button>

        <p className="text-xs text-[#94A3B8] mb-2">
          Or paste the full absolute path:
        </p>

        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            placeholder="/Users/you/Desktop/medium/articles"
            className="flex-1 border border-[#E2E8F0] rounded-md px-3 py-2 text-sm font-mono outline-none focus:border-[#4F46E5] bg-[#FAFAFA]"
            autoFocus
          />
          <Button
            onClick={handleSave}
            disabled={!input.trim() || saving}
            className="bg-[#4F46E5] text-white hover:bg-[#4338CA] shrink-0"
          >
            {saving ? "Saving…" : "Open"}
          </Button>
        </div>

        {error && (
          <p className="text-sm text-red-500 flex items-center gap-1 mt-1">
            <AlertTriangle className="w-3.5 h-3.5" />
            {error}
          </p>
        )}

        <p className="text-xs text-[#94A3B8] mt-4">
          Tip: open Terminal in your articles folder and run{" "}
          <code className="bg-[#F1F5F9] px-1 py-0.5 rounded">pwd</code>, then paste here.
        </p>

        <div className="flex items-center gap-3 my-5">
          <span className="flex-1 h-px bg-[#E2E8F0]" />
          <span className="text-[10px] text-[#CBD5E1] uppercase tracking-widest">or</span>
          <span className="flex-1 h-px bg-[#E2E8F0]" />
        </div>

        <button
          type="button"
          onClick={onEditorOnly}
          className="w-full text-sm text-[#4F46E5] hover:underline"
        >
          Just open the editor — paste Markdown, no folder needed →
        </button>
      </div>
    </div>
  );
}

// ── Main workspace ────────────────────────────────────────────────────────────

// True when built for GitHub Pages — no server, no API routes, editor-only.
const IS_STATIC = process.env.NEXT_PUBLIC_STATIC_MODE === '1';

export default function PublishingWorkspace() {
  const [configured, setConfigured] = useState<boolean | null>(IS_STATIC ? false : null);
  const [articlesPath, setArticlesPath] = useState<string>("");
  const [articles, setArticles] = useState<ArticleRef[]>([]);
  const [activeFile, setActiveFile] = useState<string>("");
  const [markdown, setMarkdown] = useState<string>("");
  const [slug, setSlug] = useState<string>("");
  const [showSettings, setShowSettings] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [editorOnly, setEditorOnly] = useState(IS_STATIC);
  const [refreshing, setRefreshing] = useState(false);
  const [formatting, setFormatting] = useState(false);
  const [tableImgs, setTableImgs] = useState<string[]>([]);
  const [activePanel, setActivePanel] = useState<"editor" | "preview">("editor");
  const previewRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Check config on mount (skipped in static/hosted mode — no server available)
  useEffect(() => {
    if (IS_STATIC) return;
    fetch("/api/config")
      .then((r) => r.json())
      .then((d: { articlesPath: string | null }) => {
        if (d.articlesPath) {
          setArticlesPath(d.articlesPath);
          setConfigured(true);
        } else {
          setConfigured(false);
        }
      })
      .catch(() => setConfigured(false));
  }, []);

  // Render each table to the exact PNG the user will copy, so the preview matches
  useEffect(() => {
    const tbs = parseTables(markdown);
    if (tbs.length === 0) { setTableImgs([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const urls = await Promise.all(
        tbs.map(async (tb) => {
          try {
            const blob = await renderTablePng(tb);
            return await new Promise<string>((resolve) => {
              const fr = new FileReader();
              fr.onload = () => resolve(fr.result as string);
              fr.readAsDataURL(blob);
            });
          } catch {
            return "";
          }
        })
      );
      if (!cancelled) setTableImgs(urls);
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [markdown]);

  const loadArticleList = useCallback(async () => {
    try {
      const res = await fetch("/api/articles");
      if (res.status === 412) { setConfigured(false); return; }
      if (!res.ok) throw new Error("Failed");
      const data = await res.json() as { articles: ArticleRef[] };
      setArticles(data.articles ?? []);
      return data.articles ?? [];
    } catch {
      toast.error("Could not load article list");
      return [];
    }
  }, []);

  const loadArticle = useCallback(async (file: string) => {
    try {
      const res = await fetch(`/api/articles?file=${encodeURIComponent(file)}`);
      if (!res.ok) throw new Error("Failed to load article");
      const data = await res.json() as { content: string };
      setMarkdown(data.content);
      setActiveFile(file);
      setSlug(file.split("/")[0]);
      track("article_selected", { slug: file.split("/")[0] });
    } catch {
      toast.error("Failed to load article");
    }
  }, []);

  // Load articles once configured
  useEffect(() => {
    if (!configured) return;
    loadArticleList().then((list) => {
      if (list && list.length > 0 && !activeFile) {
        loadArticle(list[0].file);
      }
    });
  }, [configured, loadArticleList, loadArticle, activeFile]);

  const refresh = async () => {
    setRefreshing(true);
    const list = await loadArticleList();
    if (list && activeFile) {
      const still = list.find((a) => a.file === activeFile);
      if (still) await loadArticle(activeFile);
    }
    setRefreshing(false);
    toast.success("Refreshed");
    track("articles_refreshed");
  };

  // Copy the article as rich HTML, replacing each local <img> with a numbered
  // placeholder. Medium strips data:/localhost images on paste, so images are
  // pasted separately as real image blobs (see copyImage).
  const copyForMedium = async () => {
    if (!previewRef.current) return;
    try {
      const clone = previewRef.current.cloneNode(true) as HTMLElement;
      // Tables (rendered as images, or the HTML fallback) → markers; paste from Tables panel
      let tn = 0;
      clone.querySelectorAll("img[data-table], table").forEach((el) => {
        tn += 1;
        const marker = document.createElement("p");
        marker.textContent = `⟦ Table ${tn} — select this line, then paste image ⟧`;
        (el.closest(".overflow-x-auto") ?? el).replaceWith(marker);
      });
      // Content images → markers (Medium strips data:/localhost imgs on paste)
      const imgs = clone.querySelectorAll<HTMLImageElement>("img[src]:not([data-table])");
      imgs.forEach((img, i) => {
        const src = img.getAttribute("src") ?? "";
        // Leave genuinely remote (non-localhost https) images alone
        if (src.startsWith("http") && !src.startsWith("http://localhost")) return;
        const alt = img.getAttribute("alt")?.trim();
        const marker = document.createElement("p");
        marker.textContent = `⟦ Image ${i + 1} — select this line, then paste image ⟧`;
        img.replaceWith(marker);
        // Emit the alt text as an italic caption line right below the image
        if (alt) {
          const caption = document.createElement("p");
          const em = document.createElement("em");
          em.textContent = alt;
          caption.appendChild(em);
          marker.after(caption);
        }
      });
      const html = clone.innerHTML;
      const blob = new Blob([html], { type: "text/html" });
      await navigator.clipboard.write([new ClipboardItem({ "text/html": blob })]);
      const n = images.length;
      track("copy_for_medium", { image_count: n });
      toast.success(
        n > 0
          ? `Copied — paste into Medium, then paste ${n} image${n !== 1 ? "s" : ""} at the markers`
          : "Copied — paste into Medium's editor"
      );
    } catch {
      toast.error("Clipboard write failed (needs HTTPS or localhost)");
    }
  };

  // Fetch a local image and copy it to the clipboard as a PNG blob, which
  // Medium's editor uploads natively on paste (same path as screenshots).
  const copyImage = async (src: string, label: string) => {
    try {
      const url = `/api/images/${slug}/${src}`;
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("load failed"));
        img.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no canvas ctx");
      ctx.drawImage(img, 0, 0);
      const pngBlob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png")
      );
      await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
      track("image_copied", { label });
      toast.success(`Copied ${label} — click into Medium and paste`);
    } catch {
      toast.error("Could not copy image");
    }
  };

  // Render a markdown table to a PNG and copy it (Medium has no native tables)
  const copyTable = async (t: ParsedTable) => {
    try {
      const blob = await renderTablePng(t);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      track("table_copied", { table_n: t.n });
      toast.success(`Copied Table ${t.n} as an image — paste into Medium`);
    } catch {
      toast.error("Could not render table");
    }
  };

  // Format the markdown with Prettier, fully client-side (no network)
  const formatMarkdown = async () => {
    if (!markdown.trim()) return;
    setFormatting(true);
    try {
      const [prettier, mdPlugin] = await Promise.all([
        import("prettier/standalone"),
        import("prettier/plugins/markdown"),
      ]);
      const out = await prettier.format(markdown, {
        parser: "markdown",
        plugins: [mdPlugin.default],
        proseWrap: "preserve",
      });
      setMarkdown(out);
      track("markdown_formatted");
      toast.success("Formatted");
    } catch {
      toast.error("Could not format");
    } finally {
      setFormatting(false);
    }
  };

  const syncGutter = (e: React.UIEvent<HTMLTextAreaElement>) => {
    const st = e.currentTarget.scrollTop;
    if (gutterRef.current) gutterRef.current.scrollTop = st;
    if (overlayRef.current) overlayRef.current.style.transform = `translateY(${-st}px)`;
  };

  // Move the caret to a specific 1-based line in the editor
  const jumpToLine = (line: number) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = markdown.split("\n").slice(0, line - 1).join("\n").length + (line > 1 ? 1 : 0);
    ta.focus();
    ta.setSelectionRange(pos, pos);
    // nudge so the target line is visible
    const lineHeight = 24;
    ta.scrollTop = Math.max(0, (line - 4) * lineHeight);
  };

  const handleConfigSave = (p: string) => {
    setArticlesPath(p);
    setConfigured(true);
    setEditorOnly(false);
    setShowSettings(false);
    setArticles([]);
    setActiveFile("");
    setMarkdown("");
    track("folder_configured");
  };

  // ── Loading ──
  if (configured === null) {
    return (
      <div className="flex items-center justify-center h-screen bg-white text-[#64748B] text-sm">
        Loading…
      </div>
    );
  }

  // ── Setup / settings overlay ──
  if (showSettings || (!configured && !editorOnly)) {
    return <SetupScreen onSave={handleConfigSave} onEditorOnly={() => { setEditorOnly(true); setShowSettings(false); }} />;
  }

  // Local mode = reading a configured folder; editor-only = hosted/paste mode
  const localMode = configured;

  // ── Derived state ──
  const wordCount = markdown.trim() ? markdown.trim().split(/\s+/).length : 0;
  // Local images in document order (skip remote https sources — those paste fine)
  const images = [...markdown.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)]
    .map((m, i) => ({ alt: m[1].trim(), src: m[2].trim(), n: i + 1 }))
    .filter((im) => !im.src.startsWith("http") || im.src.startsWith("http://localhost"));
  const imageCount = (markdown.match(/!\[/g) ?? []).length;
  const tables = parseTables(markdown);
  const tableCounter = { i: 0 }; // resets each render; matches preview tables to their PNG
  const issues = lintMarkdown(markdown);
  const errorCount = issues.filter((i) => i.level === "error").length;
  const lineCount = markdown.split("\n").length;
  const issuesByLine = new Map<number, Issue[]>();
  issues.forEach((iss) => {
    const arr = issuesByLine.get(iss.line) ?? [];
    arr.push(iss);
    issuesByLine.set(iss.line, arr);
  });
  const activeTitle = localMode
    ? (articles.find((a) => a.file === activeFile)?.title || activeFile.split("/")[0] || "No article")
    : "Scratch editor";

  return (
    <TooltipProvider>
      <div className="flex flex-col h-[100dvh] bg-white text-[#0F172A]">

        {/* TOPBAR */}
        <div className="flex h-12 border-b border-[#E2E8F0] px-4 items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <span className="bg-[#4F46E5] text-white text-xs font-bold w-6 h-6 flex items-center justify-center rounded">
              M
            </span>
            <span className="font-semibold text-sm">Medium Workspace</span>
          </div>

          <span className="text-xs text-[#64748B] truncate max-w-xs hidden sm:block">
            {activeTitle}
          </span>

          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={refresh}
                  className="p-1.5 rounded hover:bg-[#F1F5F9] text-[#64748B]"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
                </button>
              </TooltipTrigger>
              <TooltipContent>Refresh articles</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => { setShowGuide(true); track("guide_opened"); }}
                  className="p-1.5 rounded hover:bg-[#F1F5F9] text-[#64748B]"
                >
                  <HelpCircle className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Markdown cheatsheet</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setShowSettings(true)}
                  className="p-1.5 rounded hover:bg-[#F1F5F9] text-[#64748B]"
                >
                  <Settings className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Change articles folder</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={copyForMedium}
                  size="sm"
                  className="bg-[#4F46E5] text-white hover:bg-[#4338CA] text-xs h-8 ml-1"
                >
                  <Copy className="w-3.5 h-3.5 mr-1.5" />
                  <span className="sm:hidden">Copy</span>
                  <span className="hidden sm:inline">Copy for Medium</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Copy as rich HTML — paste into Medium editor</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* MOBILE TABS — only visible on small screens */}
        <div className="flex md:hidden border-b border-[#E2E8F0] shrink-0">
          <button
            onClick={() => setActivePanel("editor")}
            className={`flex-1 py-2.5 text-xs font-medium transition-colors ${activePanel === "editor" ? "border-b-2 border-[#4F46E5] text-[#4F46E5]" : "text-[#64748B]"}`}
          >
            Write
          </button>
          <button
            onClick={() => setActivePanel("preview")}
            className={`flex-1 py-2.5 text-xs font-medium transition-colors ${activePanel === "preview" ? "border-b-2 border-[#4F46E5] text-[#4F46E5]" : "text-[#64748B]"}`}
          >
            Preview
          </button>
        </div>

        {/* MAIN */}
        <div className="flex-1 flex min-h-0">

          {/* SIDEBAR — shows for local folders, and for tables in any mode */}
          {(localMode || tables.length > 0) && (
          <div className="w-56 shrink-0 border-r border-[#E2E8F0] flex flex-col bg-[#FAFAFA]">
            {localMode && (
              <>
                <div className="px-3 py-2 text-[10px] tracking-widest text-[#94A3B8] uppercase font-semibold border-b border-[#E2E8F0] flex items-center gap-1.5">
                  <BookOpen className="w-3 h-3" />
                  Articles
                  <span className="ml-auto text-[#CBD5E1]">{articles.length}</span>
                </div>

                <div className="flex-1 overflow-y-auto custom-scroll py-1">
                  {articles.map((article) => {
                    const isActive = activeFile === article.file;
                    return (
                      <button
                        key={article.file}
                        onClick={() => loadArticle(article.file)}
                        className={`w-full text-left px-3 py-2.5 transition-colors rounded-md mx-1 mb-0.5 ${
                          isActive ? "bg-[#4F46E5] text-white" : "hover:bg-[#F1F5F9] text-[#0F172A]"
                        }`}
                        style={{ width: "calc(100% - 8px)" }}
                      >
                        <div className="font-medium text-sm truncate leading-tight">
                          {article.title || article.slug}
                        </div>
                        <div className={`text-[11px] mt-0.5 truncate ${isActive ? "text-indigo-200" : "text-[#94A3B8]"}`}>
                          {article.words.toLocaleString()} words · {article.slug}
                        </div>
                      </button>
                    );
                  })}

                  {articles.length === 0 && (
                    <div className="px-3 py-6 text-xs text-[#94A3B8] text-center flex flex-col items-center gap-2">
                      <FileText className="w-6 h-6 text-[#CBD5E1]" />
                      <span>No articles found in<br /><code className="text-[10px] break-all">{articlesPath}</code></span>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* IMAGES — copy each as a blob, paste at its marker (local only) */}
            {localMode && images.length > 0 && (
              <div className="border-t border-[#E2E8F0] flex flex-col max-h-[40%]">
                <div className="px-3 py-2 text-[10px] tracking-widest text-[#94A3B8] uppercase font-semibold flex items-center gap-1.5">
                  <ImageIcon className="w-3 h-3" />
                  Images
                  <span className="ml-auto text-[#CBD5E1]">{images.length}</span>
                </div>
                <div className="overflow-y-auto custom-scroll pb-1">
                  {images.map((im) => (
                    <button
                      key={`${im.n}-${im.src}`}
                      onClick={() => copyImage(im.src, `Image ${im.n}`)}
                      className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[#F1F5F9] text-left group"
                      title={`Copy “${im.src}” — then paste at marker ⟦ Image ${im.n} ⟧`}
                    >
                      <span className="shrink-0 w-5 h-5 rounded bg-[#EEF2FF] text-[#4F46E5] text-[10px] font-bold flex items-center justify-center">
                        {im.n}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-xs truncate text-[#0F172A]">{im.alt || im.src}</span>
                        <span className="block text-[10px] truncate text-[#94A3B8]">{im.src}</span>
                      </span>
                      <Copy className="w-3 h-3 text-[#CBD5E1] group-hover:text-[#4F46E5] shrink-0" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* TABLES — render each to an image Medium can show */}
            {tables.length > 0 && (
              <div className={`border-t border-[#E2E8F0] flex flex-col ${localMode ? "max-h-[40%]" : "flex-1"}`}>
                <div className="px-3 py-2 text-[10px] tracking-widest text-[#94A3B8] uppercase font-semibold flex items-center gap-1.5">
                  <Table className="w-3 h-3" />
                  Tables
                  <span className="ml-auto text-[#CBD5E1]">{tables.length}</span>
                </div>
                <div className="overflow-y-auto custom-scroll pb-1">
                  {tables.map((t) => (
                    <button
                      key={t.n}
                      onClick={() => copyTable(t)}
                      className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[#F1F5F9] text-left group"
                      title={`Render Table ${t.n} as an image — paste at its ⟦ Table ${t.n} ⟧ marker`}
                    >
                      <span className="shrink-0 w-5 h-5 rounded bg-[#EEF2FF] text-[#4F46E5] text-[10px] font-bold flex items-center justify-center">
                        {t.n}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-xs truncate text-[#0F172A]">{t.headers.join(" · ") || `Table ${t.n}`}</span>
                        <span className="block text-[10px] truncate text-[#94A3B8]">{t.rows.length} rows × {t.headers.length} cols</span>
                      </span>
                      <Copy className="w-3 h-3 text-[#CBD5E1] group-hover:text-[#4F46E5] shrink-0" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          )}

          {/* EDITOR */}
          <div className={`flex-1 flex-col border-r border-[#E2E8F0] min-w-0 ${activePanel === "preview" ? "hidden md:flex" : "flex"}`}>
            <div className="px-4 py-2 border-b border-[#E2E8F0] text-[10px] text-[#94A3B8] uppercase tracking-widest font-semibold shrink-0 flex items-center justify-between">
              <span>Markdown</span>
              <button
                onClick={formatMarkdown}
                disabled={formatting || !markdown.trim()}
                className="flex items-center gap-1 normal-case tracking-normal text-[11px] text-[#64748B] hover:text-[#4F46E5] disabled:opacity-40"
              >
                <Wand2 className="w-3 h-3" /> {formatting ? "Formatting…" : "Format"}
              </button>
            </div>
            <div className="flex-1 flex min-h-0 bg-[#FAFAFA]">
              {/* Gutter — line numbers + inline issue markers */}
              <div
                ref={gutterRef}
                className="shrink-0 overflow-hidden pt-4 pb-4 text-right select-none bg-[#F4F4F5] border-r border-[#E8E8E8]"
                style={{ width: 44 }}
              >
                {Array.from({ length: lineCount }, (_, i) => {
                  const ln = i + 1;
                  const lineIssues = issuesByLine.get(ln);
                  const worst = lineIssues?.some((x) => x.level === "error")
                    ? "error"
                    : lineIssues?.some((x) => x.level === "warn")
                    ? "warn"
                    : lineIssues
                    ? "info"
                    : null;
                  const dot =
                    worst === "error" ? "bg-red-500" : worst === "warn" ? "bg-[#F97316]" : worst === "info" ? "bg-[#94A3B8]" : "";
                  return (
                    <div
                      key={ln}
                      onClick={() => lineIssues && jumpToLine(ln)}
                      title={lineIssues?.map((x) => x.msg).join("\n")}
                      className={`h-6 leading-6 pr-2 pl-1.5 font-mono text-[11px] flex items-center justify-end gap-1 ${
                        lineIssues ? "cursor-pointer text-[#0F172A]" : "text-[#CBD5E1]"
                      }`}
                    >
                      {worst && <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />}
                      {ln}
                    </div>
                  );
                })}
              </div>

              <div className="relative flex-1 min-w-0">
                <textarea
                  ref={textareaRef}
                  onScroll={syncGutter}
                  className="absolute inset-0 w-full h-full px-3 py-4 font-mono text-sm leading-6 bg-[#FAFAFA] resize-none outline-none custom-scroll text-[#0F172A] whitespace-pre overflow-auto"
                  value={markdown}
                  onChange={(e) => setMarkdown(e.target.value)}
                  spellCheck={false}
                  wrap="off"
                  placeholder={localMode ? "Select an article from the sidebar…" : "Paste or write Markdown here…"}
                />
                {/* Inline lens — the message shown on the offending line */}
                <div className="pointer-events-none absolute inset-0 overflow-hidden">
                  <div ref={overlayRef} className="relative will-change-transform">
                    {[...issuesByLine.entries()].map(([ln, arr]) => {
                      const worst = arr.some((x) => x.level === "error") ? "error" : arr.some((x) => x.level === "warn") ? "warn" : "info";
                      const cls = worst === "error" ? "bg-red-50 text-red-600" : worst === "warn" ? "bg-orange-50 text-[#C2410C]" : "bg-slate-100 text-[#64748B]";
                      const extra = arr.length > 1 ? `  +${arr.length - 1} more` : "";
                      return (
                        <div key={ln} className="absolute right-3 flex items-center justify-end h-6" style={{ top: 16 + (ln - 1) * 24, maxWidth: "70%" }}>
                          <span className={`pointer-events-auto cursor-pointer truncate rounded px-2 py-0.5 text-[11px] ${cls}`} title={arr.map((x) => x.msg).join("\n")} onClick={() => jumpToLine(ln)}>
                            {arr[0].msg}{extra}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* PREVIEW */}
          <div className={`flex-1 flex-col min-w-0 overflow-hidden ${activePanel === "editor" ? "hidden md:flex" : "flex"}`}>
            <div className="px-4 py-2 border-b border-[#E2E8F0] text-[10px] text-[#94A3B8] uppercase tracking-widest font-semibold shrink-0">
              Preview
            </div>
            <div
              ref={previewRef}
              className="medium-preview flex-1 overflow-y-auto custom-scroll p-8"
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeSlug]}
                components={{
                  img({ src, alt, ...props }) {
                    const resolved =
                      src && !src.startsWith("http")
                        ? `/api/images/${slug}/${src}`
                        : src;
                    // eslint-disable-next-line @next/next/no-img-element
                    return <img src={resolved} alt={alt ?? ""} {...props} />;
                  },
                  table({ children, ...props }) {
                    const idx = tableCounter.i++;
                    const url = tableImgs[idx];
                    if (url) {
                      // The exact PNG that gets copied — preview matches the artifact
                      // eslint-disable-next-line @next/next/no-img-element
                      return <img src={url} data-table={idx + 1} alt={`Table ${idx + 1}`} style={{ maxWidth: "100%" }} className="block h-auto my-6" />;
                    }
                    return (
                      <div className="overflow-x-auto">
                        <table {...props}>{children}</table>
                      </div>
                    );
                  },
                }}
              >
                {markdown}
              </ReactMarkdown>
            </div>
          </div>
        </div>

        {/* STATUS BAR */}
        <div className="h-9 border-t border-[#E2E8F0] flex items-center px-4 gap-4 text-xs text-[#64748B] bg-[#FAFAFA] shrink-0">
          <span>{wordCount.toLocaleString()} words</span>
          <span className="text-[#CBD5E1]">·</span>
          <span>{imageCount} image{imageCount !== 1 ? "s" : ""}</span>
          <span className="text-[#CBD5E1]">·</span>
          {issues.length === 0 ? (
            <span className="flex items-center gap-1 text-green-600">
              <CheckCircle2 className="w-3.5 h-3.5" /> clean
            </span>
          ) : (
            <button onClick={() => jumpToLine(issues[0].line)} className="flex items-center gap-1 hover:underline">
              <AlertTriangle className={`w-3.5 h-3.5 ${errorCount ? "text-red-500" : "text-[#F97316]"}`} />
              <span className={errorCount ? "text-red-500" : "text-[#F97316]"}>
                {issues.length} issue{issues.length !== 1 ? "s" : ""} — jump to first
              </span>
            </button>
          )}
          <span className="ml-auto text-[10px] text-[#CBD5E1] truncate hidden md:block">
            {localMode ? articlesPath : "editor-only · nothing saved"}
          </span>
        </div>

      </div>

      {showGuide && <MarkdownGuide onClose={() => setShowGuide(false)} />}
    </TooltipProvider>
  );
}
