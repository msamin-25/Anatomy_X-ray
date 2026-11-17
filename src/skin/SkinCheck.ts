import type { LabelAnchor, SpeciesPlugin } from '../species/types';
import { evaluate, isEmergency, LEVELS, NONE, questionsFor, type Answers, type Question } from './guide';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const DISCLAIMER = 'General guidance based on NHS advice, not a diagnosis. If you are worried, see a doctor. Your answers stay on this device.';

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
      <header class="skin-head">
        <h2>Skin check</h2>
        <button class="skin-toggle" aria-expanded="${!this.collapsed}">${this.collapsed ? 'Show' : 'Hide'}</button>
      </header>
      <div class="skin-body" ${this.collapsed ? 'hidden' : ''}>${body}</div>`;
    this.panel.querySelector('.skin-toggle')!.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.render();
    });
    this.panel.querySelectorAll<HTMLElement>('[data-action]').forEach((el) => {
      el.addEventListener('click', () => this.act(el.dataset.action!, el.dataset.option));
    });
  }

  private intro(): string {
    return `
      <p>Answer a few questions about a spot or rash. You will get advice on how soon to see someone, who to see, and common causes of skin like this.</p>
      <p class="skin-note">${DISCLAIMER}</p>
      <button class="primary" data-action="start">Start</button>`;
  }

  private question(q: Question, index: number, count: number): string {
    const picked = this.answers[q.id] ?? [];
    const options = q.options
      .map((o) => `<button class="skin-option" data-action="pick" data-option="${o.id}" aria-pressed="${picked.includes(o.id)}">${esc(o.label)}</button>`)
      .join('');
    return `
      <p class="skin-step">Question ${index + 1} of ${count}</p>
      <h3>${esc(q.title)}</h3>
      ${q.help ? `<p class="skin-help">${esc(q.help)}</p>` : ''}
      <div class="skin-options" role="group" aria-label="${esc(q.title)}">${options}</div>
      <div class="skin-nav">
        <button data-action="back">Back</button>
        ${q.multi ? `<button class="primary" data-action="next" ${picked.length ? '' : 'disabled'}>Next</button>` : ''}
      </div>`;
  }

  private result(): string {
    const r = evaluate(this.answers);
    const level = LEVELS[r.level];
    const link = (url?: string) => (url ? ` <a href="${url}" target="_blank" rel="noopener">Read more (NHS)</a>` : '');
    const reasons = r.reasons.map((x) => `<li>${esc(x.text)}${link(x.url)}</li>`).join('');
    const causes = r.causes.map((c) => `<li><strong>${esc(c.name)}</strong>: ${esc(c.blurb)}${link(c.url)}</li>`).join('');
    return `
      <div class="skin-level level-${r.level}" role="status">
        <strong>${level.title}</strong>
        <p>${esc(level.action)}</p>
      </div>
      ${reasons ? `<h3>Why</h3><ul>${reasons}</ul>` : ''}
      ${causes ? `<h3>Common causes of skin like this</h3>
        <p class="skin-help">Only a doctor can tell which, if any, it is.</p><ul>${causes}</ul>` : ''}
      ${r.level === 'emergency' ? '' : '<p class="skin-help">Tip: tap <strong>Save photo</strong> now, so you or a doctor can see later whether it has changed.</p>'}
      <p class="skin-note">${DISCLAIMER}</p>
      <div class="skin-nav">
        <button data-action="back">Back</button>
        <button data-action="restart">Start again</button>
      </div>`;
  }

  private act(action: string, option?: string): void {
    const questions = questionsFor(this.answers);
    const q = questions[this.step];
    switch (action) {
      case 'start':
        this.step = 0;
        break;
      case 'restart':
        this.answers = {};
        this.step = 0;
        break;
      case 'back':
        // From the result, go back to the last question (or the warning question after an emergency).
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
    this.panel.scrollTop = 0;
  }
}
