const MIN_SCALE = 0.01;
const MAX_SCALE = 16;
const clampScale = scale => Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));

export function zoomAt(view, scale, point) {
  scale = clampScale(scale);
  const ratio = scale / view.scale;
  return { x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio, scale };
}

export function fitView(bounds, size) {
  const scale = clampScale(Math.min(1, Math.max(1, size.width - 64) / bounds.width, Math.max(1, size.height - 64) / bounds.height));
  return {
    x: size.width / 2 - (bounds.x + bounds.width / 2) * scale,
    y: size.height / 2 - (bounds.y + bounds.height / 2) * scale,
    scale
  };
}

export function initialPosition(index) {
  const row = Math.floor(index / 3);
  return { x: (row % 2 ? 2 - index % 3 : index % 3) * 400, y: row * 420 };
}

export class SceneCanvas {
  constructor(root) {
    this.viewport = root.querySelector('#timeline-canvas');
    this.world = root.querySelector('#timeline-world');
    this.links = root.querySelector('#timeline-links');
    this.controls = Object.fromEntries(['zoom-out', 'zoom-in', 'reset', 'fit', 'arrange'].map(name => [name, root.querySelector(`#canvas-${name}`)]));
    this.nodes = new Map();
    this.visible = false;
    this.reset();
    this.controls['zoom-out'].addEventListener('click', () => this.zoom(this.view.scale / 1.25));
    this.controls['zoom-in'].addEventListener('click', () => this.zoom(this.view.scale * 1.25));
    this.controls.reset.addEventListener('click', () => this.zoom(1));
    this.controls.fit.addEventListener('click', () => this.fit());
    this.controls.arrange.addEventListener('click', () => {
      [...this.nodes.values()].forEach((entry, index) => Object.assign(entry, initialPosition(index)));
      this.nextSlot = this.nodes.size;
      this.positionNodes();
      this.fit();
    });
    this.viewport.addEventListener('wheel', event => {
      event.preventDefault();
      if (this.drag) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewport.clientHeight : 1;
      if (event.shiftKey && !event.ctrlKey) {
        this.view.x -= event.deltaX * unit;
        this.view.y -= event.deltaY * unit;
        this.applyView();
      } else {
        const delta = Math.max(-800, Math.min(800, event.deltaY * unit));
        const rect = this.viewport.getBoundingClientRect();
        this.zoom(this.view.scale * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)), { x: event.clientX - rect.left, y: event.clientY - rect.top });
      }
    }, { passive: false });
    this.viewport.addEventListener('pointerdown', event => this.startDrag(event), true);
    this.viewport.addEventListener('pointermove', event => this.moveDrag(event));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this.viewport.addEventListener(type, event => {
        if (event.pointerId === this.drag?.pointerId) this.endDrag();
      });
    }
    this.viewport.addEventListener('keydown', event => this.keydown(event));
    this.viewport.addEventListener('focusin', event => {
      if (!event.target.matches(':focus-visible')) return;
      const entry = this.nodes.get(event.target.closest('.timeline-node')?.dataset.jobId);
      if (!entry) return;
      const rect = entry.node.getBoundingClientRect();
      const viewport = this.viewport.getBoundingClientRect();
      if (rect.left < viewport.left || rect.right > viewport.right || rect.top < viewport.top || rect.bottom > viewport.bottom) {
        const fitted = fitView(this.bounds([entry]), this.size());
        this.view = { ...fitted, scale: Math.min(this.view.scale, fitted.scale) };
        this.view.x = viewport.width / 2 - (entry.x + entry.node.offsetWidth / 2) * this.view.scale;
        this.view.y = viewport.height / 2 - (entry.y + entry.node.offsetHeight / 2) * this.view.scale;
        this.applyView();
      }
    });
    window.addEventListener('keyup', event => { if (event.code === 'Space') this.releaseSpace(); });
    window.addEventListener('blur', () => { this.releaseSpace(); this.endDrag(); });
    this.observer = new ResizeObserver(() => {
      const size = this.size();
      if (!this.visible || !size.width || !size.height) return;
      if (this.lastSize) {
        this.view.x += (size.width - this.lastSize.width) / 2;
        this.view.y += (size.height - this.lastSize.height) / 2;
      }
      this.lastSize = size;
      this.applyView();
    });
    this.observer.observe(this.viewport);
  }

  size() {
    return { width: this.viewport.clientWidth, height: this.viewport.clientHeight };
  }

  reset() {
    this.endDrag();
    this.releaseSpace();
    this.nodes.clear();
    this.nextSlot = 0;
    this.framed = false;
    this.lastSize = null;
    this.view = { x: 32, y: 32, scale: 1 };
    this.links.replaceChildren();
    this.applyView();
  }

  setVisible(visible) {
    this.visible = visible;
    if (visible) {
      if (!this.framed) this.fit();
    } else {
      this.endDrag();
      this.releaseSpace();
    }
  }

  sync(nodes) {
    this.nodes = new Map(nodes.map(node => {
      const id = node.dataset.jobId;
      return [id, this.nodes.get(id) || { node, ...initialPosition(this.nextSlot++) }];
    }));
    if (this.drag?.entry && !this.nodes.has(this.drag.entry.node.dataset.jobId)) this.endDrag();
    if (!this.nodes.size) { this.nextSlot = 0; this.framed = false; }
    this.positionNodes();
    this.controls.fit.disabled = this.controls.arrange.disabled = this.nodes.size === 0;
    if (this.visible && !this.framed) this.fit();
  }

  positionNodes() {
    for (const entry of this.nodes.values()) entry.node.style.transform = `translate(${entry.x}px, ${entry.y}px)`;
    const entries = [...this.nodes.values()];
    const paths = entries.slice(1).map((target, index) => {
      const source = entries[index];
      const a = { x: source.x + source.node.offsetWidth / 2, y: source.y + source.node.offsetHeight / 2 };
      const b = { x: target.x + target.node.offsetWidth / 2, y: target.y + target.node.offsetHeight / 2 };
      const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
      const axis = horizontal ? 'x' : 'y';
      const dimension = horizontal ? 'offsetWidth' : 'offsetHeight';
      const direction = b[axis] >= a[axis] ? 1 : -1;
      a[axis] += direction * (source.node[dimension] / 2 + 6);
      b[axis] -= direction * (target.node[dimension] / 2 + 10);
      const distance = Math.max(36, Math.abs(b[axis] - a[axis]) / 2);
      const c = { ...a, [axis]: a[axis] + direction * distance };
      const d = { ...b, [axis]: b[axis] - direction * distance };
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      line.setAttribute('d', `M ${a.x} ${a.y} C ${c.x} ${c.y}, ${d.x} ${d.y}, ${b.x} ${b.y}`);
      line.setAttribute('marker-end', 'url(#canvas-arrow)');
      return line;
    });
    this.links.replaceChildren(...paths);
  }

  bounds(entries = [...this.nodes.values()]) {
    const x = Math.min(...entries.map(entry => entry.x));
    const y = Math.min(...entries.map(entry => entry.y));
    return {
      x, y,
      width: Math.max(...entries.map(entry => entry.x + entry.node.offsetWidth)) - x,
      height: Math.max(...entries.map(entry => entry.y + entry.node.offsetHeight)) - y
    };
  }

  fit() {
    if (!this.nodes.size || !this.viewport.clientWidth || !this.viewport.clientHeight) return;
    this.view = fitView(this.bounds(), this.size());
    this.framed = true;
    this.lastSize = this.size();
    this.applyView();
  }

  zoom(scale, point = { x: this.viewport.clientWidth / 2, y: this.viewport.clientHeight / 2 }) {
    this.view = zoomAt(this.view, scale, point);
    this.applyView();
  }

  applyView() {
    const { x, y, scale } = this.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    let spacing = 24 * scale;
    while (spacing < 16) spacing *= 4;
    while (spacing > 64) spacing /= 4;
    this.viewport.style.backgroundSize = `${spacing}px ${spacing}px`;
    this.viewport.style.backgroundPosition = `${x % spacing}px ${y % spacing}px`;
    this.controls.reset.textContent = `${Math.round(scale * 100)}%`;
    this.controls['zoom-out'].disabled = scale <= MIN_SCALE;
    this.controls['zoom-in'].disabled = scale >= MAX_SCALE;
  }

  startDrag(event) {
    if (this.drag || !event.isPrimary || (event.button !== 0 && event.button !== 1)) return;
    const handle = event.target.closest('.canvas-drag');
    const pan = event.button === 1 || this.spaceHeld || !event.target.closest('.timeline-card');
    if (!pan && !handle) return;
    const entry = pan ? null : this.nodes.get(handle.closest('.timeline-node').dataset.jobId);
    event.preventDefault();
    event.stopPropagation();
    if (pan) this.viewport.focus({ preventScroll: true });
    else handle.focus({ preventScroll: true });
    this.drag = {
      pointerId: event.pointerId, entry, clientX: event.clientX, clientY: event.clientY,
      x: entry ? entry.x : this.view.x, y: entry ? entry.y : this.view.y
    };
    this.viewport.setPointerCapture(event.pointerId);
    this.viewport.classList.add('is-dragging');
    entry?.node.classList.add('is-moving');
  }

  moveDrag(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.clientX;
    const dy = event.clientY - drag.clientY;
    if (drag.entry) {
      drag.entry.x = drag.x + dx / this.view.scale;
      drag.entry.y = drag.y + dy / this.view.scale;
      this.positionNodes();
    } else {
      this.view.x = drag.x + dx;
      this.view.y = drag.y + dy;
      this.applyView();
    }
  }

  endDrag() {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    drag.entry?.node.classList.remove('is-moving');
    this.viewport.classList.remove('is-dragging');
    if (this.viewport.hasPointerCapture(drag.pointerId)) this.viewport.releasePointerCapture(drag.pointerId);
  }

  releaseSpace() {
    this.spaceHeld = false;
    this.viewport.classList.remove('space-pan');
  }

  keydown(event) {
    if (event.key === 'Escape') { this.endDrag(); this.releaseSpace(); return; }
    if (this.drag) return;
    const handle = event.target.closest('.canvas-drag');
    if (event.target !== this.viewport && !handle) return;
    if (event.code === 'Space') {
      event.preventDefault();
      this.spaceHeld = true;
      this.viewport.classList.add('space-pan');
      return;
    }
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (direction) {
      event.preventDefault();
      if (handle) {
        const entry = this.nodes.get(handle.closest('.timeline-node').dataset.jobId);
        entry.x += direction[0] * (event.shiftKey ? 40 : 10);
        entry.y += direction[1] * (event.shiftKey ? 40 : 10);
        this.positionNodes();
      } else {
        this.view.x += direction[0] * 80;
        this.view.y += direction[1] * 80;
        this.applyView();
      }
    } else if (['+', '=', '-', '0', 'Home'].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'Home') this.fit();
      else this.zoom(event.key === '0' ? 1 : this.view.scale * (event.key === '-' ? 0.8 : 1.25));
    }
  }
}
