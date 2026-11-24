import {
  ArrowLeft,
  BadgeCheck,
  Bone,
  Brain,
  CalendarCheck,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Clock,
  Cpu,
  ExternalLink,
  FlipHorizontal2,
  Flashlight,
  Hand,
  HeartPulse,
  ImageUp,
  Info,
  LoaderCircle,
  PawPrint,
  PersonStanding,
  Pill,
  RefreshCw,
  Rotate3d,
  RotateCcw,
  ScanFace,
  ScanSearch,
  ShieldCheck,
  Siren,
  Stethoscope,
  SwitchCamera,
  Tags,
  ZoomIn,
  type IconNode,
} from 'lucide';

/** Lucide icons (ISC licence) used in the interface, by the names the markup uses. */
const ICONS = {
  'arrow-left': ArrowLeft,
  'badge-check': BadgeCheck,
  bone: Bone,
  brain: Brain,
  'calendar-check': CalendarCheck,
  camera: Camera,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  'chevron-up': ChevronUp,
  'circle-alert': CircleAlert,
  clock: Clock,
  cpu: Cpu,
  'external-link': ExternalLink,
  'flip-horizontal': FlipHorizontal2,
  flashlight: Flashlight,
  hand: Hand,
  'heart-pulse': HeartPulse,
  'image-up': ImageUp,
  info: Info,
  loader: LoaderCircle,
  'paw-print': PawPrint,
  'person-standing': PersonStanding,
  pill: Pill,
  'refresh-cw': RefreshCw,
  'rotate-3d': Rotate3d,
  'rotate-ccw': RotateCcw,
  'scan-face': ScanFace,
  'scan-search': ScanSearch,
  'shield-check': ShieldCheck,
  siren: Siren,
  stethoscope: Stethoscope,
  'switch-camera': SwitchCamera,
  tags: Tags,
  'zoom-in': ZoomIn,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

/** An icon as inline SVG markup, coloured by `currentColor`. */
export function icon(name: IconName, size = 20): string {
  const body = ICONS[name]
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`)
    .join('');
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Replaces `<i data-icon="name" data-size="20">` placeholders with inline SVG. */
export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('i[data-icon]').forEach((el) => {
    el.outerHTML = icon(el.dataset.icon as IconName, Number(el.dataset.size) || 20);
  });
}
