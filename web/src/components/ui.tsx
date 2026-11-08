"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useProtocol } from "@/lib/protocol";

/** Smoothly animates numeric changes (counters in the telemetry bar and tour). */
export function useAnimatedNumber(target: number, duration = 750): number {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    const start = performance.now();
    const origin = from.current;
    if (origin === target) return;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - p) ** 3;
      const v = origin + (target - origin) * eased;
      setValue(v);
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      from.current = target;
    };
  }, [target, duration]);
  return value;
}

export function Counter({ value, format, className }: { value: number; format: (n: number) => string; className?: string }) {
  const shown = useAnimatedNumber(value);
  const [flash, setFlash] = useState(0);
  const prev = useRef(value);
  useEffect(() => {
    if (value > prev.current) setFlash((f) => f + 1);
    prev.current = value;
  }, [value]);
  return (
    <span key={flash} className={`${className ?? ""} ${flash > 0 ? "flash" : ""}`}>
      {format(shown)}
    </span>
  );
}

export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
export const fmtUsd = (n: number, digits = 2) => `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
export const fmtNum = (n: number, digits = 2) => n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });

export function Panel({ title, right, children, className, tight }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; tight?: boolean }) {
  return (
    <section className={`panel ${tight ? "tight" : ""} ${className ?? ""}`}>
      {title || right ? (
        <div className="panel-head">
          {title ? <h2 className="panel-title">{title}</h2> : <span />}
          {right}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Pill({ tone = "outline", children, title }: { tone?: "ok" | "warn" | "bad" | "info" | "dispute" | "accent" | "burn" | "outline"; children: ReactNode; title?: string }) {
  return (
    <span className={`pill ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function KV({ rows }: { rows: [ReactNode, ReactNode, string?][] }) {
  return (
    <div className="kv">
      {rows.map(([k, v, cls], i) => (
        <div key={i} className={`kv-row ${cls ?? ""}`}>
          <span>{k}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}

export function NumField({
  label,
  value,
  onChange,
  suffix,
  help,
  placeholder,
  id,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
  help?: ReactNode;
  placeholder?: string;
  id: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="input-wrap">
        <input id={id} inputMode="decimal" autoComplete="off" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))} />
        {suffix ? <span className="suffix">{suffix}</span> : null}
      </div>
      {help ? <div className="help">{help}</div> : null}
    </div>
  );
}

export function Toggle({ on, onChange, label, sub, disabled }: { on: boolean; onChange: (v: boolean) => void; label: ReactNode; sub?: ReactNode; disabled?: boolean }) {
  return (
    <div
      className="toggle"
      role="switch"
      aria-checked={on}
      aria-disabled={disabled}
      tabIndex={0}
      data-on={on}
      onClick={() => !disabled && onChange(!on)}
      onKeyDown={(e) => {
        if (!disabled && (e.key === " " || e.key === "Enter")) {
          e.preventDefault();
          onChange(!on);
        }
      }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
        {sub ? <div className="help" style={{ marginTop: 2 }}>{sub}</div> : null}
      </div>
      <span className="switch" aria-hidden="true" />
    </div>
  );
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(sec).padStart(2, "0")}s`;
}

/** Countdown against the protocol clock (simulation time, or chain time when live). */
export function Countdown({ to, prefix }: { to: bigint; prefix?: string }) {
  const { snapshot } = useProtocol();
  const left = Number(to - snapshot.now);
  return <span className="num">{left > 0 ? `${prefix ?? ""}${formatDuration(left)}` : "ended"}</span>;
}

export function ago(now: bigint, ts: bigint): string {
  const d = Number(now - ts);
  if (ts === 0n) return "recent";
  if (d < 60) return `${Math.max(0, d)}s ago`;
  if (d < 3_600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86_400) return `${Math.floor(d / 3_600)}h ago`;
  return `${Math.floor(d / 86_400)}d ago`;
}

export function Toasts() {
  const { toasts, dismiss } = useProtocol();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === "err" ? "err" : t.kind === "ok" ? "ok" : ""}`} onClick={() => dismiss(t.id)} role="status">
          <div className="t-title">{t.kind === "pending" ? "⏳ " : t.kind === "ok" ? "✓ " : "✕ "}{t.title}</div>
          {t.body ? <div className="t-body">{t.body}</div> : null}
          {t.href ? (
            <a className="t-body" href={t.href} target="_blank" rel="noreferrer">
              View on explorer ↗
            </a>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function wifToNumber(v: bigint): number {
  return Number(v / 10n ** 12n) / 1e6;
}

export function usdgToNumber(v: bigint): number {
  return Number(v) / 1e6;
}

export function parseDecimal(input: string, decimals: number): bigint | null {
  const s = input.trim();
  if (!/^\d*(\.\d*)?$/.test(s) || s === "" || s === ".") return null;
  const [i, f = ""] = s.split(".");
  if (f.length > decimals) return null;
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export const toPriceUnits = (input: string): bigint | null => {
  const v = parseDecimal(input, 6);
  if (v === null) return null;
  return v;
};
