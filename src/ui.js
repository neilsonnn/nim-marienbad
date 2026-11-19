// DOM overlay: the settings panel (behind the gear), subtitles, the take button.
export class UI {
  constructor(foley) {
    this.foley = foley;
    this.el = {
      title: document.getElementById('title'),
      gear: document.getElementById('gear'),
      note: document.getElementById('note'),
      sub: document.getElementById('sub'),
      take: document.getElementById('take'),
      clear: document.getElementById('clear'),
      protest: document.getElementById('protest'),
      loading: document.getElementById('loading'),
      modeAI: document.getElementById('mode-ai'),
      modeTwo: document.getElementById('mode-two'),
      modeAuto: document.getElementById('mode-auto'),
    };
    // one player against him, or two people taking turns at the same screen
    let saved = 'ai';
    try { saved = localStorage.getItem('nim-mode') || 'ai'; } catch (e) { /* storage unavailable */ }
    const q = new URLSearchParams(location.search).get('players');
    this.players = q === '2' ? 'two' : q === '1' ? 'ai' : saved === 'two' ? 'two' : 'ai';
    this.autoplay = new URLSearchParams(location.search).has('autoplay');
    this.onPlayers = null; // (mode) => void
    this.onAutoplay = null; // (on) => void
    this._mark();
    this.subTimer = 0;
    this.onConfirm = null;
    this.onClear = null;
    this.el.take.addEventListener('click', (e) => { e.stopPropagation(); this.onConfirm && this.onConfirm(); });
    this.el.clear.addEventListener('click', (e) => { e.stopPropagation(); this.onClear && this.onClear(); });
    this.onProtest = null;
    this.el.protest.addEventListener('click', (e) => { e.stopPropagation(); this.onProtest && this.onProtest(); });
    // sound is always on; browsers only let it start after a gesture
    const unlock = () => foley.unlock();
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    // settings: the gear opens the old title card; click outside its buttons (or Esc) to close
    this.el.gear.addEventListener('click', (e) => { e.stopPropagation(); this.toggleSettings(); });
    this.el.title.addEventListener('click', (e) => { if (e.target === this.el.title) this.toggleSettings(false); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.settingsOpen) this.toggleSettings(false); });
    const pick = (mode) => {
      if (mode === this.players) return;
      this.players = mode;
      try { localStorage.setItem('nim-mode', mode); } catch (err) { /* ignore */ }
      this._mark();
      this.el.note.textContent = 'from the next game';
      this.onPlayers && this.onPlayers(mode);
    };
    this.el.modeAI.addEventListener('click', () => pick('ai'));
    this.el.modeTwo.addEventListener('click', () => pick('two'));
    this.el.modeAuto.addEventListener('click', () => {
      this.autoplay = !this.autoplay;
      this._mark();
      this.onAutoplay && this.onAutoplay(this.autoplay);
    });
  }
  get settingsOpen() { return this.el.title.classList.contains('show'); }
  toggleSettings(open = !this.settingsOpen) {
    this.el.title.classList.toggle('show', open);
    this.el.title.setAttribute('aria-hidden', String(!open));
    this.el.gear.setAttribute('aria-expanded', String(open));
    if (!open) this.el.note.textContent = '';
  }
  _mark() {
    this.el.modeAI.classList.toggle('pick', this.players === 'ai');
    this.el.modeTwo.classList.toggle('pick', this.players === 'two');
    this.el.modeAuto.classList.toggle('pick', this.autoplay);
    this.el.modeAuto.setAttribute('aria-pressed', String(this.autoplay));
    this.el.modeAuto.textContent = this.autoplay ? 'autoplay on' : 'autoplay off';
  }
  ready() {
    this.el.loading.classList.add('gone');
  }
  say(text, hold = 0) {
    const s = this.el.sub;
    clearTimeout(this.subTimer);
    if (!text) { s.classList.remove('show'); return; }
    s.textContent = text;
    s.classList.add('show');
    if (hold > 0) this.subTimer = setTimeout(() => s.classList.remove('show'), hold * 1000);
  }
  setSelection(n) {
    const words = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];
    if (n > 0) {
      this.el.take.textContent = `take ${words[n] || n}`;
      this.el.take.classList.add('show');
      this.el.clear.classList.add('show');
    } else {
      this.el.take.classList.remove('show');
      this.el.clear.classList.remove('show');
    }
  }
  // after a lost game: offer to protest; resolves true if clicked within `sec`
  offerProtest(sec, auto = false) {
    return new Promise((res) => {
      const b = this.el.protest;
      let t = 0;
      const done = (v) => { clearTimeout(t); this.onProtest = null; b.classList.remove('show'); res(v); };
      this.onProtest = () => done(true);
      b.classList.add('show');
      t = setTimeout(() => done(false), sec * 1000);
      if (auto) setTimeout(() => this.onProtest && this.onProtest(), 1800);
    });
  }
}
