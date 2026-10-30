import { describe, expect, it } from "vitest";
import config from "../vercel.json";

type Regla = { source: string; headers: { key: string; value: string }[] };
const reglas = (config as { headers: Regla[] }).headers;
const valor = (source: string, key: string) =>
  reglas.find((r) => r.source === source)?.headers.find((h) => h.key === key)?.value;

describe("vercel.json", () => {
  const csp = valor("/(.*)", "Content-Security-Policy") ?? "";

  it("la CSP restringe scripts y embebido, sin inline ni eval", () => {
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("agrega los demás headers de seguridad en todas las rutas", () => {
    expect(valor("/(.*)", "X-Content-Type-Options")).toBe("nosniff");
    expect(valor("/(.*)", "Referrer-Policy")).toBe("no-referrer");
    expect(valor("/(.*)", "Strict-Transport-Security")).toBe("max-age=63072000");
  });

  it("las rutas /api/ no se cachean", () => {
    expect(valor("/api/(.*)", "Cache-Control")).toBe("no-store");
  });
});
