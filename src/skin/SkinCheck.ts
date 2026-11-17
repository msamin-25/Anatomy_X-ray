import type { LabelAnchor, SpeciesPlugin } from '../species/types';
import { icon, type IconName } from '../ui/icons';
import { evaluate, isEmergency, LEVELS, NONE, questionsFor, type Answers, type Level, type Question } from './guide';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const DISCLAIMER = 'General guidance based on NHS advice, not a diagnosis. If you are worried, see a doctor. Your answers stay on this device.';
const LEVEL_ICON: Record<Level, IconName> = {
  emergency: 'siren',
  today: 'clock',
  soon: 'calendar-check',
  selfcare: 'pill',
};

/**
 * Skin mode: the camera is a magnifier (no tracking) and a side panel runs
 * the guided questionnaire from `guide.ts`. It fits the plugin interface so
 * the main loop can treat it like the other modes.
 */
export class SkinCheck implements SpeciesPlugin {
  readonly id = 'skin';
  private answers: Answers = {};
  /** -1 is the intro; past the last question is the result. */
  private step = -1;
  private collapsed = false;

  constructor(private readonly panel: HTMLElement) {}

  async load(): Promise<void> {
    this.render();
  }

  update(): LabelAnchor[] {
    return [];
  }

  show(): void {
    this.panel.hidden = false;
  }

  hide(): void {
    this.panel.hidden = true;
  }

  dispose(): void {
    this.hide();
  }

  private render(): void {
    const questions = questionsFor(this.answers);
    const done = this.step >= questions.length || (this.step > 0 && isEmergency(this.answers));
    let body: string;
    if (this.step < 0) body = this.intro();
    else if (done) body = this.result();
    else body = this.question(questions[this.step], this.step, questions.length);

    this.panel.innerHTML = `
      <header class="panel-head">
        <span class="mode-icon">${icon('scan-search', 18)}</span>
        <div class="panel-title">
          <h2>Skin check</h2>
          <p>Guided questions · NHS-based advice</p>
        </div>
        <button class="icon-btn" data-action="toggle" aria-expanded="${!this.collapsed}" aria-label="${this.collapsed ? 'Show' : 'Hide'} the skin check">
          ${icon(this.collapsed ? 'chevron-down' : 'chevron-up')}
        </button>
      </header>
      <div class="panel-body" ${this.collapsed ? 'hidden' : ''}>${body}</div>`;
    this.panel.querySelectorAll<HTMLElement>('[data-action]').forEach((el) => {
      el.addEventListener('click', () => this.act(el.dataset.action!, el.dataset.option));
    });
  }

  private intro(): string {
    return `
      <h3>Not sure what a spot or rash is?</h3>
      <p class="lead" style="margin-top:6px">Look closely with the camera, then answer a few questions.</p>
      <ul class="feature-list">
        <li>${icon('clock', 18)} About a minute, five or six questions</li>
        <li>${icon('stethoscope', 18)} How soon to get help, and who to see</li>
        <li>${icon('shield-check', 18)} Answers stay on this device</li>
      </ul>
      <button class="btn btn-primary" data-action="start" style="width:100%">Start skin check</button>
      <p class="callout callout-note">${icon('info', 16)}<span>${DISCLAIMER}</span></p>`;
  }

  private question(q: Question, index: number, count: number): string {
    const picked = this.answers[q.id] ?? [];
    const options = q.options
      .map((o) => `
        <button class="option" data-action="pick" data-option="${o.id}" ${q.multi ? 'data-multi' : ''} aria-pressed="${picked.includes(o.id)}">
          <span class="indicator">${icon('check', 14)}</span><span>${esc(o.label)}</span>
        </button>`)
      .join('');
    return `
      <div class="progress" role="progressbar" aria-label="Progress" aria-valuemin="1" aria-valuemax="${count}" aria-valuenow="${index + 1}">
        <span style="width:${((index + 1) / count) * 100}%"></span>
      </div>
      <p class="step-count">Question ${index + 1} of ${count}</p>
      <h3>${esc(q.title)}</h3>
      ${q.help ? `<p class="help">${esc(q.help)}</p>` : ''}
      <div class="options" role="group" aria-label="${esc(q.title)}">${options}</div>
      <div class="panel-nav">
        <button class="btn btn-ghost" data-action="back">${icon('arrow-left', 16)} Back</button>
        ${q.multi ? `<button class="btn btn-primary" data-action="next" ${picked.length ? '' : 'disabled'}>Continue</button>` : ''}
      </div>`;
  }

  private result(): string {
    const r = evaluate(this.answers);
    const level = LEVELS[r.level];
    const link = (url?: string) =>
      url ? `<a class="source-link" href="${url}" target="_blank" rel="noopener">NHS guidance ${icon('external-link', 12)}</a>` : '';
    const reasons = r.reasons.map((x) => `<li>${esc(x.text)} ${link(x.url)}</li>`).join('');
    const causes = r.causes
      .map((c) => `<li class="cause"><strong>${esc(c.name)}</strong><p>${esc(c.blurb)}</p>${link(c.url)}</li>`)
      .join('');
    return `
      <div class="result level-${r.level}" role="status">
        <span class="result-icon">${icon(LEVEL_ICON[r.level], 20)}</span>
        <div>
          <strong>${level.title}</strong>
          <p>${esc(level.action)}</p>
        </div>
      </div>
      ${reasons ? `<h4>Why this advice</h4><ul class="reasons">${reasons}</ul>` : ''}
      ${causes ? `<h4>Common causes of skin like this</h4>
        <p class="help" style="margin:-2px 0 10px">Only a doctor can tell which, if any, it is.</p>
        <ul class="causes">${causes}</ul>` : ''}
      ${r.level === 'emergency' ? '' : `<p class="callout callout-tip">${icon('camera', 16)}<span>Save a photo now with the shutter button, so you or a doctor can see later whether it has changed.</span></p>`}
      <div class="panel-nav">
        <button class="btn btn-ghost" data-action="back">${icon('arrow-left', 16)} Back</button>
        <button class="btn btn-secondary" data-action="restart">${icon('rotate-ccw', 16)} Start over</button>
      </div>
      <p class="callout callout-note">${icon('info', 16)}<span>${DISCLAIMER}</span></p>`;
  }

  private act(action: string, option?: string): void {
    const questions = questionsFor(this.answers);
    const q = questions[this.step];
    switch (action) {
      case 'toggle':
        this.collapsed = !this.collapsed;
        break;
      case 'start':
        this.step = 0;
        break;
      case 'restart':
        this.answers = {};
        this.step = 0;
        break;
      case 'back':
        // From the result, go back to the last question (or the warning question after an emergency).
        if (this.step < 0) return;
        if (this.step >= questions.length || isEmergency(this.answers)) {
          this.step = isEmergency(this.answers) ? 0 : questions.length - 1;
        } else {
          this.step -= 1;
        }
        break;
      case 'next':
        this.step += 1;
        break;
      case 'pick': {
        if (!q || !option) return;
        if (!q.multi) {
          this.answers[q.id] = [option];
          // Changing the answer can change which questions follow (the mole check).
          if (q.id === 'look' && option !== 'mole') delete this.answers.mole;
          this.step += 1;
          break;
        }
        const current = new Set(this.answers[q.id] ?? []);
        if (current.has(option)) current.delete(option);
        else if (option === NONE) current.clear(), current.add(NONE);
        else current.delete(NONE), current.add(option);
        this.answers[q.id] = [...current];
        break;
      }
    }
    this.render();
    // Moving to another step starts at its top; ticking a box keeps the place.
    if (action !== 'toggle' && !(action === 'pick' && q?.multi)) this.panel.scrollTop = 0;
  }
}
