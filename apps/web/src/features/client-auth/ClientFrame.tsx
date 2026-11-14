import Link from "next/link";
import { ShieldCheck } from "lucide-react";

export function ClientFrame({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children: React.ReactNode }) {
  return <main className="client-shell">
    <header className="client-header">
      <Link href="/" className="client-wordmark">YOUNG<span>KINGZ</span></Link>
      <div className="client-secure"><ShieldCheck size={16} aria-hidden /> Seguridad de cuenta</div>
    </header>
    <section className="client-stage">
      <div className="client-intro"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>
      <div className="client-card">{children}</div>
    </section>
  </main>;
}

export function Field({ label, error, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string }) {
  return <label className="yk-field"><span>{label}</span><input {...props} aria-invalid={Boolean(error)} />{error && <small>{error}</small>}</label>;
}

export function Message({ kind = "error", children }: { kind?: "error" | "success"; children: React.ReactNode }) {
  return <div className={`notice ${kind}`} role={kind === "error" ? "alert" : "status"}>{children}</div>;
}
