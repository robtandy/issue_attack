// Tiny terminal formatting helpers. Respects NO_COLOR and non-TTY.

const enabled = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code: string) => (s: unknown): string =>
  enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s);

export const c = {
  dim: wrap("2"),
  bold: wrap("1"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
};

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

export function fmtMoney(x: number | null | undefined): string {
  if (x == null || !isFinite(x)) return "$0.00";
  return `$${x.toFixed(2)}`;
}

export function fmtTokens(t: number | null | undefined): string {
  if (t == null) return "0";
  if (t >= 1_000_000) return `${(t / 1_000_000).toFixed(1)}M`;
  if (t >= 1_000) return `${(t / 1_000).toFixed(1)}k`;
  return String(t);
}

interface ToolRecord {
  toolName?: string;
  args?: Record<string, unknown>;
}

/** One-line summary of a tool execution record. */
export function toolSummary(rec: ToolRecord): string {
  const name = rec.toolName ?? "?";
  const args = rec.args ?? {};
  if (name === "bash" || name === "powershell") {
    const cmd = String(args.command ?? "").replace(/\s+/g, " ").trim();
    return cmd.length > 90 ? cmd.slice(0, 87) + "..." : cmd;
  }
  if (name === "read" || name === "edit" || name === "write") {
    return String(args.path ?? "");
  }
  if (name === "grep") return `pattern: ${String(args.pattern ?? "")}`;
  if (name === "find") return String(args.pattern ?? "");
  return JSON.stringify(args).slice(0, 90);
}

/** Minimal fixed-width table printer. */
export function printTable(rows: unknown[][], headers: string[]): void {
  const widths = headers.map((h, i) =>
    Math.max(
      h.length,
      ...rows.map((r) => String(r[i] ?? "").length),
      3
    )
  );
  const line = (cells: unknown[]): string =>
    cells.map((cell, i) => String(cell ?? "").padEnd(widths[i])).join("  ");
  console.log(c.dim(line(headers)));
  for (const row of rows) console.log(line(row));
}
