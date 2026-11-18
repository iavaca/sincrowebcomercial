(function () {
  'use strict';

  // Todo se pinta con textContent: nada de lo que viene del servidor se inserta como HTML.
  var $ = function (id) { return document.getElementById(id); };
  var form = $('form');
  var lista = $('lista');
  var selMes = $('mes');
  var aviso = $('aviso');
  var CONFIRMAR_MS = 5000;
  var PESO = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
  var HOY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  var NOMBRES_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  var TIPOS = ['gasto', 'cobro', 'transferencia'];
  var LABEL_PERSONA = { gasto: 'Quién pagó', cobro: 'A quién le entró la plata', transferencia: 'Quién transfirió' };

  var datos = null;
  var tipo = 'gasto';
  var mesElegido = null;
  var ocupado = false;
  var armado = null; // { boton, timer }
  var pendiente = null; // transferencia sugerida para precargar

  var pesos = function (n) { return PESO.format(n); };
  var hoy = function () { return HOY.format(new Date()); };

  function el(tag, clase, texto) {
    var e = document.createElement(tag);
    if (clase) e.className = clase;
    if (texto !== undefined) e.textContent = texto;
    return e;
  }

  function opciones(select, pares, vacia) {
    var actual = select.value;
    select.replaceChildren();
    if (vacia) select.appendChild(new Option(vacia, ''));
    pares.forEach(function (p) { select.appendChild(new Option(p[1], p[0])); });
    if (actual && pares.some(function (p) { return p[0] === actual; })) select.value = actual;
  }

  function mostrar(motivoEl, texto) {
    motivoEl.textContent = texto || '';
    motivoEl.hidden = !texto;
  }

  function irALogin() { location.href = '/api/login'; }

  async function pedir(metodo, cuerpo) {
    var init = { method: metodo, credentials: 'same-origin', cache: 'no-store' };
    if (cuerpo) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(cuerpo); }
    var res = await fetch('/api/finanzas', init);
    if (res.status === 401) { irALogin(); throw new Error('login'); }
    var d = null;
    try { d = await res.json(); } catch (e) { d = null; }
    return { ok: res.ok, d: d };
  }

  async function cargar() {
    var r;
    try { r = await pedir('GET'); } catch (e) {
      if (e.message !== 'login') { aviso.textContent = 'Sin conexión. Probá recargar.'; aviso.hidden = false; }
      return;
    }
    if (!r.ok || !r.d || !r.d.saldo) {
      aviso.textContent = (r.d && r.d.texto) || 'No se pudieron leer las finanzas. Probá recargar.';
      aviso.hidden = false;
      return;
    }
    aviso.hidden = true;
    var primera = datos === null;
    datos = r.d;
    if (primera) armarFormulario();
    pintar();
    $('estado').textContent = 'Actualizado ' + new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
    $('finanzas').setAttribute('aria-busy', 'false');
  }

  var nombre = function (p) { return datos.personas[p] || p; };
  function nombreCliente(m) {
    if (!m.cliente) return '';
    if (m.cliente === 'otro') return m.clienteNombre || 'Otro';
    var c = datos.clientes.find(function (x) { return x.slug === m.cliente; });
    return c ? c.nombre : m.cliente;
  }

  function armarFormulario() {
    var personas = Object.keys(datos.personas).map(function (k) { return [k, datos.personas[k]]; });
    opciones(form.persona, personas);
    opciones(form.para, personas);
    form.persona.value = datos.yo;
    form.para.value = personas.map(function (p) { return p[0]; }).find(function (p) { return p !== datos.yo; }) || datos.yo;
    opciones(form.categoria, datos.categorias.map(function (c) { return [c, c]; }), 'Elegí una categoría');
    opciones(form.cliente, datos.clientes.map(function (c) { return [c.slug, c.nombre]; }), 'Sin cliente');
    form.fecha.value = hoy();
    elegirTipo('gasto');
  }

  function elegirTipo(t) {
    tipo = t;
    TIPOS.forEach(function (x) {
      var tab = $('tab-' + x);
      tab.setAttribute('aria-selected', String(x === t));
      tab.tabIndex = x === t ? 0 : -1;
    });
    form.setAttribute('aria-labelledby', 'tab-' + t);
    $('label-persona').textContent = LABEL_PERSONA[t];
    $('label-cliente').textContent = t === 'cobro' ? 'Cliente' : 'Cliente (opcional)';
    $('label-concepto').textContent = t === 'gasto' ? 'Concepto (ej: Hostinger anual)' : 'Concepto (opcional)';
    form.cliente.options[0].textContent = t === 'cobro' ? 'Elegí un cliente' : 'Sin cliente';
    actualizarVisibles();
    mostrar($('motivo-form'), '');
  }

  function actualizarVisibles() {
    Array.prototype.forEach.call(form.querySelectorAll('[data-solo]'), function (lab) {
      var solo = lab.dataset.solo.split(' ');
      var visible = solo.indexOf('otro') !== -1 ? (tipo !== 'transferencia' && form.cliente.value === 'otro') : solo.indexOf(tipo) !== -1;
      lab.hidden = !visible;
    });
  }

  function pintar() {
    var s = datos.saldo;
    var t = s.transferir;
    $('saldo-titulo').textContent = t
      ? nombre(t.de) + ' le transfiere ' + pesos(t.monto) + ' a ' + nombre(t.para)
      : (datos.movimientos.length ? 'Están al 50%. No hay nada que transferir.' : 'Todavía no hay movimientos cargados.');
    $('registrar').hidden = !t;
    pendiente = t;

    var totales = [['Cobrado', s.cobros], ['Gastado', s.gastos], ['Ganancia', s.ganancia], ['A cada uno', Math.round(s.mitad)]];
    $('totales').replaceChildren.apply($('totales'), totales.map(function (x) {
      var d = el('div');
      d.appendChild(el('dt', '', x[0]));
      d.appendChild(el('dd', '', pesos(x[1])));
      return d;
    }));
    $('en-mano').textContent = 'Tiene en mano hoy: ' + Object.keys(s.neto).map(function (p) { return nombre(p) + ' ' + pesos(s.neto[p]); }).join(' · ') + '. Totales desde el primer movimiento.';

    pintarMeses();
    pintarLista();
  }

  function etiquetaMes(m) {
    var partes = m.split('-');
    var t = NOMBRES_MES[Number(partes[1]) - 1] + ' ' + partes[0];
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  function pintarMeses() {
    var meses = {};
    meses[hoy().slice(0, 7)] = true;
    datos.movimientos.forEach(function (m) { meses[m.fecha.slice(0, 7)] = true; });
    var orden = Object.keys(meses).sort().reverse();
    if (!mesElegido || orden.indexOf(mesElegido) === -1) mesElegido = orden[0];
    opciones(selMes, orden.map(function (m) { return [m, etiquetaMes(m)]; }));
    selMes.value = mesElegido;
  }

  function descripcion(m) {
    if (m.tipo === 'transferencia') return nombre(m.persona) + ' → ' + nombre(m.para);
    if (m.tipo === 'cobro') return 'Cobro · ' + nombreCliente(m);
    return 'Gasto · ' + (m.concepto || m.categoria);
  }

  function meta(m) {
    var f = m.fecha.split('-');
    var partes = [f[2] + '/' + f[1]];
    if (m.tipo === 'cobro') partes.push('le entró a ' + nombre(m.persona));
    if (m.tipo === 'gasto') { partes.push('pagó ' + nombre(m.persona)); partes.push(m.categoria); if (m.cliente) partes.push(nombreCliente(m)); }
    if (m.tipo !== 'gasto' && m.concepto) partes.push(m.concepto);
    partes.push('cargó ' + nombre(m.cargadoPor));
    return partes.join(' · ');
  }

  function pintarLista() {
    desarmar();
    var delMes = datos.movimientos.filter(function (m) { return m.fecha.slice(0, 7) === mesElegido; });
    var cob = 0, gas = 0;
    delMes.forEach(function (m) { if (m.tipo === 'cobro') cob += m.monto; if (m.tipo === 'gasto') gas += m.monto; });
    $('resumen-mes').textContent = delMes.length
      ? 'En ' + etiquetaMes(mesElegido).toLowerCase() + ': cobrado ' + pesos(cob) + ' · gastado ' + pesos(gas) + ' · ganancia ' + pesos(cob - gas)
      : 'Sin movimientos en ' + etiquetaMes(mesElegido).toLowerCase() + '.';
    lista.replaceChildren.apply(lista, delMes.map(function (m) {
      var li = el('li', 'mov');
      li.dataset.tipo = m.tipo;
      var cuerpo = el('div', 'mov-cuerpo');
      var linea = el('p', 'mov-linea');
      linea.appendChild(el('span', 'mov-que', descripcion(m)));
      linea.appendChild(el('span', 'mov-monto', (m.tipo === 'gasto' ? '−' : '') + pesos(m.monto)));
      cuerpo.appendChild(linea);
      cuerpo.appendChild(el('p', 'mov-meta', meta(m)));
      li.appendChild(cuerpo);
      var b = el('button', '', 'Borrar');
      b.type = 'button';
      b.dataset.borrar = m.id;
      b.setAttribute('aria-label', 'Borrar ' + descripcion(m) + ' ' + pesos(m.monto));
      li.appendChild(b);
      return li;
    }));
  }

  function desarmar() {
    if (!armado) return;
    clearTimeout(armado.timer);
    armado.boton.textContent = 'Borrar';
    armado.boton.classList.remove('armado');
    armado = null;
  }

  function bloquear(si) {
    ocupado = si;
    Array.prototype.forEach.call(document.querySelectorAll('main button, main input, main select'), function (b) { b.disabled = si; });
  }

  async function enviar(cuerpo, motivoEl) {
    if (ocupado) return false;
    bloquear(true);
    mostrar(motivoEl, '');
    var r;
    try { r = await pedir('POST', cuerpo); } catch (e) {
      bloquear(false);
      if (e.message !== 'login') mostrar(motivoEl, 'No se pudo enviar. Revisá la conexión y probá de nuevo.');
      return false;
    }
    if (r.ok && r.d && r.d.ok === true) {
      await cargar();
      bloquear(false);
      return true;
    }
    bloquear(false);
    mostrar(motivoEl, (r.d && r.d.texto) || 'No se pudo guardar. Probá de nuevo.');
    return false;
  }

  function leerMonto() {
    var t = form.monto.value.replace(/[\s.$]/g, '');
    return /^\d{1,10}$/.test(t) ? Number(t) : NaN;
  }

  function movimientoDelForm() {
    var m = { tipo: tipo, fecha: form.fecha.value, monto: leerMonto(), persona: form.persona.value, concepto: form.concepto.value.trim() };
    if (!m.fecha) return 'Falta la fecha.';
    if (!(m.monto > 0)) return 'El monto tiene que ser un número entero de pesos, sin centavos.';
    if (tipo === 'transferencia') {
      m.para = form.para.value;
      if (m.para === m.persona) return 'La transferencia tiene que ser entre los dos.';
      return m;
    }
    if (form.cliente.value) m.cliente = form.cliente.value;
    if (tipo === 'cobro' && !m.cliente) return 'Elegí el cliente que pagó.';
    if (m.cliente === 'otro') {
      m.clienteNombre = form.clienteNombre.value.trim();
      if (!m.clienteNombre) return 'Escribí el nombre del cliente.';
    }
    if (tipo === 'gasto') {
      m.categoria = form.categoria.value;
      if (!m.categoria) return 'Elegí una categoría.';
      if (!m.concepto) return 'Escribí en qué se gastó.';
    }
    return m;
  }

  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var m = movimientoDelForm();
    if (typeof m === 'string') { mostrar($('motivo-form'), m); return; }
    var ok = await enviar({ op: 'agregar', movimiento: m }, $('motivo-form'));
    if (ok) {
      form.monto.value = '';
      form.concepto.value = '';
      form.clienteNombre.value = '';
      $('estado').textContent = 'Guardado ' + new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
  });

  form.cliente.addEventListener('change', actualizarVisibles);

  document.querySelector('[role="tablist"]').addEventListener('click', function (ev) {
    var tab = ev.target.closest('[role="tab"]');
    if (tab) elegirTipo(tab.dataset.tipo);
  });
  document.querySelector('[role="tablist"]').addEventListener('keydown', function (ev) {
    var i = TIPOS.indexOf(tipo), d;
    if (ev.key === 'ArrowRight') d = (i + 1) % 3;
    else if (ev.key === 'ArrowLeft') d = (i + 2) % 3;
    else return;
    ev.preventDefault();
    elegirTipo(TIPOS[d]);
    $('tab-' + TIPOS[d]).focus();
  });

  $('registrar').addEventListener('click', function () {
    if (!pendiente) return;
    elegirTipo('transferencia');
    form.persona.value = pendiente.de;
    form.para.value = pendiente.para;
    form.monto.value = String(pendiente.monto);
    form.fecha.value = hoy();
    form.concepto.value = 'Saldo 50/50';
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    form.querySelector('button[type="submit"]').focus({ preventScroll: true });
  });

  selMes.addEventListener('change', function () { mesElegido = selMes.value; pintarLista(); });

  lista.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-borrar]');
    if (!b || b.disabled) return;
    if (!armado || armado.boton !== b) {
      desarmar();
      b.textContent = 'Confirmar';
      b.classList.add('armado');
      armado = { boton: b, timer: setTimeout(desarmar, CONFIRMAR_MS) };
      return;
    }
    var id = b.dataset.borrar;
    desarmar();
    enviar({ op: 'borrar', id: id }, $('motivo-lista'));
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && !ocupado && document.activeElement && !form.contains(document.activeElement)) cargar();
  });

  cargar();
})();
