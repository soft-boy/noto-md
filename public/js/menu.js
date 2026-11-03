import { escapeHtml } from './inline.js';

// A floating, keyboard-navigable list used for the slash menu and block menus.
export class Menu {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'menu';
    this.el.hidden = true;
    document.body.append(this.el);
    this.el.addEventListener('mousedown', (e) => e.preventDefault());
    this.el.addEventListener('click', (e) => {
      const row = e.target.closest('.menu-item');
      if (row) this.pick(Number(row.dataset.i));
    });
    this.el.addEventListener('mousemove', (e) => {
      const row = e.target.closest('.menu-item');
      if (row && Number(row.dataset.i) !== this.active) this.setActive(Number(row.dataset.i), false);
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.el.hidden && !this.el.contains(e.target)) this.close();
    });
    // Capture phase, so menu navigation wins over the editor's own key handling.
    document.addEventListener('keydown', (e) => {
      if (this.handleKey(e)) e.stopPropagation();
    }, true);
  }

  get isOpen() { return !this.el.hidden; }

  open({ rect, items, onPick, onClose, query = '' }) {
    this.all = items;
    this.onPick = onPick;
    this.onClose = onClose;
    this.rect = rect;
    this.el.hidden = false;
    this.filter(query);
  }

  filter(query) {
    const q = query.trim().toLowerCase();
    this.items = !q ? this.all : this.all.filter((it) => it.action && [it.label, ...(it.keywords || [])]
      .some((k) => k.toLowerCase().includes(q)));
    this.active = this.items.findIndex((it) => it.action);
    this.render(q);
    return this.items.some((it) => it.action);
  }

  render(q) {
    let html = '';
    let section = null;
    this.items.forEach((it, i) => {
      if (it.section && it.section !== section && !q) {
        section = it.section;
        html += `<div class="menu-section">${escapeHtml(section)}</div>`;
      }
      if (!it.action) return;
      html += `<div class="menu-item${it.danger ? ' danger' : ''}" data-i="${i}">
        <span class="menu-icon">${it.icon || ''}</span>
        <span class="menu-text"><span class="menu-label">${escapeHtml(it.label)}</span>${it.desc ? `<span class="menu-desc">${escapeHtml(it.desc)}</span>` : ''}</span>
        ${it.hint ? `<span class="menu-hint">${escapeHtml(it.hint)}</span>` : ''}
      </div>`;
    });
    this.el.innerHTML = html || '<div class="menu-empty">No results</div>';
    this.setActive(this.active, true);
    this.position();
  }

  position() {
    const { rect } = this;
    const h = this.el.offsetHeight;
    const w = this.el.offsetWidth;
    let top = rect.bottom + 6;
    if (top + h > innerHeight - 8 && rect.top - h - 6 > 8) top = rect.top - h - 6;
    const left = Math.max(8, Math.min(rect.left, innerWidth - w - 8));
    this.el.style.top = `${Math.max(8, top)}px`;
    this.el.style.left = `${left}px`;
  }

  setActive(i, scroll) {
    this.active = i;
    for (const row of this.el.querySelectorAll('.menu-item')) {
      const on = Number(row.dataset.i) === i;
      row.classList.toggle('active', on);
      if (on && scroll) row.scrollIntoView({ block: 'nearest' });
    }
  }

  move(dir) {
    const actionable = this.items.map((it, i) => (it.action ? i : -1)).filter((i) => i >= 0);
    if (!actionable.length) return;
    const pos = actionable.indexOf(this.active);
    this.setActive(actionable[(pos + dir + actionable.length) % actionable.length], true);
  }

  // Returns true when the key was consumed by the menu.
  handleKey(e) {
    if (!this.isOpen) return false;
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); this.move(1); return true; }
    if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) { e.preventDefault(); this.move(-1); return true; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (this.active >= 0) this.pick(this.active);
      else this.close();
      return true;
    }
    if (e.key === 'Escape') { e.preventDefault(); this.close(); return true; }
    return false;
  }

  pick(i) {
    const it = this.items[i];
    if (!it?.action) return;
    const cb = this.onPick;
    this.close(true);
    cb?.(it);
  }

  close(picked = false) {
    if (this.el.hidden) return;
    this.el.hidden = true;
    const cb = this.onClose;
    this.onClose = null;
    cb?.(picked);
  }
}
