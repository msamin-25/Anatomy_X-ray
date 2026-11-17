/**
 * Guided skin check: a short questionnaire that says how urgently to get
 * help and lists common causes of skin that looks like this. It does not
 * diagnose. The warning signs follow NHS guidance (nhs.uk/conditions).
 *
 * An image classifier was evaluated for this feature and rejected: on 661
 * dermatologist-labelled phone photos (Google SCIN) the best free model got
 * 15% top-1 against a 54% always-eczema baseline and caught 0 of 15 skin
 * cancers. See docs/ARCHITECTURE.md.
 */

export type Level = 'emergency' | 'today' | 'soon' | 'selfcare';

export interface Option {
  id: string;
  label: string;
}

export interface Question {
  id: string;
  title: string;
  help?: string;
  multi: boolean;
  options: Option[];
  /** Asked only when this returns true. */
  when?: (a: Answers) => boolean;
}

/** Selected option ids per question. */
export type Answers = Record<string, string[]>;

export interface Link {
  text: string;
  url?: string;
}

export interface Cause {
  name: string;
  blurb: string;
  url: string;
}

export interface Result {
  level: Level;
  /** Why the level was chosen, most urgent first. */
  reasons: Link[];
  causes: Cause[];
}

const NHS = 'https://www.nhs.uk/conditions/';
/** Multi-select answer meaning "none of these"; it clears the others. */
export const NONE = 'none';

export const QUESTIONS: Question[] = [
  {
    id: 'warning',
    title: 'Do you have any of these right now?',
    help: 'Tick all that apply.',
    multi: true,
    options: [
      { id: 'breathing', label: 'Trouble breathing, or swelling of the lips, tongue, face or throat' },
      { id: 'glass', label: 'A rash that does not fade when you press a clear glass on it, and you feel unwell' },
      { id: 'peeling', label: 'Blistering or peeling skin over a large area, or sores in the mouth, eyes or genitals' },
      { id: 'sepsis', label: 'Feeling very unwell: high fever or shivering, fast breathing or heartbeat, confusion, or very sleepy' },
      { id: 'hot', label: 'Skin that is painful, hot and swollen' },
      { id: NONE, label: 'None of these' },
    ],
  },
  {
    id: 'look',
    title: 'What does it look like most?',
    help: 'Use the camera to look closely. Zoom and light are in the bar below.',
    multi: false,
    options: [
      { id: 'mole', label: 'A mole, freckle or dark spot' },
      { id: 'welts', label: 'Raised itchy welts (hives) that come and go' },
      { id: 'dry', label: 'Dry, rough, scaly or itchy patches' },
      { id: 'ring', label: 'A ring-shaped patch, often clearer in the middle' },
      { id: 'bumps', label: 'Spots, pimples or small bumps' },
      { id: 'blisters', label: 'Blisters (small bubbles of fluid)' },
      { id: 'crust', label: 'Crusty, weeping or golden-brown sores' },
      { id: 'sore', label: 'A sore, lump or growth that will not heal' },
      { id: 'swollen', label: 'A swollen, warm area that looks red or darker' },
      { id: 'pale', label: 'Lighter or white patches' },
      { id: 'flush', label: 'Redness or flushing on the face' },
      { id: 'other', label: 'Something else' },
    ],
  },
  {
    id: 'mole',
    title: 'Check the mole for these warning signs (ABCDE)',
    help: 'Tick all that apply. Compare it with your other moles.',
    multi: true,
    when: (a) => has(a, 'look', 'mole'),
    options: [
      { id: 'asymmetry', label: 'A: the two halves do not match' },
      { id: 'border', label: 'B: the edge is ragged, notched or blurred' },
      { id: 'colour', label: 'C: more than one colour or shade' },
      { id: 'diameter', label: 'D: wider than 6 mm (a pencil eraser)' },
      { id: 'evolving', label: 'E: it has changed in size, shape, colour or height' },
      { id: 'symptoms', label: 'It itches, hurts, bleeds or is crusty' },
      { id: 'new', label: 'It is a new or unusual mark that has not gone away after a few weeks' },
      { id: NONE, label: 'None of these' },
    ],
  },
  {
    id: 'where',
    title: 'Where is it?',
    multi: false,
    options: [
      { id: 'face', label: 'Face or scalp' },
      { id: 'hands', label: 'Hands or feet' },
      { id: 'limbs', label: 'Arms or legs' },
      { id: 'body', label: 'Chest, back or tummy' },
      { id: 'folds', label: 'Skin folds or groin' },
      { id: 'widespread', label: 'Lots of places, or all over' },
    ],
  },
  {
    id: 'duration',
    title: 'How long have you had it?',
    multi: false,
    options: [
      { id: 'days', label: 'A few days' },
      { id: 'weeks', label: 'Up to 4 weeks' },
      { id: 'long', label: 'More than 4 weeks' },
      { id: 'recurring', label: 'It comes and goes' },
    ],
  },
  {
    id: 'other',
    title: 'Does any of this apply?',
    help: 'Tick all that apply.',
    multi: true,
    options: [
      { id: 'itchy', label: 'Itchy' },
      { id: 'night', label: 'Very itchy at night' },
      { id: 'painful', label: 'Painful or burning' },
      { id: 'spreading', label: 'Spreading or getting bigger' },
      { id: 'band', label: 'In a band or strip on one side of the body or face' },
      { id: 'fever', label: 'Fever or feeling unwell' },
      { id: 'medicine', label: 'It started after a new medicine' },
      { id: 'contact', label: 'It started after touching something new (soap, cream, plant, metal)' },
      { id: 'household', label: 'People you live with are itchy too' },
      { id: NONE, label: 'None of these' },
    ],
  },
];

export const LEVELS: Record<Level, { title: string; action: string }> = {
  emergency: {
    title: 'Get emergency help now',
    action: 'Call your local emergency number (for example 911, 999 or 112) or go to the nearest emergency department.',
  },
  today: {
    title: 'Get medical help today',
    action: 'Contact your doctor, an urgent care or out-of-hours service today. A pharmacist can also advise.',
  },
  soon: {
    title: 'See a doctor soon',
    action: 'Book an appointment with a doctor within the next 2 weeks, sooner if it gets worse. They can refer you to a dermatologist (skin specialist).',
  },
  selfcare: {
    title: 'Start with a pharmacist',
    action: 'Nothing in your answers needs urgent care. A pharmacist can suggest treatment. See a doctor if it is not better in 2 weeks, it spreads, or you start to feel unwell.',
  },
};

interface CauseRule extends Cause {
  looks: string[];
  /** Extra answers that make this cause more likely, by question id. */
  boost?: Partial<Record<string, string[]>>;
  /** Listed first whenever it matches: causes that must not be hidden behind harmless ones. */
  priority?: boolean;
}

const CAUSES: CauseRule[] = [
  { name: 'Hives (urticaria)', url: `${NHS}hives/`, looks: ['welts'], boost: { duration: ['days', 'recurring'], other: ['itchy'] },
    blurb: 'Itchy raised welts that move around and usually fade within a day. Often an allergic reaction, but the cause is not always found.' },
  { name: 'Insect bites', url: `${NHS}insect-bites-and-stings/`, looks: ['bumps', 'welts', 'swollen'], boost: { where: ['limbs'], other: ['itchy'] },
    blurb: 'Small itchy red bumps, often in groups on uncovered skin.' },
  { name: 'Eczema (atopic dermatitis)', url: `${NHS}atopic-eczema/`, looks: ['dry'], boost: { where: ['folds', 'limbs', 'hands'], duration: ['recurring', 'long'], other: ['itchy'] },
    blurb: 'Dry, itchy, sore skin that flares up and settles, often in the creases of elbows and knees.' },
  { name: 'Psoriasis', url: `${NHS}psoriasis/`, looks: ['dry'], boost: { where: ['limbs', 'face', 'body'], duration: ['long', 'recurring'] },
    blurb: 'Raised, scaly patches, often on elbows, knees, scalp and lower back. They can look pink, purple or dark brown depending on skin colour.' },
  { name: 'Contact dermatitis', url: `${NHS}contact-dermatitis/`, looks: ['dry', 'blisters', 'flush', 'bumps'], boost: { other: ['contact'], where: ['hands', 'face'] },
    blurb: 'An itchy or burning rash where the skin touched something irritating, or something you are allergic to.' },
  { name: 'Ringworm (fungal infection)', url: `${NHS}ringworm/`, looks: ['ring', 'dry'], boost: { other: ['itchy', 'spreading'] },
    blurb: 'A ring-shaped, scaly, itchy patch caused by a fungus. Antifungal cream from a pharmacist usually clears it.' },
  { name: 'Pityriasis versicolor', url: `${NHS}pityriasis-versicolor/`, looks: ['pale'], boost: { where: ['body'] },
    blurb: 'A common fungal infection causing patches lighter or darker than the skin around them, often on the chest and back.' },
  { name: 'Vitiligo', url: `${NHS}vitiligo/`, looks: ['pale'], boost: { where: ['face', 'hands'], duration: ['long'] },
    blurb: 'Patches of skin lose their colour and turn white. It is not contagious.' },
  { name: 'Acne', url: `${NHS}acne/`, looks: ['bumps'], boost: { where: ['face', 'body'], duration: ['long', 'recurring'] },
    blurb: 'Spots, blackheads and sometimes deeper painful lumps on the face, chest or back.' },
  { name: 'Scabies', url: `${NHS}scabies/`, looks: ['bumps'], boost: { other: ['night', 'household'], where: ['hands', 'widespread'] },
    blurb: 'Tiny mites cause intense itching that is worse at night, often starting between the fingers.' },
  { name: 'Shingles', url: `${NHS}shingles/`, looks: ['blisters'], boost: { other: ['band', 'painful'] },
    blurb: 'A painful blistering rash in a band on one side of the body or face.' },
  { name: 'Cold sores', url: `${NHS}cold-sores/`, looks: ['blisters', 'crust'], boost: { where: ['face'] },
    blurb: 'Small blisters on or around the lips that crust over and heal in about 10 days.' },
  { name: 'Chickenpox', url: `${NHS}chickenpox/`, looks: ['blisters', 'bumps'], boost: { where: ['widespread'], other: ['fever'] },
    blurb: 'Itchy spots all over that turn into blisters and then scabs, often with a fever. Most common in children.' },
  { name: 'Impetigo', url: `${NHS}impetigo/`, looks: ['crust', 'blisters'], boost: { where: ['face'], other: ['spreading'] },
    blurb: 'A contagious skin infection: sores burst and leave golden-brown crusts, often around the nose and mouth.' },
  { name: 'Cellulitis', url: `${NHS}cellulitis/`, looks: ['swollen'], boost: { warning: ['hot'], other: ['painful', 'spreading', 'fever'] }, priority: true,
    blurb: 'A skin infection that makes an area painful, hot and swollen. It needs antibiotics.' },
  { name: 'Rosacea', url: `${NHS}rosacea/`, looks: ['flush', 'bumps'], boost: { where: ['face'], duration: ['long', 'recurring'] },
    blurb: 'Redness and flushing on the cheeks, nose and forehead, sometimes with small spots.' },
  { name: 'Non-melanoma skin cancer', url: `${NHS}non-melanoma-skin-cancer/`, looks: ['sore'], boost: { duration: ['long'], where: ['face'] }, priority: true,
    blurb: 'Often looks like a sore, lump or scaly patch that does not heal. Very treatable, especially when found early.' },
  { name: 'Reaction to a medicine', url: `${NHS}allergies/`, looks: ['bumps', 'welts', 'blisters', 'dry', 'flush', 'swollen', 'other'], boost: { other: ['medicine', 'medicine'], where: ['widespread'] },
    blurb: 'Some medicines cause a rash, usually within days of starting them. The person who prescribed it can advise.' },
  { name: 'Warts', url: `${NHS}warts-and-verrucas/`, looks: ['sore', 'bumps'], boost: { where: ['hands'], duration: ['long'] },
    blurb: 'Small rough lumps, common on hands and feet. Usually harmless and often go away on their own.' },
];

function has(a: Answers, question: string, option: string): boolean {
  return a[question]?.includes(option) ?? false;
}

/** The questions to ask, in order, given the answers so far. */
export function questionsFor(a: Answers): Question[] {
  return QUESTIONS.filter((q) => !q.when || q.when(a));
}

/** True when an answer to the warning-sign question means stop and get emergency help. */
export function isEmergency(a: Answers): boolean {
  return ['breathing', 'glass', 'peeling', 'sepsis'].some((id) => has(a, 'warning', id));
}

const ORDER: Level[] = ['selfcare', 'soon', 'today', 'emergency'];

export function evaluate(a: Answers): Result {
  const found: { level: Level; reason: Link }[] = [];
  const flag = (level: Level, text: string, url?: string) => found.push({ level, reason: { text, url } });
  const look = a.look?.[0];
  const other = (id: string) => has(a, 'other', id);

  if (has(a, 'warning', 'breathing')) flag('emergency', 'Swelling of the face or throat, or trouble breathing, can be a severe allergic reaction (anaphylaxis).', `${NHS}anaphylaxis/`);
  if (has(a, 'warning', 'glass')) flag('emergency', 'A rash that does not fade under a glass, with feeling unwell, can be a sign of meningitis or sepsis.', `${NHS}meningitis/`);
  if (has(a, 'warning', 'peeling')) flag('emergency', 'Widespread blistering or peeling, or sores in the mouth, eyes or genitals, can be a severe skin reaction that needs hospital care.');
  if (has(a, 'warning', 'sepsis')) flag('emergency', 'These can be signs of sepsis, which needs emergency treatment.', `${NHS}sepsis/`);
  if (has(a, 'warning', 'hot') || (look === 'swollen' && (other('painful') || other('spreading')))) {
    flag('today', 'Painful, hot, swollen skin can be cellulitis, an infection that needs antibiotics soon. Get emergency help if you also feel very unwell.', `${NHS}cellulitis/`);
  }
  if (other('band')) flag('today', 'A painful rash in a band on one side can be shingles. Medicine works best if started within 3 days of the rash appearing.', `${NHS}shingles/`);
  if (other('fever')) flag('today', 'A rash together with a fever or feeling unwell should be checked today.');
  if (other('medicine')) {
    const severe = look === 'blisters' || has(a, 'where', 'widespread');
    flag(severe ? 'today' : 'soon', 'A rash that started after a new medicine should be checked. Do not stop a prescribed medicine without advice; contact whoever prescribed it.');
  }
  if (look === 'mole' && (a.mole ?? []).some((id) => id !== NONE)) {
    flag('soon', 'A mole with any of these signs should be checked by a doctor for skin cancer. Most turn out to be harmless, but finding melanoma early makes it easier to treat.', `${NHS}melanoma-skin-cancer/`);
  }
  if (look === 'sore' && has(a, 'duration', 'long')) {
    flag('soon', 'A growth or sore that hurts, itches, bleeds or crusts for more than 4 weeks should be checked for skin cancer.', `${NHS}non-melanoma-skin-cancer/`);
  }
  if (look === 'crust') flag('soon', 'Crusty, golden-brown sores can be impetigo, which spreads easily and may need antibiotic cream. See a pharmacist or doctor in the next few days.', `${NHS}impetigo/`);
  if (other('household')) flag('soon', 'Itching shared with people you live with can be scabies. Everyone needs treating at the same time; a pharmacist can help.', `${NHS}scabies/`);
  if (has(a, 'duration', 'long') && look !== 'mole' && look !== 'sore') flag('soon', 'A skin problem that has lasted more than 4 weeks is worth showing to a doctor.');

  let level: Level = 'selfcare';
  for (const f of found) if (ORDER.indexOf(f.level) > ORDER.indexOf(level)) level = f.level;
  const reasons = found
    .sort((p, q) => ORDER.indexOf(q.level) - ORDER.indexOf(p.level))
    .map((f) => f.reason);
  if (look === 'mole' && !reasons.length) {
    reasons.push({ text: 'No warning signs from your answers. Take a photo and compare it each month; see a doctor if it changes.', url: `${NHS}moles/` });
  }
  if (look === 'sore' && !has(a, 'duration', 'long')) {
    reasons.push({ text: 'If it has not healed within 4 weeks, see a doctor.', url: `${NHS}non-melanoma-skin-cancer/` });
  }
  return { level, reasons, causes: level === 'emergency' ? [] : rankCauses(a) };
}

/** Common causes of skin like this, best match first (at most three). */
function rankCauses(a: Answers): Cause[] {
  const look = a.look?.[0];
  if (!look) return [];
  if (look === 'mole') return [{ name: 'Moles', url: `${NHS}moles/`, blurb: 'Most moles are harmless. Changes in size, shape or colour are the main reason to get one checked.' }];
  return CAUSES.filter((c) => c.looks.includes(look))
    // A medicine reaction is only worth listing when one was mentioned.
    .filter((c) => c.name !== 'Reaction to a medicine' || has(a, 'other', 'medicine'))
    .map((c) => {
      let score = c.priority ? 100 : 0;
      for (const [question, ids] of Object.entries(c.boost ?? {})) score += ids!.filter((id) => has(a, question, id)).length;
      return { c, score };
    })
    .sort((p, q) => q.score - p.score)
    .slice(0, 3)
    .map(({ c }) => ({ name: c.name, blurb: c.blurb, url: c.url }));
}
