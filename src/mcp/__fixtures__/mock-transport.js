/**
 * createMockTransport — in-memory MCP transport fixture for tests.
 *
 * Returns a 6-tuple of helpers exposing both the `MCP_Transport` public
 * contract (consumed by `MCP_Client`) and a set of test-only hooks for
 * injecting server → client events and asserting against captured
 * client → server frames.
 *
 * Shape:
 *   const {
 *     transport,          // conforms to MCP_Transport_Factory return object
 *     injectMessage,      // fn(msg): schedule onMessage(msg) on next microtask
 *     injectError,        // fn(err): schedule onError(err) on next microtask
 *     injectClose,        // fn(reason?): schedule onClose(reason) on next microtask
 *     sentMessages,       // () => JsonRpcMessage[]  — defensive snapshot
 *     waitForSend,        // (predicate) => Promise<JsonRpcMessage>
 *   } = createMockTransport()
 *
 * Contract highlights (see design.md §Testing Strategy → Mock Transport and
 * design.md §Architecture → 传输契约):
 *
 * - `transport.send / onMessage / onError / onClose / close` match the shape
 *   `MCP_Client` calls against real transports (stdio / http / sse).
 * - `transport.onMessage` / `onError` / `onClose` are set-last-wins (only the
 *   most recent registration fires) — matching `MCP_Client`'s usage, which
 *   registers each callback at most once.
 * - `injectMessage(msg)` schedules delivery via `queueMicrotask`, mirroring the
 *   real transports' async "next tick" dispatch; callers can `await
 *   Promise.resolve()` to observe the effect.
 * - `sentMessages()` returns a **new** array each time (defensive copy) so
 *   callers can push / splice without polluting the underlying log.
 * - `waitForSend(predicate)` matches against both already-sent messages
 *   (synchronous match, resolves immediately via `Promise.resolve`) and
 *   future sends (queued against subsequent `transport.send` calls). Once a
 *   queued waiter resolves, it is de-queued so the same predicate won't
 *   re-fire for later matching sends unless `waitForSend` is called again.
 * - `transport.close()` is idempotent and returns the cached close Promise.
 *   Calling `close()` also rejects any pending `waitForSend` waiters with a
 *   clear error so tests fail fast instead of hanging.
 *
 * This module is a TEST-ONLY fixture and is intentionally NOT re-exported
 * from `src/index.js` or `src/mcp/index.js`.
 *
 * @see Requirements 2.6, 6.3, 6.4, 7.2, 7.7 (consumers in client.test.js)
 */

/**
 * @typedef {object} MockTransportHandle
 * @property {{
 *   send: (message: object) => Promise<void>,
 *   onMessage: (cb: (msg: object) => void) => void,
 *   onError: (cb: (err: object) => void) => void,
 *   onClose: (cb: (reason?: object) => void) => void,
 *   close: () => Promise<void>,
 * }} transport
 * @property {(msg: object) => void} injectMessage
 * @property {(err: object) => void} injectError
 * @property {(reason?: object) => void} injectClose
 * @property {() => object[]} sentMessages
 * @property {(predicate: (msg: object) => boolean) => Promise<object>} waitForSend
 */

/**
 * Factory: create a fresh mock MCP transport + control handle.
 *
 * Each call produces an isolated state (no module-level mutation), so tests
 * can freely instantiate multiple mock transports in the same test file.
 *
 * @returns {MockTransportHandle}
 */
export function createMockTransport() {
  /** All frames passed to `transport.send`, in insertion order. */
  const sent = []

  /** Last-wins callbacks registered by the client. */
  let messageCb = null
  let errorCb = null
  let closeCb = null

  /** Close lifecycle — idempotent via cached promise. */
  let closed = false
  let closePromise = null

  /**
   * Queue of waitForSend(predicate) awaiters whose predicate has not yet
   * matched any send. Each entry is `{ predicate, resolve, reject }`.
   * Removed on match / on close / on predicate throw.
   */
  const pendingWaits = []

  const transport = {
    /**
     * Record an outgoing frame and fan out to matching `waitForSend` waiters.
     * Resolves immediately on the microtask queue (no actual I/O).
     *
     * @param {object} message
     * @returns {Promise<void>}
     */
    send(message) {
      if (closed) {
        return Promise.reject(new Error('mock transport: send after close'))
      }
      sent.push(message)

      // Walk a snapshot of waiters so in-flight resolve/reject (which are
      // async via Promise semantics anyway) never see a mutated list.
      const snapshot = pendingWaits.slice()
      for (const waiter of snapshot) {
        let match = false
        let predicateError = null
        try {
          match = Boolean(waiter.predicate(message))
        } catch (err) {
          predicateError = err
        }

        const index = pendingWaits.indexOf(waiter)
        if (predicateError !== null) {
          // A throwing predicate is a test bug; surface it on the waiter
          // promise and stop considering it for future sends.
          if (index !== -1) pendingWaits.splice(index, 1)
          waiter.reject(predicateError)
          continue
        }
        if (match) {
          if (index !== -1) pendingWaits.splice(index, 1)
          waiter.resolve(message)
        }
      }

      return Promise.resolve()
    },

    /**
     * Register the sole inbound-message callback. Last registration wins.
     * @param {(msg: object) => void} cb
     */
    onMessage(cb) {
      messageCb = typeof cb === 'function' ? cb : null
    },

    /**
     * Register the sole transport-error callback. Last registration wins.
     * @param {(err: object) => void} cb
     */
    onError(cb) {
      errorCb = typeof cb === 'function' ? cb : null
    },

    /**
     * Register the sole close callback. Last registration wins.
     * @param {(reason?: object) => void} cb
     */
    onClose(cb) {
      closeCb = typeof cb === 'function' ? cb : null
    },

    /**
     * Idempotent close. Subsequent calls return the same settled promise.
     * Rejects any still-pending `waitForSend` waiters with a clear error
     * so tests fail fast instead of hanging.
     *
     * Does NOT invoke the client-registered `onClose` callback — that is
     * reserved for transport-initiated disconnection, which tests simulate
     * explicitly via `injectClose(reason)`.
     *
     * @returns {Promise<void>}
     */
    close() {
      if (closePromise) return closePromise
      closed = true
      while (pendingWaits.length > 0) {
        const waiter = pendingWaits.shift()
        waiter.reject(new Error('mock transport: closed before predicate matched'))
      }
      closePromise = Promise.resolve()
      return closePromise
    },
  }

  /**
   * Schedule an inbound JSON-RPC message to be delivered to the
   * currently-registered `onMessage` callback on the next microtask.
   * If no callback is registered at dispatch time, the message is dropped
   * (mirroring how a real transport behaves before the client attaches).
   *
   * @param {object} msg
   */
  function injectMessage(msg) {
    queueMicrotask(() => {
      const cb = messageCb
      if (cb) cb(msg)
    })
  }

  /**
   * Schedule a transport-error event. Same async-dispatch semantics as
   * `injectMessage`.
   * @param {object} err  conventionally `{ kind: string, cause?: unknown, message?: string }`
   */
  function injectError(err) {
    queueMicrotask(() => {
      const cb = errorCb
      if (cb) cb(err)
    })
  }

  /**
   * Schedule a transport-close event. Same async-dispatch semantics as
   * `injectMessage`. Does not call `transport.close()` directly — tests
   * can invoke that separately to model "client initiates close" vs
   * "server / transport initiates close".
   *
   * @param {object} [reason] conventionally `{ code?, signal?, cause? }`
   */
  function injectClose(reason) {
    queueMicrotask(() => {
      const cb = closeCb
      if (cb) cb(reason)
    })
  }

  /**
   * Return a fresh snapshot of all frames passed to `transport.send`, in
   * insertion order. Callers can mutate the returned array freely.
   *
   * @returns {object[]}
   */
  function sentMessages() {
    return sent.slice()
  }

  /**
   * Resolve with the first outgoing frame that matches `predicate`.
   *
   * Matching strategy:
   *   1. Scan `sent` synchronously — if any prior frame matches, resolve
   *      immediately with that frame.
   *   2. Otherwise queue a waiter that will be checked against every
   *      subsequent `transport.send` call. On the first match, resolve and
   *      de-queue.
   *
   * Failure modes:
   *   - Transport already closed and no prior frame matched → reject.
   *   - Transport closes while waiter still queued → reject (`close()` walks
   *     the waiter list).
   *   - Predicate throws → reject with the thrown error and de-queue.
   *
   * Note: each `waitForSend` call creates an independent waiter; two
   * concurrent calls with the same predicate will both resolve on the first
   * matching send (each with the same frame).
   *
   * @param {(msg: object) => boolean} predicate
   * @returns {Promise<object>}
   */
  function waitForSend(predicate) {
    if (typeof predicate !== 'function') {
      return Promise.reject(
        new TypeError('mock transport: waitForSend predicate must be a function')
      )
    }

    // Phase 1: synchronous match against already-sent frames.
    for (const msg of sent) {
      let match = false
      try {
        match = Boolean(predicate(msg))
      } catch (err) {
        return Promise.reject(err)
      }
      if (match) return Promise.resolve(msg)
    }

    // Phase 2: queue for future matching, unless the transport is already
    // shut down — in that case no future sends can arrive, so fail fast.
    if (closed) {
      return Promise.reject(new Error('mock transport: waitForSend after close'))
    }

    return new Promise((resolve, reject) => {
      pendingWaits.push({ predicate, resolve, reject })
    })
  }

  return {
    transport,
    injectMessage,
    injectError,
    injectClose,
    sentMessages,
    waitForSend,
  }
}
