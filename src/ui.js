// DOM overlay: title card, subtitles, the take button, score, sound toggle.
export class UI {
  constructor(foley) {
    this.foley = foley;
    this.el = {
      title: document.getElementById('title'),
      begin: document.getElementById('begin'),
      sub: document.getElementById('sub'),
      take: document.getElementById('take'),
      clear: document.getElementById('clear'),
      score: document.getElementById('score'),
      sound: document.getElementById('sound'),
      loading: document.getElementById('loading'),
    };
    this.subTimer = 0;
    this.onConfirm = null;
    this.onClear = null;
    this.el.take.addEventListener('click', (e) => { e.stopPropagation(); this.onConfirm && this.onConfirm(); });
    this.el.clear.addEventListener('click', (e) => { e.stopPropagation(); this.onClear && this.onClear(); });
    this.el.sound.addEventListener('click', (e) => {
      e.stopPropagation();
      foley.unlock();
      foley.setMuted(!foley.muted);
      this.el.sound.textContent = foley.muted ? 'sound off' : 'sound on';
      this.el.sound.setAttribute('aria-pressed', String(!foley.muted));
    });
    const touch = matchMedia('(pointer: coarse)').matches;
    this.el.begin.textContent = touch ? 'tap to begin' : 'click to begin';
  }
  ready() {
    this.el.loading.classList.add('gone');
    this.el.title.classList.add('show');
  }
  // skip the title card (autoplay and debug runs start by themselves)
  dismissTitle() {
    this.el.title.classList.remove('show');
    this.el.title.classList.add('gone');
  }
  waitForStart() {
    return new Promise((res) => {
      const go = (e) => {
        if (e && e.target && e.target.id === 'sound') return;
        window.removeEventListener('pointerup', go);
        window.removeEventListener('keydown', key);
        this.el.title.classList.remove('show');
        this.el.title.classList.add('gone');
        res();
      };
      const key = (e) => { if (e.key === 'Enter' || e.key === ' ') go(); };
      window.addEventListener('pointerup', go);
      window.addEventListener('keydown', key);
    });
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
  setScore(s) {
    this.el.score.textContent = `you ${s.player}  ·  ${s.opponent} him`;
  }
}
