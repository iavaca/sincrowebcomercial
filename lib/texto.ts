export function escaparHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function esLinkPermitido(url: string): boolean {
  // new URL ignora saltos y tabs internos: se rechazan antes.
  if (/[\s\u0000-\u001F\u007F]/.test(url)) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

// Solo cuenta la primera línea "Link: <url>" sin nada delante (una línea citada con ">" no cuenta).
export function extraerLink(cuerpo: string): string | undefined {
  for (const linea of cuerpo.split(/\r\n|\r|\n/)) {
    const m = /^Link: (\S+)$/.exec(linea);
    if (m) return esLinkPermitido(m[1]) ? m[1] : undefined;
  }
  return undefined;
}

export function resumen(s: string, max: number): string {
  // Se corta por code points para no partir un emoji a la mitad.
  const letras = Array.from(s.replace(/\s+/g, " ").trim());
  return letras.length > max ? `${letras.slice(0, max - 1).join("")}…` : letras.join("");
}
