(function () {
  'use strict';

  var lista = document.getElementById('bandeja');
  var avisoConexion = document.getElementById('aviso');
  var estado = document.getElementById('estado');
  var CADA_MS = 60000;
  var CONFIRMAR_MS = 5000;
  var TEXTOS_CONFIRMAR = { mergear: 'Confirmar merge', cerrar: 'Confirmar cierre' };

  var ultimoHtml = null;
  var ultimaOk = null;
  var sinConexion = false;
  var refrescoEnCola = false;
  var cola = Promise.resolve();
  var armado = null; // { boton, texto, timer }

  function hora(d) {
    return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  // Todas las requests pasan por esta cola: nunca dos a la vez, y un POST espera a que termine el GET en vuelo.
  function encolar(tarea) {
    cola = cola.then(tarea).catch(function () {});
    return cola;
  }

  function irALogin() {
    location.href = '/api/login?volver=' + encodeURIComponent(location.hash);
  }

  function botones() {
    return lista.querySelectorAll('button, select, input');
  }

  function bloquear(si) {
    Array.prototype.forEach.call(botones(), function (b) { b.disabled = si; });
  }

  function desconectar() {
    sinConexion = true;
    avisoConexion.textContent = ultimaOk
      ? 'Sin conexión · última actualización ' + hora(ultimaOk)
      : 'Sin conexión · todavía no se pudo cargar la bandeja';
    avisoConexion.hidden = false;
    bloquear(true);
  }

  function conectar() {
    sinConexion = false;
    ultimaOk = new Date();
    avisoConexion.hidden = true;
    bloquear(false);
    estado.textContent = 'Actualizada ' + hora(ultimaOk);
  }

  function marcarSeleccion() {
    var actual = lista.querySelector('.seleccionada');
    if (actual) actual.classList.remove('seleccionada');
    if (!location.hash) return;
    var id;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch (e) { return; }
    var tarjetas = lista.querySelectorAll('article');
    for (var i = 0; i < tarjetas.length; i++) {
      if (tarjetas[i].id === id) { tarjetas[i].classList.add('seleccionada'); return; }
    }
  }

  function editando() {
    var a = document.activeElement;
    return !!(a && lista.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) || armado !== null;
  }

  // El fragmento ya viene escapado desde /api/bandeja; es lo único que se inserta como HTML.
  function pintar(html) {
    if (html === ultimoHtml || editando()) return;
    var plantilla = document.createElement('template');
    plantilla.innerHTML = html;
    lista.replaceChildren(plantilla.content);
    ultimoHtml = html;
    marcarSeleccion();
  }

  async function cargar() {
    var res;
    var html;
    try {
      res = await fetch('/api/bandeja', { credentials: 'same-origin', cache: 'no-store' });
      if (res.status === 401) { irALogin(); return false; }
      if (!res.ok) throw new Error('estado ' + res.status);
      html = await res.text();
    } catch (e) {
      desconectar();
      return false;
    }
    conectar();
    pintar(html);
    lista.setAttribute('aria-busy', 'false');
    return true;
  }

  function refrescar() {
    if (refrescoEnCola) return;
    refrescoEnCola = true;
    encolar(function () {
      refrescoEnCola = false;
      return cargar();
    });
  }

  function desarmar() {
    if (!armado) return;
    clearTimeout(armado.timer);
    armado.boton.textContent = armado.texto;
    armado.boton.classList.remove('armado');
    armado = null;
  }

  function armar(boton) {
    desarmar();
    var texto = boton.textContent;
    boton.textContent = TEXTOS_CONFIRMAR[boton.dataset.accion];
    boton.classList.add('armado');
    armado = { boton: boton, texto: texto, timer: setTimeout(desarmar, CONFIRMAR_MS) };
  }

  function cargaUtil(boton) {
    var d = boton.dataset;
    var p = { tipo: d.accion, repo: d.repo, numero: Number(d.numero) };
    if (d.sha) p.sha = d.sha;
    if (d.agente) p.agente = d.agente;
    if (d.comentario !== undefined && d.accion === 'pedir_cambios') p.comentario = d.comentario;
    return p;
  }

  function mostrarMotivo(tarjeta, texto) {
    var m = tarjeta.querySelector('.motivo');
    if (!m) return;
    m.textContent = texto;
    m.hidden = false;
  }

  function enviar(boton) {
    var tarjeta = boton.closest('article');
    var carga = cargaUtil(boton);
    var motivo = tarjeta.querySelector('.motivo');
    motivo.hidden = true;
    tarjeta.classList.add('espera');
    tarjeta.setAttribute('aria-busy', 'true');
    Array.prototype.forEach.call(tarjeta.querySelectorAll('button, select, input'), function (b) { b.disabled = true; });

    function liberar() {
      tarjeta.classList.remove('espera');
      tarjeta.removeAttribute('aria-busy');
      if (!sinConexion) {
        Array.prototype.forEach.call(tarjeta.querySelectorAll('button, select, input'), function (b) { b.disabled = false; });
      }
    }

    encolar(async function () {
      var res;
      var datos = null;
      try {
        res = await fetch('/api/accion', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(carga)
        });
        if (res.status === 401) { irALogin(); return; }
        try { datos = await res.json(); } catch (e) { datos = null; }
      } catch (e) {
        liberar();
        mostrarMotivo(tarjeta, 'No se pudo enviar. Revisá la conexión y probá de nuevo.');
        return;
      }
      if (res.ok && datos && datos.ok === true) {
        await cargar();
        liberar();
        return;
      }
      liberar();
      var texto = datos && typeof datos.texto === 'string' ? datos.texto : 'No se pudo hacer. Probá de nuevo.';
      mostrarMotivo(tarjeta, texto);
    });
  }

  lista.addEventListener('click', function (ev) {
    var boton = ev.target.closest('button');
    if (!boton || boton.disabled || !lista.contains(boton)) return;

    if (boton.dataset.abrir === 'cambios') {
      var form = boton.closest('article').querySelector('form.cambios');
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector('input').focus();
      return;
    }
    if (!boton.dataset.accion || boton.type === 'submit') return; // el submit lo maneja el form

    var pideConfirmar = !!TEXTOS_CONFIRMAR[boton.dataset.accion];
    if (pideConfirmar && (!armado || armado.boton !== boton)) {
      armar(boton);
      return;
    }
    desarmar();
    enviar(boton);
  });

  lista.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var form = ev.target;
    var entrada = form.querySelector('input');
    var boton = form.querySelector('button[data-accion]');
    var texto = entrada.value.trim();
    if (!texto || boton.disabled) return;
    boton.dataset.comentario = texto;
    enviar(boton);
  });

  lista.addEventListener('change', function (ev) {
    if (ev.target.tagName !== 'SELECT') return;
    var asignar = ev.target.closest('article').querySelector('button[data-accion="asignar"]');
    if (asignar) asignar.dataset.agente = ev.target.value;
  });

  window.addEventListener('hashchange', marcarSeleccion);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refrescar();
  });
  document.getElementById('actualizar').addEventListener('click', refrescar);
  setInterval(refrescar, CADA_MS);
  refrescar();
})();
