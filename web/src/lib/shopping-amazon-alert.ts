export const AMAZON_SHARE_DROP_MIN_CLASSIFIED_CARDS = 30;
export const AMAZON_SHARE_DROP_WEEKS = 4;
export const AMAZON_SHARE_DROP_RATIO = 0.5;
export const AMAZON_SHARE_DROP_MIN_POINTS = 0.1;

export interface WeeklyAmazonShare {
  /** Monday of the UTC week, formatted YYYY-MM-DD. */
  weekStart: string;
  /** Fraction of classified own-product cards that went to Amazon (0..1). */
  amazonShare: number;
  classifiedCards: number;
}

export interface AmazonShareDropAlert {
  baselineShare: number;
  currentShare: number;
  baselineClassifiedCards: number;
  currentClassifiedCards: number;
  currentWeekStart: string;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Alert on a sharp, well-sampled fall in the latest week's Amazon share.
 * The latest week must have 30 classified cards, as must each of the four
 * baseline weeks; otherwise a small sample can manufacture a false alert.
 */
export function detectAmazonShareDrop(
  weeks: WeeklyAmazonShare[],
): AmazonShareDropAlert | null {
  const ordered = [...weeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  if (ordered.length < AMAZON_SHARE_DROP_WEEKS + 1) return null;

  const baselineWeeks = ordered.slice(-(AMAZON_SHARE_DROP_WEEKS + 1), -1);
  const current = ordered.at(-1)!;
  const enoughData = (week: WeeklyAmazonShare) =>
    Number.isFinite(week.amazonShare) &&
    week.amazonShare >= 0 &&
    week.amazonShare <= 1 &&
    week.classifiedCards >= AMAZON_SHARE_DROP_MIN_CLASSIFIED_CARDS;

  if (!enoughData(current) || !baselineWeeks.every(enoughData)) return null;

  const baselineShare = median(baselineWeeks.map((week) => week.amazonShare));
  const currentShare = current.amazonShare;
  const hasHalved = currentShare < baselineShare * AMAZON_SHARE_DROP_RATIO;
  const hasDroppedEnough = baselineShare - currentShare >= AMAZON_SHARE_DROP_MIN_POINTS;
  if (!hasHalved || !hasDroppedEnough) return null;

  return {
    baselineShare,
    currentShare,
    baselineClassifiedCards: baselineWeeks.reduce((sum, week) => sum + week.classifiedCards, 0),
    currentClassifiedCards: current.classifiedCards,
    currentWeekStart: current.weekStart,
  };
}

const AMAZON_HOSTS = [
  'amazon.com',
  'amazon.ca',
  'amazon.com.mx',
  'amazon.com.br',
  'amazon.co.uk',
  'amazon.de',
  'amazon.fr',
  'amazon.it',
  'amazon.es',
  'amazon.nl',
  'amazon.se',
  'amazon.pl',
  'amazon.be',
  'amazon.com.be',
  'amazon.ie',
  'amazon.at',
  'amazon.ch',
  'amazon.com.au',
  'amazon.co.jp',
  'amazon.in',
  'amazon.sg',
  'amazon.ae',
  'amazon.sa',
  'amazon.com.tr',
  'amazon.eg',
  'amazon.co.za',
  'amzn.to',
  'amzn.eu',
  'a.co',
] as const;

/**
 * Parse a merchant URL/domain without following it. Invalid/empty destinations
 * are unclassified, so they never enter the denominator. Short Amazon links
 * count as Amazon by their host; the client never makes network requests.
 */
export function merchantHost(
  merchantUrl: string | null | undefined,
  merchantDomain?: string | null,
): string | null {
  const raw = (merchantUrl || merchantDomain || '').trim();
  if (!raw) return null;

  let parsed: URL;
  try {
    if (/^[a-z][a-z\d+.-]*:/i.test(raw)) {
      parsed = new URL(raw);
    } else if (raw.startsWith('//')) {
      parsed = new URL(`https:${raw}`);
    } else {
      parsed = new URL(`https://${raw}`);
    }
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  return host && host.includes('.') ? host : null;
}

export function isAmazonHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  return AMAZON_HOSTS.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

export function startOfUtcWeek(date: Date): string {
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const daysSinceMonday = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
  return monday.toISOString().slice(0, 10);
}
