import { describe, expect, it } from "vitest";
import { puedeMergear, TEXTO_MOTIVO } from "../lib/merge";

const ok = { sha: "abc", mergeable: "MERGEABLE", checks: "SUCCESS", borrador: false } as const;

describe("puedeMergear", () => {
  it("mergea si todo está bien", () => expect(puedeMergear(ok, "abc")).toEqual({ ok: true }));
  it("SHA distinto → pr_cambio, aunque checks verdes", () =>
    expect(puedeMergear(ok, "zzz")).toEqual({ ok: false, motivo: "pr_cambio" }));
  it("checks FAILURE/ERROR/PENDING/EXPECTED → checks_rojos", () => {
    for (const checks of ["FAILURE", "ERROR", "PENDING", "EXPECTED"] as const) {
      expect(puedeMergear({ ...ok, checks }, "abc")).toEqual({ ok: false, motivo: "checks_rojos" });
    }
  });
  it("sin checks (null) → permitido (decisión 3)", () =>
    expect(puedeMergear({ ...ok, checks: null }, "abc")).toEqual({ ok: true }));
  it("CONFLICTING o borrador → no_mergeable; UNKNOWN → calculando", () => {
    expect(puedeMergear({ ...ok, mergeable: "CONFLICTING" }, "abc")).toEqual({ ok: false, motivo: "no_mergeable" });
    expect(puedeMergear({ ...ok, borrador: true }, "abc")).toEqual({ ok: false, motivo: "no_mergeable" });
    expect(puedeMergear({ ...ok, mergeable: "UNKNOWN" }, "abc")).toEqual({ ok: false, motivo: "calculando" });
  });
  it("SHA vacío nunca matchea", () => expect(puedeMergear({ ...ok, sha: "" }, "").ok).toBe(false));
  it("orden: SHA gana sobre todo, borrador/conflicto sobre calculando, calculando sobre checks", () => {
    const malo = { sha: "abc", mergeable: "CONFLICTING", checks: "FAILURE", borrador: true } as const;
    expect(puedeMergear(malo, "zzz")).toEqual({ ok: false, motivo: "pr_cambio" });
    expect(puedeMergear(malo, "abc")).toEqual({ ok: false, motivo: "no_mergeable" });
    expect(puedeMergear({ ...malo, mergeable: "UNKNOWN", borrador: false }, "abc")).toEqual({ ok: false, motivo: "calculando" });
    expect(puedeMergear({ ...malo, mergeable: "MERGEABLE", borrador: false }, "abc")).toEqual({ ok: false, motivo: "checks_rojos" });
  });
  it("valores inesperados en runtime no habilitan el merge", () => {
    const raro = (o: object) => ({ ...ok, ...o }) as unknown as Parameters<typeof puedeMergear>[0];
    expect(puedeMergear(raro({ mergeable: "OTRO" }), "abc").ok).toBe(false);
    expect(puedeMergear(raro({ checks: "OTRO" }), "abc").ok).toBe(false);
    expect(puedeMergear(raro({ checks: undefined }), "abc").ok).toBe(false);
    expect(puedeMergear(raro({ borrador: undefined, mergeable: undefined }), "abc").ok).toBe(false);
  });
});

describe("TEXTO_MOTIVO", () => {
  it("textos fijos", () => {
    expect(TEXTO_MOTIVO).toEqual({
      pr_cambio: "El PR cambió, revisalo de nuevo",
      checks_rojos: "Checks en rojo o sin terminar",
      no_mergeable: "El PR tiene conflictos o GitHub no lo deja mergear",
      calculando: "GitHub todavía está calculando, probá en unos segundos",
      github_error: "GitHub no respondió, probá de nuevo",
      sesion_vencida: "Tu sesión venció",
      no_permitido: "Esta acción no corresponde a esta tarjeta",
      accion_invalida: "La acción no es válida, recargá la bandeja",
      config_invalida: "La bandeja está mal configurada",
      github_sin_permiso: "GitHub no dejó hacer esto (permiso o límite). Probá en un rato.",
    });
  });
});
