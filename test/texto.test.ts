import { describe, expect, it } from "vitest";
import { escaparHtml, esLinkPermitido, extraerLink, resumen } from "../lib/texto";

describe("texto", () => {
  it("escaparHtml escapa & < > \" '", () =>
    expect(escaparHtml(`<img src=x onerror="a">&'`)).toBe("&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;"));
  it("esLinkPermitido acepta https, wa.me y mailto", () => {
    for (const u of ["https://sincroweb.com.ar", "https://wa.me/5492990000000?text=Hola", "mailto:a@b.com?subject=x"]) expect(esLinkPermitido(u)).toBe(true);
  });
  it("esLinkPermitido rechaza javascript:, http:, data:, relativos y con espacios o control", () => {
    for (const u of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "http://x.com", "data:text/html,x", "/api/x", "https://x.com/a b", "https://x.com/\u0000", ""]) expect(esLinkPermitido(u)).toBe(false);
  });
  it("extraerLink toma la primera línea 'Link: <url>' y solo si está permitida", () => {
    expect(extraerLink("Canal: WhatsApp\nLink: https://wa.me/549299?text=a\nTexto:\n> hola")).toBe("https://wa.me/549299?text=a");
    expect(extraerLink("Link: javascript:alert(1)")).toBeUndefined();
    expect(extraerLink("> Link: https://trampa.com")).toBeUndefined(); // dentro de la cita no cuenta
  });
  it("resumen pasa a una línea y corta por code points", () => {
    expect(resumen("a\n\nb", 10)).toBe("a b");
    expect(resumen("😀".repeat(5), 3)).toBe("😀😀…");
  });
});
