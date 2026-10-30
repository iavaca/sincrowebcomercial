import { describe, expect, it } from "vitest";
import { AGENTES, accionPermitida, pasosDeAccion, validarAccion } from "../lib/acciones.js";

const SHA = "a".repeat(40);
const valida = (b: unknown) => validarAccion(b);
const rechaza = (b: unknown) => expect(valida(b)).toEqual({ ok: false, error: "accion_invalida" });

describe("validarAccion", () => {
  it("acepta cada tipo bien formado y devuelve solo los campos conocidos", () => {
    expect(valida({ tipo: "enviado", repo: "claude-agents", numero: 7, extra: "x" })).toEqual({ ok: true, accion: { tipo: "enviado", repo: "claude-agents", numero: 7 } });
    expect(valida({ tipo: "respondio", repo: "claude-agents", numero: 1 }).ok).toBe(true);
    expect(valida({ tipo: "resuelto", repo: "claude-agents", numero: 1 }).ok).toBe(true);
    expect(valida({ tipo: "mergear", repo: "claude-agents", numero: 3, sha: SHA })).toEqual({ ok: true, accion: { tipo: "mergear", repo: "claude-agents", numero: 3, sha: SHA } });
    expect(valida({ tipo: "pedir_cambios", repo: "claude-agents", numero: 3, comentario: "Falta el test" }).ok).toBe(true);
    expect(valida({ tipo: "asignar", repo: "sincroweb-pedidos", numero: 4, agente: "fullstack-engineer" }).ok).toBe(true);
    expect(valida({ tipo: "cotizar_extra", repo: "sincroweb-pedidos", numero: 4 }).ok).toBe(true);
    expect(valida({ tipo: "cerrar", repo: "sincroweb-pedidos", numero: 4 }).ok).toBe(true);
  });
  it("rechaza no-objetos, tipo desconocido, repo que no corresponde al tipo, numero no entero o <= 0", () => {
    for (const b of [null, undefined, "x", 5, [], [{ tipo: "enviado" }]]) rechaza(b);
    rechaza({ tipo: "borrar", repo: "claude-agents", numero: 1 });
    rechaza({ tipo: "toString", repo: "claude-agents", numero: 1 });
    rechaza({ tipo: "__proto__", repo: "claude-agents", numero: 1 });
    rechaza({ repo: "claude-agents", numero: 1 });
    rechaza({ tipo: "enviado", repo: "sincroweb-pedidos", numero: 1 });
    rechaza({ tipo: "cerrar", repo: "claude-agents", numero: 1 });
    rechaza({ tipo: "mergear", repo: "sincroweb-pedidos", numero: 1, sha: SHA });
    rechaza({ tipo: "enviado", repo: "otro/repo", numero: 1 });
    for (const numero of [0, -1, 1.5, NaN, Infinity, "7", null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      rechaza({ tipo: "enviado", repo: "claude-agents", numero });
    }
  });
  it("asignar solo acepta agentes de AGENTES", () => {
    expect(AGENTES).toHaveLength(21);
    expect(AGENTES).toContain("fullstack-engineer");
    expect(AGENTES).toContain("ai-engineer");
    expect(AGENTES).toContain("web-art-director");
    const asignar = (agente: unknown) => valida({ tipo: "asignar", repo: "sincroweb-pedidos", numero: 1, agente });
    expect(asignar("fullstack-engineer").ok).toBe(true);
    for (const a of ["../x", "otro", "", "Fullstack-Engineer", "fullstack-engineer ", "constructor", "toString", 5, undefined, null]) {
      expect(asignar(a)).toEqual({ ok: false, error: "accion_invalida" });
    }
  });
  it("mergear exige sha de 40 hex", () => {
    const m = (sha: unknown) => valida({ tipo: "mergear", repo: "claude-agents", numero: 1, sha });
    expect(m("0123456789abcdef0123456789abcdef01234567").ok).toBe(true);
    for (const s of ["", "abc", "a".repeat(39), "a".repeat(41), "g".repeat(40), "A".repeat(40), `${"a".repeat(40)}\n`, 5, undefined]) {
      expect(m(s)).toEqual({ ok: false, error: "accion_invalida" });
    }
  });
  it("pedir_cambios: comentario de 1 a 200 caracteres, sin saltos de línea", () => {
    const p = (comentario: unknown) => valida({ tipo: "pedir_cambios", repo: "claude-agents", numero: 1, comentario });
    expect(p("a").ok).toBe(true);
    expect(p("a".repeat(200)).ok).toBe(true);
    expect(p("😀".repeat(200)).ok).toBe(true);
    for (const c of ["", "   ", "a".repeat(201), "uno\ndos", "uno\rdos", "uno\u2028dos", "uno\u0000dos", 5, undefined, null]) {
      expect(p(c)).toEqual({ ok: false, error: "accion_invalida" });
    }
  });
});

describe("accionPermitida", () => {
  const comercial = ["bandeja:comercial"];
  const a = (tipo: string, extra: object = {}) => validarAccion({ tipo, repo: ["cotizar_extra", "cerrar", "asignar"].includes(tipo) ? "sincroweb-pedidos" : "claude-agents", numero: 1, agente: "fullstack-engineer", sha: SHA, comentario: "x", ...extra }) as { ok: true; accion: Parameters<typeof accionPermitida>[0] };
  it("enviado/respondio solo con bandeja:comercial", () => {
    for (const t of ["enviado", "respondio"]) {
      expect(accionPermitida(a(t).accion, comercial, "issue")).toBe(true);
      expect(accionPermitida(a(t).accion, ["bandeja:mantenimiento"], "issue")).toBe(false);
      expect(accionPermitida(a(t).accion, [], "issue")).toBe(false);
    }
  });
  it("resuelto solo con bandeja:mantenimiento", () => {
    expect(accionPermitida(a("resuelto").accion, ["bandeja:mantenimiento"], "issue")).toBe(true);
    expect(accionPermitida(a("resuelto").accion, comercial, "issue")).toBe(false);
    expect(accionPermitida(a("resuelto").accion, [], "issue")).toBe(false);
  });
  it("asignar/cotizar/cerrar solo con cliente:*", () => {
    for (const t of ["asignar", "cotizar_extra", "cerrar"]) {
      expect(accionPermitida(a(t).accion, ["cliente:acme", "bug"], "issue")).toBe(true);
      expect(accionPermitida(a(t).accion, ["cliente:"], "issue")).toBe(false);
      expect(accionPermitida(a(t).accion, ["bug", "bandeja:comercial"], "issue")).toBe(false);
      expect(accionPermitida(a(t).accion, [], "issue")).toBe(false);
    }
  });
  it("pedir_cambios y mergear exigen que el ítem sea un PR", () => {
    expect(accionPermitida(a("pedir_cambios").accion, [], "pr")).toBe(true);
    expect(accionPermitida(a("pedir_cambios").accion, comercial, "issue")).toBe(false);
    expect(accionPermitida(a("mergear").accion, [], "pr")).toBe(true);
    expect(accionPermitida(a("mergear").accion, ["bandeja:comercial", "cliente:acme"], "issue")).toBe(false);
  });
  it("las acciones de issue no valen sobre un PR", () => {
    expect(accionPermitida(a("enviado").accion, comercial, "pr")).toBe(false);
    expect(accionPermitida(a("cerrar").accion, ["cliente:acme"], "pr")).toBe(false);
  });
});

describe("pasosDeAccion", () => {
  const base = "/repos/iavaca/claude-agents/issues";
  const ped = "/repos/iavaca/sincroweb-pedidos/issues";
  it("enviado → POST labels ['estado:enviado'] + comentario 'Enviado: 2026-11-02'", () => {
    expect(pasosDeAccion({ tipo: "enviado", repo: "claude-agents", numero: 7 }, "2026-11-02")).toEqual([
      { metodo: "POST", ruta: `${base}/7/labels`, cuerpo: { labels: ["estado:enviado"] } },
      { metodo: "POST", ruta: `${base}/7/comments`, cuerpo: { body: "Enviado: 2026-11-02" } },
    ]);
  });
  it("respondio → label estado:respondio + 'Respondió: <fecha>'", () => {
    expect(pasosDeAccion({ tipo: "respondio", repo: "claude-agents", numero: 8 }, "2026-11-03")).toEqual([
      { metodo: "POST", ruta: `${base}/8/labels`, cuerpo: { labels: ["estado:respondio"] } },
      { metodo: "POST", ruta: `${base}/8/comments`, cuerpo: { body: "Respondió: 2026-11-03" } },
    ]);
  });
  it("asignar → label agente:<nombre>", () => {
    expect(pasosDeAccion({ tipo: "asignar", repo: "sincroweb-pedidos", numero: 2, agente: "seo-engineer" }, "2026-11-02")).toEqual([
      { metodo: "POST", ruta: `${ped}/2/labels`, cuerpo: { labels: ["agente:seo-engineer"] } },
    ]);
  });
  it("cotizar_extra → label 'extra cotizado'", () => {
    expect(pasosDeAccion({ tipo: "cotizar_extra", repo: "sincroweb-pedidos", numero: 3 }, "2026-11-02")).toEqual([
      { metodo: "POST", ruta: `${ped}/3/labels`, cuerpo: { labels: ["extra cotizado"] } },
    ]);
  });
  it("cerrar y resuelto → PATCH state closed", () => {
    expect(pasosDeAccion({ tipo: "cerrar", repo: "sincroweb-pedidos", numero: 4 }, "2026-11-02")).toEqual([
      { metodo: "PATCH", ruta: `${ped}/4`, cuerpo: { state: "closed" } },
    ]);
    expect(pasosDeAccion({ tipo: "resuelto", repo: "claude-agents", numero: 5 }, "2026-11-02")).toEqual([
      { metodo: "PATCH", ruta: `${base}/5`, cuerpo: { state: "closed" } },
    ]);
  });
  it("pedir_cambios → un comentario con el texto tal cual", () => {
    expect(pasosDeAccion({ tipo: "pedir_cambios", repo: "claude-agents", numero: 9, comentario: "  Falta el test <b>  " }, "2026-11-02")).toEqual([
      { metodo: "POST", ruta: `${base}/9/comments`, cuerpo: { body: "  Falta el test <b>  " } },
    ]);
  });
  it("nunca usa el reemplazo de labels (PUT) ni DELETE", () => {
    const acciones = [
      { tipo: "enviado", repo: "claude-agents", numero: 1 },
      { tipo: "respondio", repo: "claude-agents", numero: 1 },
      { tipo: "asignar", repo: "sincroweb-pedidos", numero: 1, agente: "ai-engineer" },
      { tipo: "cotizar_extra", repo: "sincroweb-pedidos", numero: 1 },
    ] as const;
    for (const ac of acciones) for (const p of pasosDeAccion(ac, "2026-11-02")) expect(p.metodo).toBe("POST");
  });
  it("una fecha mal formada no llega al comentario", () => {
    expect(() => pasosDeAccion({ tipo: "enviado", repo: "claude-agents", numero: 1 }, "ayer\n@alguien")).toThrow();
  });
});
