/**
 * Owns resources created for one open chat.
 *
 * A chat in the SPA is replaced often. Keeping its listeners, timers,
 * observers and socket under one owner prevents a previous chat from acting
 * on the next chat's DOM after navigation.
 */
export class ChatLifetime {
  constructor(label = 'chat') {
    this.label = label;
    this.disposed = false;
    this._cleanups = new Set();
    this._timeouts = new Set();
    this._intervals = new Set();
    this._observers = new Set();
    this._sockets = new Set();
  }

  add(cleanup) {
    if (typeof cleanup !== 'function') return cleanup;
    if (this.disposed) {
      try { cleanup(); } catch {}
      return cleanup;
    }
    this._cleanups.add(cleanup);
    return cleanup;
  }

  remove(cleanup) {
    this._cleanups.delete(cleanup);
  }

  listen(target, type, handler, options) {
    if (!target?.addEventListener || typeof handler !== 'function') return () => {};
    target.addEventListener(type, handler, options);
    return this.add(() => target.removeEventListener(type, handler, options));
  }

  timeout(callback, delay = 0) {
    if (this.disposed) return null;
    const id = window.setTimeout(() => {
      this._timeouts.delete(id);
      if (!this.disposed) callback();
    }, delay);
    this._timeouts.add(id);
    return id;
  }

  clearTimeout(id) {
    if (id === null || id === undefined) return;
    window.clearTimeout(id);
    this._timeouts.delete(id);
  }

  interval(callback, delay = 0) {
    if (this.disposed) return null;
    const id = window.setInterval(() => {
      if (!this.disposed) callback();
    }, delay);
    this._intervals.add(id);
    return id;
  }

  clearInterval(id) {
    if (id === null || id === undefined) return;
    window.clearInterval(id);
    this._intervals.delete(id);
  }

  observe(observer, target, options) {
    if (!observer?.observe || !target) return observer;
    observer.observe(target, options);
    this._observers.add(observer);
    return observer;
  }

  trackSocket(socket) {
    if (socket) this._sockets.add(socket);
    return socket;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;

    for (const id of this._timeouts) window.clearTimeout(id);
    this._timeouts.clear();
    for (const id of this._intervals) window.clearInterval(id);
    this._intervals.clear();

    for (const observer of this._observers) {
      try { observer.disconnect(); } catch {}
    }
    this._observers.clear();

    for (const socket of this._sockets) {
      try {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        if (socket.readyState !== WebSocket.CLOSED) socket.close();
      } catch {}
    }
    this._sockets.clear();

    for (const cleanup of Array.from(this._cleanups).reverse()) {
      try { cleanup(); } catch {}
    }
    this._cleanups.clear();
  }
}
