import { describe, expect, it } from "vitest";
import { renderBandeja } from "../lib/html";
import { armarBandeja } from "../lib/clasificar";
import { AGENTES } from "../lib/acciones";
import type { Bandeja, Grupo, IssueItem, PrItem, Tarjeta } from "../lib/tipos";

const ahora = new Date("2026-11-02T12:00:00Z");
const horas = (n: number) => new Date(ahora.getTime() - n * 3_600_000).toISOString();
const SHA = "a".repeat(40);
const URL_GH = "https://github.com/iavaca/claude-agents/issues/1";
let seq = 0;

function issue(o: Partial<IssueItem> = {}): IssueItem {
  return { clase: "issue", repo: "claude-agents", numero: ++seq, titulo: "Acme SA · primer contacto", cuerpo: "", labels: ["bandeja:comercial"], creado: horas(3), url: URL_GH, ...o };
}
function pr(o: Partial<PrItem> = {}): PrItem {
  return { clase: "pr", repo: "claude-agents", numero: ++seq, titulo: "Arreglo del agente", cuerpo: "", creado: horas(3), url: "https://github.com/iavaca/claude-agents/pull/9",
    sha: SHA, mergeable: "MERGEABLE", checks: "SUCCESS", archivos: [], archivosTotal: 0, borrador: false, ...o };
}
const html = (items: (IssueItem | PrItem)[], truncado = false) => renderBandeja(armarBandeja(items, ahora, truncado), ahora);
const vacia: Bandeja = { ahora: [], hoy: [], cuando: [], primerosRestantes: 0, truncado: false };

describe("renderBandeja", () => {
  it("escapa título y cuerpo con HTML", () => {
    const out = html([issue({ titulo: "Acme · primer contacto <img src=x onerror=alert(1)>", cuerpo: "<script>alert(1)</script>" })]);
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;img src=x");
  });

  it("no renderiza markdown: **negrita** y [x](y) salen literales", () => {
    const out = html([issue({ cuerpo: "hola **negrita** y [x](https://evil.example)" })]);
    expect(out).toContain("**negrita**");
    expect(out).toContain("[x](https://evil.example)");
    expect(out).not.toContain("<strong");
    expect(out).not.toContain('href="https://evil.example"');
  });

  it("no pone href si el link no está permitido", () => {
    const sin = html([issue({ cuerpo: "sin link" })]);
    expect(sin).not.toContain("Abrir");
    const malo = html([issue({ cuerpo: "Link: javascript:alert(1)" })]);
    expect(malo).not.toContain("href=\"javascript:");
    expect(malo).not.toContain("Abrir");
  });

  it("link comercial permitido: texto según wa.me o mailto", () => {
    expect(html([issue({ cuerpo: "Link: https://wa.me/5491100000000?text=hola" })])).toContain(">Abrir WhatsApp<");
    expect(html([issue({ cuerpo: "Link: mailto:a@b.com" })])).toContain(">Abrir mail<");
  });

  it("no pone href si la url de un PR o aviso no está permitida", () => {
    const out = html([pr({ url: "javascript:alert(1)" })]);
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("Ver en GitHub");
  });

  it("botón Mergear lleva data-sha del PR", () => {
    const out = html([pr({ numero: 42 })]);
    expect(out).toContain(`data-accion="mergear" data-repo="claude-agents" data-numero="42" data-sha="${SHA}"`);
    expect(out).toContain("Pedir cambios");
    expect(out).toContain("Ver en GitHub");
    expect(out).toContain('id="t=claude-agents-42"');
  });

  it("PR: archivos (hasta 20 + 'y N más') y checks", () => {
    const archivos = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`);
    const out = html([pr({ archivos, archivosTotal: 27, checks: "FAILURE" })]);
    expect(out).toContain("src/f19.ts");
    expect(out).toContain("y 7 más");
    expect(out).toContain("en rojo");
    expect(html([pr({ checks: "SUCCESS" })])).toContain("verdes");
    expect(html([pr({ checks: "PENDING" })])).toContain("corriendo");
    expect(html([pr({ checks: null })])).toContain("sin checks");
  });

  it("subtipo respondio no muestra Respondió", () => {
    const normal = html([issue({ titulo: "Acme · seguimiento 1" })]);
    expect(normal).toContain(">Respondió<");
    expect(normal).toContain(">Enviado<");
    const resp = html([issue({ titulo: "Acme · seguimiento 1", labels: ["bandeja:comercial", "estado:respondio"] })]);
    expect(resp).toContain(">Enviado<");
    expect(resp).not.toContain("Respondió");
  });

  it("esperando: agrupadas en un details plegado con un solo botón Respondió", () => {
    const env = ["bandeja:comercial", "estado:enviado"];
    const out = html([
      issue({ titulo: "Acme · seguimiento 1", labels: env, numero: 71 }),
      issue({ titulo: "Beta · primer contacto", labels: env, numero: 72 }),
    ]);
    expect(out).toContain("<details");
    expect(out).not.toMatch(/<details[^>]*\bopen\b/);
    expect(out).toContain("<summary>Esperando respuesta (2)</summary>");
    expect(out.match(/data-accion="respondio"/g)).toHaveLength(2);
    expect(out).not.toContain('data-accion="enviado"');
    expect(out).not.toContain("Abrir ");
    expect(out.indexOf("<details")).toBeLessThan(out.indexOf('id="t=claude-agents-71"'));
  });
  it("sin tarjetas esperando no hay details", () => {
    expect(html([issue()])).not.toContain("<details");
  });
  it("el resumen comercial no muestra la línea Link: ni el prefijo '> '", () => {
    const out = html([issue({ cuerpo: "Link: https://wa.me/549299\n> Hola Juan,\n> te escribo por la web" })]);
    expect(out).toContain('<p class="resumen">Hola Juan, te escribo por la web</p>');
    expect(out).not.toContain("Link: ");
  });
  it("pedido: select de agentes y botones", () => {
    const out = html([issue({ repo: "sincroweb-pedidos", titulo: "Pedido", labels: ["cliente:cecal"], numero: 7 })]);
    for (const a of AGENTES) expect(out).toContain(`<option value="${a}">`);
    expect(out).toContain('data-accion="asignar" data-repo="sincroweb-pedidos" data-numero="7"');
    expect(out).toContain("Cotizar extra");
    expect(out).toContain('data-accion="cerrar"');
  });

  it("aviso agrupado: un Resuelto por aviso, id aviso-<cliente>", () => {
    const out = html([
      issue({ numero: 31, titulo: "SSL", labels: ["bandeja:mantenimiento", "nivel:amarillo", "cliente:cecal"] }),
      issue({ numero: 32, titulo: "Dominio", labels: ["bandeja:mantenimiento", "nivel:amarillo", "cliente:cecal"] }),
    ]);
    expect(out).toContain('id="aviso-cecal"');
    expect(out).toContain('data-accion="resuelto" data-repo="claude-agents" data-numero="31"');
    expect(out).toContain('data-accion="resuelto" data-repo="claude-agents" data-numero="32"');
  });

  it("franjas con sus títulos y antigüedad legible", () => {
    const out = html([
      issue({ labels: ["bandeja:mantenimiento", "nivel:rojo", "cliente:cecal"], titulo: "Caído", creado: horas(3) }),
      issue({ titulo: "Beta · seguimiento 1", creado: horas(48) }),
    ]);
    expect(out).toContain('<section data-franja="ahora"');
    expect(out).toContain("<h2>Ahora</h2>");
    expect(out).toContain('<section data-franja="hoy"');
    expect(out).toContain("<h2>Hoy</h2>");
    expect(out).toContain("hace 3 h");
    expect(out).toContain("hace 2 d");
    expect(out).toContain("<h3>cecal</h3>");
  });

  it("muestra 'y 2 primeros contactos más' y el aviso de truncado", () => {
    const b: Bandeja = { ...vacia, primerosRestantes: 2, truncado: true };
    const out = renderBandeja(b, ahora);
    expect(out).toContain("y 2 primeros contactos más en la cola");
    expect(out).toContain("Hay más en GitHub de lo que entra acá");
  });

  it("bandeja vacía muestra 'Nada pendiente. Bien ahí.'", () => {
    expect(renderBandeja(vacia, ahora)).toContain("Nada pendiente. Bien ahí.");
    expect(html([pr()])).not.toContain("Nada pendiente");
  });

  it("atributos escapados: un nombre de cliente con comillas no rompe el id", () => {
    const t: Tarjeta = { id: "aviso:x", tipo: "aviso", cliente: 'a" onmouseover="x', franja: "ahora", antiguedadMs: 1000, items: [issue({ titulo: "t" })] };
    const g: Grupo = { cliente: t.cliente, tarjetas: [t] };
    const out = renderBandeja({ ...vacia, ahora: [g] }, ahora);
    expect(out).toContain('id="aviso-a&quot; onmouseover=&quot;x"');
    expect(out).not.toContain('" onmouseover="');
  });

  it("el detalle de una tarjeta sin cuerpo repite título y cliente, escapados", () => {
    const out = html([issue({ titulo: "Caído <b>web</b>", cuerpo: "", labels: ["bandeja:mantenimiento", "nivel:rojo", "cliente:cecal"] })]);
    const detalle = /<div class="detalle">(.*?)<\/div><\/div>/s.exec(out)![1];
    expect(detalle).toContain("Caído &lt;b&gt;web&lt;/b&gt;");
    expect(detalle).toContain("cecal · hace 3 h");
    expect(detalle).not.toContain("<b>");
  });
});
