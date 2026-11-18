import { describe, expect, it } from "vitest";
import { calcularSaldo, parsearArchivo, personaDeUid, validarNuevo, type Movimiento } from "../lib/finanzas.js";

const AHORA = new Date("2026-11-18T15:00:00Z");
let n = 0;
function mov(m: Partial<Movimiento> & Pick<Movimiento, "tipo" | "monto" | "persona">): Movimiento {
  return { id: `m${++n}`, fecha: "2026-11-18", concepto: "x", cargadoPor: m.persona, cargadoEn: AHORA.toISOString(), ...m };
}

describe("personaDeUid", () => {
  it("mapea los dos socios y rechaza otros", () => {
    expect(personaDeUid(100360837)).toBe("ivan");
    expect(personaDeUid(75735426)).toBe("isabella");
    expect(personaDeUid(1)).toBeNull();
  });
});

describe("calcularSaldo", () => {
  it("sin movimientos no hay transferencia", () => {
    const s = calcularSaldo([]);
    expect(s).toMatchObject({ cobros: 0, gastos: 0, ganancia: 0, mitad: 0, transferir: null });
  });

  it("Iván cobra 100000 e Isabella gasta 20000: Iván transfiere 60000", () => {
    const movs = [
      mov({ tipo: "cobro", monto: 100000, persona: "ivan", cliente: "cecal" }),
      mov({ tipo: "gasto", monto: 20000, persona: "isabella", categoria: "Dominios" }),
    ];
    const s = calcularSaldo(movs);
    expect(s).toMatchObject({ cobros: 100000, gastos: 20000, ganancia: 80000, mitad: 40000 });
    expect(s.neto).toEqual({ ivan: 100000, isabella: -20000 });
    expect(s.transferir).toEqual({ de: "ivan", para: "isabella", monto: 60000 });

    movs.push(mov({ tipo: "transferencia", monto: 60000, persona: "ivan", para: "isabella" }));
    expect(calcularSaldo(movs).transferir).toBeNull();
  });

  it("al revés: Isabella le debe a Iván", () => {
    const s = calcularSaldo([mov({ tipo: "cobro", monto: 50000, persona: "isabella", cliente: "icat" }), mov({ tipo: "gasto", monto: 10000, persona: "ivan", categoria: "Otros" })]);
    expect(s.transferir).toEqual({ de: "isabella", para: "ivan", monto: 30000 });
  });

  it("redondea el medio peso", () => {
    const s = calcularSaldo([mov({ tipo: "cobro", monto: 3, persona: "ivan", cliente: "cecal" })]);
    expect(s.transferir).toEqual({ de: "ivan", para: "isabella", monto: 2 });
  });
});

describe("validarNuevo", () => {
  const ok = (b: unknown) => validarNuevo(b, "ivan", AHORA, "id1");
  const base = { fecha: "2026-11-18", monto: 1000, persona: "ivan", concepto: "Hosting" };

  it("acepta un gasto y completa id, cargadoPor y cargadoEn", () => {
    const r = ok({ ...base, tipo: "gasto", categoria: "Hosting y servidores" });
    expect(r).toEqual({ ok: true, mov: { id: "id1", tipo: "gasto", fecha: "2026-11-18", monto: 1000, persona: "ivan", categoria: "Hosting y servidores", concepto: "Hosting", cargadoPor: "ivan", cargadoEn: AHORA.toISOString() } });
  });

  it("acepta cobro con cliente de la lista y con 'otro' + nombre", () => {
    expect(ok({ ...base, tipo: "cobro", cliente: "cecal", concepto: "" }).ok).toBe(true);
    const r = ok({ ...base, tipo: "cobro", cliente: "otro", clienteNombre: "Kimen" });
    expect(r.ok && r.mov.clienteNombre).toBe("Kimen");
  });

  it("acepta transferencia entre los dos", () => {
    expect(ok({ ...base, tipo: "transferencia", para: "isabella", concepto: "" }).ok).toBe(true);
  });

  it.each([
    ["monto 0", { ...base, tipo: "gasto", categoria: "Otros", monto: 0 }],
    ["monto decimal", { ...base, tipo: "gasto", categoria: "Otros", monto: 10.5 }],
    ["monto gigante", { ...base, tipo: "gasto", categoria: "Otros", monto: 2_000_000_000 }],
    ["tipo desconocido", { ...base, tipo: "regalo" }],
    ["fecha mala", { ...base, tipo: "gasto", categoria: "Otros", fecha: "18/11/2026" }],
    ["persona desconocida", { ...base, tipo: "gasto", categoria: "Otros", persona: "pepe" }],
    ["transferencia a uno mismo", { ...base, tipo: "transferencia", para: "ivan" }],
    ["cliente inexistente", { ...base, tipo: "cobro", cliente: "nadie" }],
    ["cobro sin cliente", { ...base, tipo: "cobro" }],
    ["otro sin nombre", { ...base, tipo: "cobro", cliente: "otro" }],
    ["gasto sin categoría", { ...base, tipo: "gasto" }],
    ["gasto sin concepto", { ...base, tipo: "gasto", categoria: "Otros", concepto: " " }],
    ["concepto largo", { ...base, tipo: "gasto", categoria: "Otros", concepto: "a".repeat(201) }],
    ["no objeto", null],
  ])("rechaza %s", (_, b) => {
    expect(ok(b)).toEqual({ ok: false });
  });
});

describe("parsearArchivo", () => {
  it("lee un archivo válido", () => {
    const m = mov({ tipo: "gasto", monto: 5, persona: "ivan", categoria: "Otros" });
    expect(parsearArchivo(JSON.stringify({ version: 1, movimientos: [m] }))).toEqual([m]);
  });

  it.each(["no json", "{}", JSON.stringify({ version: 2, movimientos: [] }), JSON.stringify({ version: 1, movimientos: [{ id: "x" }] })])("lanza con %s", (t) => {
    expect(() => parsearArchivo(t)).toThrow();
  });
});
