/**
 * WorkerPool — Multi-browser-thread task execution pool.
 *
 * Dispatches heavy CPU mathematical calculations (such as physics BVH
 * acceleration tree construction and AI navigation grids) to background
 * OS threads via Web Workers.
 *
 * Features:
 *   - Auto-scales to navigator.hardwareConcurrency (clamped to 1..4 threads)
 *   - Zero-copy Transferable ArrayBuffer support
 *   - Graceful fallback: seamlessly flags supported=false if Workers are
 *     restricted, allowing main-thread fallback with zero breaking changes.
 */

export class WorkerPool {
  constructor({ workerUrl, size, workerSource } = {}) {
    const hw = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 2) : 2;
    this.size = size ?? Math.max(1, Math.min(4, hw - 1));
    this.workerUrl = workerUrl ?? null;
    this.workerSource = workerSource ?? null;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.promises = new Map();
    this._nextTaskId = 1;
    this.supported = typeof Worker !== 'undefined';
    this._blobUrl = null;

    if (this.supported) {
      this._initWorkers();
    }
  }

  _initWorkers() {
    try {
      let url = this.workerUrl;
      if (!url && this.workerSource) {
        const blob = new Blob([this.workerSource], { type: 'application/javascript' });
        url = URL.createObjectURL(blob);
        this._blobUrl = url;
      }

      if (!url) return;

      for (let i = 0; i < this.size; i++) {
        const worker = new Worker(url, { type: 'module' });
        const workerEntry = { id: i, worker, busy: false };

        worker.onmessage = (e) => this._handleMessage(workerEntry, e.data);
        worker.onerror = (err) => this._handleError(workerEntry, err);

        this.workers.push(workerEntry);
        this.idle.push(workerEntry);
      }
    } catch (err) {
      console.warn('[worker-pool] failed to initialize workers, falling back to main thread:', err?.message ?? err);
      this.supported = false;
      this.dispose();
    }
  }

  _handleMessage(workerEntry, data) {
    const { taskId, success, result, error } = data;
    const p = this.promises.get(taskId);
    if (p) {
      this.promises.delete(taskId);
      if (success) {
        p.resolve(result);
      } else {
        p.reject(new Error(error || 'Worker task failed'));
      }
    }

    workerEntry.busy = false;
    this.idle.push(workerEntry);
    this._drain();
  }

  _handleError(workerEntry, err) {
    console.error(`[worker-pool] worker ${workerEntry.id} encountered error:`, err);
    workerEntry.busy = false;
    // Drain remaining tasks
    this._drain();
  }

  _drain() {
    if (this.queue.length === 0 || this.idle.length === 0) return;
    const workerEntry = this.idle.pop();
    workerEntry.busy = true;

    const task = this.queue.shift();
    workerEntry.worker.postMessage(task.msg, task.transferables);
  }

  /**
   * Dispatch a task to a background worker thread.
   * @param {string} type - task identifier
   * @param {any} payload - serializable data
   * @param {Transferable[]} [transferables=[]] - memory buffers to transfer zero-copy
   * @returns {Promise<any>}
   */
  dispatch(type, payload, transferables = []) {
    if (!this.supported || this.workers.length === 0) {
      return Promise.reject(new Error('[worker-pool] workers unavailable'));
    }

    const taskId = this._nextTaskId++;
    const msg = { taskId, type, payload };

    return new Promise((resolve, reject) => {
      this.promises.set(taskId, { resolve, reject });
      this.queue.push({ msg, transferables });
      this._drain();
    });
  }

  dispose() {
    for (const w of this.workers) {
      try {
        w.worker.terminate();
      } catch {}
    }
    this.workers = [];
    this.idle = [];
    this.queue = [];
    if (this._blobUrl) {
      try {
        URL.revokeObjectURL(this._blobUrl);
      } catch {}
      this._blobUrl = null;
    }
  }
}
