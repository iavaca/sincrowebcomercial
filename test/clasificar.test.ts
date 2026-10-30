import { describe, expect, it } from "vitest";
import { armarBandeja, clasificar } from "../lib/clasificar";
import type { IssueItem, PrItem } from "../lib/tipos";

const ahora = new Date("2026-11-02T12:00:00Z");
const dias = (n: number) => new Date(ahora.getTime() - n * 86_400_000).toISOString();
let seq = 0;

function issue(o: Partial<IssueItem> = {}): IssueItem {
  return { clase: "issue", repo: "claude-agents", numero: ++seq, titulo: "Acme SA · primer contacto", cuerpo: "", labels: ["bandeja:comercial"], creado: dias(1), url: "https://github.com/x/y/issues/1", ...o };
}
function pr(o: Partial<PrItem> = {}): PrItem {
  return { clase: "pr", repo: "claude-agents", numero: ++seq, titulo: "cambio", cuerpo: "", creado: dias(1), url: "https://github.com/x/y/pull/1",
    sha: "abc", mergeable: "MERGEABLE", checks: "SUCCESS", archivos: [], archivosTotal: 0, borrador: false, ...o };
}
const pedido = (cliente: string, creado: string, extra: string[] = []) =>
  issue({ repo: "sincroweb-pedidos", titulo: "pedido", labels: [`cliente:${cliente}`, ...extra], creado });
const primero = (n: number) => issue({ titulo: `P${n} · primer contacto`, creado: dias(n) });

describe("clasificar", () => {
  it("primer contacto comercial sin estado va a cuando", () => {
    const t = clasificar(issue(), ahora)!;
    expect([t.tipo, t.subtipo, t.franja, t.cliente]).toEqual(["comercial", "primer-contacto", "cuando", "Acme SA"]);
  });
  it("seguimiento 1 y 2 sin estado van a hoy", () => {
    for (const n of [1, 2]) {
      const t = clasificar(issue({ titulo: `Acme SA · seguimiento ${n}` }), ahora)!;
      expect([t.tipo, t.subtipo, t.franja, t.cliente]).toEqual(["comercial", "seguimiento", "hoy", "Acme SA"]);
    }
  });
  it("estado:respondio va a hoy", () => {
    const t = clasificar(issue({ labels: ["bandeja:comercial", "estado:enviado", "estado:respondio"], titulo: "Acme SA · seguimiento 1" }), ahora)!;
    expect([t.tipo, t.subtipo, t.franja, t.cliente]).toEqual(["comercial", "respondio", "hoy", "Acme SA"]);
  });
  it("estado:enviado sin respondio es comercial esperando, en cuando", () => {
    const t = clasificar(issue({ labels: ["bandeja:comercial", "estado:enviado"], titulo: "Acme SA · seguimiento 1" }), ahora)!;
    expect([t.tipo, t.subtipo, t.franja, t.cliente]).toEqual(["comercial", "esperando", "cuando", "Acme SA"]);
  });
  it("un estado:* que no es enviado ni respondio sigue sin tarjeta", () => {
    expect(clasificar(issue({ labels: ["bandeja:comercial", "estado:otro"] }), ahora)).toBeNull();
  });
  it("el prospecto se separa del tipo con el último ' · '", () => {
    const t = clasificar(issue({ titulo: "Foo · Bar SA · primer contacto" }), ahora)!;
    expect([t.cliente, t.subtipo]).toEqual(["Foo · Bar SA", "primer-contacto"]);
  });
  it("mantenimiento rojo va a ahora", () => {
    const t = clasificar(issue({ labels: ["bandeja:mantenimiento", "nivel:rojo", "cliente:cecal"], titulo: "caído" }), ahora)!;
    expect([t.tipo, t.franja, t.cliente]).toEqual(["aviso", "ahora", "cecal"]);
  });
  it("mantenimiento amarillo o sin nivel va a cuando", () => {
    for (const labels of [["bandeja:mantenimiento", "nivel:amarillo", "cliente:cecal"], ["bandeja:mantenimiento", "cliente:cecal"]]) {
      const t = clasificar(issue({ labels, titulo: "aviso" }), ahora)!;
      expect([t.tipo, t.franja, t.cliente]).toEqual(["aviso", "cuando", "cecal"]);
    }
  });
  it("pedido urgente va a ahora", () => {
    const t = clasificar(pedido("cecal", dias(1), ["urgente"]), ahora)!;
    expect([t.tipo, t.franja, t.cliente]).toEqual(["pedido", "ahora", "cecal"]);
  });
  it("pedido normal va a hoy", () => {
    const t = clasificar(pedido("cecal", dias(1)), ahora)!;
    expect([t.tipo, t.franja, t.cliente]).toEqual(["pedido", "hoy", "cecal"]);
  });
  it("pedido con agente:*, extra cotizado, hecho o actualizacion se descarta", () => {
    for (const l of ["agente:fullstack", "extra cotizado", "hecho", "actualizacion"]) expect(clasificar(pedido("cecal", dias(1), [l]), ahora)).toBeNull();
  });
  it("PR no borrador va a cuando con cliente agentes", () => {
    const t = clasificar(pr(), ahora)!;
    expect([t.tipo, t.franja, t.cliente]).toEqual(["pr", "cuando", "agentes"]);
  });
  it("PR borrador, issue sin labels de bandeja y título comercial sin ' · ' se descartan", () => {
    expect(clasificar(pr({ borrador: true }), ahora)).toBeNull();
    expect(clasificar(issue({ labels: [] }), ahora)).toBeNull();
    expect(clasificar(issue({ titulo: "Acme SA primer contacto" }), ahora)).toBeNull();
  });
  it("antiguedadMs es ahora menos creado", () => {
    expect(clasificar(issue({ creado: dias(2) }), ahora)!.antiguedadMs).toBe(2 * 86_400_000);
  });
  it("la tarjeta comercial sin línea Link: válida no tiene link", () => {
    expect(clasificar(issue({ cuerpo: "Link: javascript:alert(1)" }), ahora)!.link).toBeUndefined();
    expect(clasificar(issue({ cuerpo: "Texto" }), ahora)!.link).toBeUndefined();
    expect(clasificar(issue({ cuerpo: "Link: https://wa.me/549299" }), ahora)!.link).toBe("https://wa.me/549299");
  });
});

describe("armarBandeja", () => {
  it("agrupa por cliente y ordena del más viejo al más nuevo", () => {
    const b = armarBandeja([pedido("kimen", dias(2)), pedido("cecal", dias(1)), pedido("cecal", dias(5))], ahora, false);
    expect(b.hoy.map((g) => g.cliente)).toEqual(["cecal", "kimen"]);
    expect(b.hoy[0].tarjetas.map((t) => t.antiguedadMs)).toEqual([5 * 86_400_000, 1 * 86_400_000]);
    expect(b.hoy[0].tarjetas).toHaveLength(2);
  });
  it("lote de 5: con 7 primeros contactos muestra los 5 más viejos y primerosRestantes = 2", () => {
    const b = armarBandeja([1, 2, 3, 4, 5, 6, 7].map(primero), ahora, false);
    const tarjetas = b.cuando.flatMap((g) => g.tarjetas);
    expect(tarjetas.map((t) => t.cliente).sort()).toEqual(["P3", "P4", "P5", "P6", "P7"]);
    expect(b.primerosRestantes).toBe(2);
  });
  it("seguimientos y respondidos no cuentan para el lote de 5", () => {
    const extra = [1, 2, 3].map((n) => issue({ titulo: `S${n} · seguimiento 1` }));
    const resp = issue({ titulo: "R · primer contacto", labels: ["bandeja:comercial", "estado:respondio"] });
    const b = armarBandeja([...[1, 2, 3, 4, 5].map(primero), ...extra, resp], ahora, false);
    expect(b.cuando.flatMap((g) => g.tarjetas)).toHaveLength(5);
    expect(b.hoy.flatMap((g) => g.tarjetas)).toHaveLength(4);
    expect(b.primerosRestantes).toBe(0);
  });
  it("las tarjetas esperando no entran en el lote de 5", () => {
    const esperando = [1, 2, 3].map((n) => issue({ titulo: `E${n} · primer contacto`, labels: ["bandeja:comercial", "estado:enviado"] }));
    const b = armarBandeja([...[1, 2, 3, 4, 5].map(primero), ...esperando], ahora, false);
    const ts = b.cuando.flatMap((g) => g.tarjetas);
    expect(ts.filter((t) => t.subtipo === "primer-contacto")).toHaveLength(5);
    expect(ts.filter((t) => t.subtipo === "esperando")).toHaveLength(3);
    expect(b.primerosRestantes).toBe(0);
  });
  it("avisos amarillos del mismo cliente son una sola tarjeta con todos los items", () => {
    const a = (d: number) => issue({ labels: ["bandeja:mantenimiento", "nivel:amarillo", "cliente:cecal"], titulo: "a", creado: dias(d) });
    const b = armarBandeja([a(1), a(3)], ahora, false);
    const ts = b.cuando.flatMap((g) => g.tarjetas);
    expect(ts).toHaveLength(1);
    expect(ts[0].id).toBe("aviso:cecal");
    expect(ts[0].items.length).toBe(2);
    expect(ts[0].antiguedadMs).toBe(3 * 86_400_000);
  });
  it("un aviso rojo y uno amarillo del mismo cliente van a franjas distintas", () => {
    const rojo = issue({ labels: ["bandeja:mantenimiento", "nivel:rojo", "cliente:cecal"], titulo: "r" });
    const amar = issue({ labels: ["bandeja:mantenimiento", "nivel:amarillo", "cliente:cecal"], titulo: "y" });
    const b = armarBandeja([rojo, amar], ahora, false);
    expect(b.ahora.flatMap((g) => g.tarjetas)).toHaveLength(1);
    expect(b.cuando.flatMap((g) => g.tarjetas)).toHaveLength(1);
  });
  it("pasa truncado tal cual a la bandeja", () => {
    expect(armarBandeja([], ahora, true).truncado).toBe(true);
    expect(armarBandeja([], ahora, false).truncado).toBe(false);
  });
  it("ids: individual por repo#numero (pedido, PR, aviso rojo) y aviso:<cliente> para el amarillo fusionado", () => {
    const ped = pedido("cecal", dias(1));
    const p = pr();
    const rojo = issue({ labels: ["bandeja:mantenimiento", "nivel:rojo", "cliente:cecal"], titulo: "r" });
    const a1 = issue({ labels: ["bandeja:mantenimiento", "cliente:cecal"], titulo: "y1" });
    const a2 = issue({ labels: ["bandeja:mantenimiento", "nivel:amarillo", "cliente:cecal"], titulo: "y2" });
    const b = armarBandeja([ped, p, rojo, a1, a2], ahora, false);
    const ids = [...b.ahora, ...b.hoy, ...b.cuando].flatMap((g) => g.tarjetas.map((t) => t.id)).sort();
    expect(ids).toEqual([`claude-agents#${p.numero}`, `claude-agents#${rojo.numero}`, "aviso:cecal", `sincroweb-pedidos#${ped.numero}`].sort());
  });
});
