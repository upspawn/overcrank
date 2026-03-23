/**
 * Virtual clock — injected into the browser page before any other scripts.
 *
 * The source of truth is virtual-clock.js (lintable, syntax-checkable).
 * This file inlines it as a string for reliable module resolution
 * across Node, Bun, and npm package consumers.
 *
 * To update: edit virtual-clock.js, then run `bun scripts/inline-clock.ts`
 */

/* eslint-disable max-len */
export const VIRTUAL_CLOCK_SCRIPT = `(function () {
  'use strict'

  var startRealTime = Date.now()
  var virtualTimeMs = 0

  var _Date = Date
  var _perfNow = performance.now.bind(performance)
  var _setTimeout = window.setTimeout.bind(window)
  var _clearTimeout = window.clearTimeout.bind(window)
  var _setInterval = window.setInterval.bind(window)
  var _clearInterval = window.clearInterval.bind(window)
  var _requestAnimationFrame = window.requestAnimationFrame.bind(window)
  var _cancelAnimationFrame = window.cancelAnimationFrame.bind(window)

  var rafId = 0
  var rafQueue = new Map()

  window.requestAnimationFrame = function (cb) {
    var id = ++rafId
    rafQueue.set(id, cb)
    return id
  }

  window.cancelAnimationFrame = function (id) {
    rafQueue.delete(id)
  }

  function flushRAF() {
    var batch = rafQueue
    rafQueue = new Map()
    var timestamp = virtualTimeMs
    for (var entry of batch) {
      try { entry[1](timestamp) } catch (e) { console.error('[overcrank] RAF error:', e) }
    }
  }

  var timerId = 0
  var timers = new Map()

  window.setTimeout = function (cb, delay) {
    if (delay === undefined) delay = 0
    var args = Array.prototype.slice.call(arguments, 2)
    var id = ++timerId
    var fn = typeof cb === 'function' ? cb : function () { eval(cb) }
    timers.set(id, {
      cb: function () { fn.apply(null, args) },
      fireAt: virtualTimeMs + Math.max(0, delay),
      interval: null,
      cleared: false,
    })
    return id
  }

  window.clearTimeout = function (id) {
    var t = timers.get(id)
    if (t) t.cleared = true
    timers.delete(id)
  }

  window.setInterval = function (cb, delay) {
    if (delay === undefined) delay = 0
    var args = Array.prototype.slice.call(arguments, 2)
    var id = ++timerId
    var fn = typeof cb === 'function' ? cb : function () { eval(cb) }
    var ms = Math.max(1, delay)
    timers.set(id, {
      cb: function () { fn.apply(null, args) },
      fireAt: virtualTimeMs + ms,
      interval: ms,
      cleared: false,
    })
    return id
  }

  window.clearInterval = function (id) {
    window.clearTimeout(id)
  }

  function flushTimers() {
    var snapshot = []
    for (var entry of timers) {
      if (!entry[1].cleared && entry[1].fireAt <= virtualTimeMs) {
        snapshot.push(entry)
      }
    }
    snapshot.sort(function (a, b) { return a[1].fireAt - b[1].fireAt })

    for (var i = 0; i < snapshot.length; i++) {
      var id = snapshot[i][0]
      var t = snapshot[i][1]
      if (t.cleared) continue
      try { t.cb() } catch (e) { console.error('[overcrank] Timer error:', e) }
      if (t.interval != null && !t.cleared) {
        t.fireAt = virtualTimeMs + t.interval
      } else {
        timers.delete(id)
      }
    }
  }

  function VirtualDate() {
    if (arguments.length === 0) {
      if (this instanceof VirtualDate) {
        return new _Date(startRealTime + virtualTimeMs)
      }
      return new _Date(startRealTime + virtualTimeMs).toString()
    }
    if (this instanceof VirtualDate) {
      return new (Function.prototype.bind.apply(_Date, [null].concat(Array.prototype.slice.call(arguments))))()
    }
    return new (Function.prototype.bind.apply(_Date, [null].concat(Array.prototype.slice.call(arguments))))().toString()
  }

  VirtualDate.prototype = _Date.prototype
  VirtualDate.now = function () { return startRealTime + virtualTimeMs }
  VirtualDate.parse = _Date.parse
  VirtualDate.UTC = _Date.UTC
  Object.getOwnPropertyNames(_Date).forEach(function (key) {
    if (!(key in VirtualDate)) {
      try { VirtualDate[key] = _Date[key] } catch (_) {}
    }
  })

  window.Date = VirtualDate

  performance.now = function () { return virtualTimeMs }

  window.__virtualTime = {
    advance: function (ms) {
      virtualTimeMs += ms
      flushTimers()
      flushRAF()
    },
    now: function () { return virtualTimeMs },
    realNow: function () { return _perfNow() },
    pendingRAFs: function () { return rafQueue.size },
    pendingTimers: function () { return timers.size },
  }
})();`
