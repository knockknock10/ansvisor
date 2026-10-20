import { describe, expect, it } from 'vitest';
import {
  detectAmazonShareDrop,
  isAmazonHost,
  merchantHost,
  startOfUtcWeek,
  type WeeklyAmazonShare,
} from './shopping-amazon-alert';

function series(shares: number[], counts: number[] = [40, 42, 45, 38, 40]): WeeklyAmazonShare[] {
  return shares.map((amazonShare, index) => ({
    weekStart: (() => {
      const date = new Date('2026-09-21T00:00:00.000Z');
      date.setUTCDate(date.getUTCDate() + index * 7);
      return date.toISOString().slice(0, 10);
    })(),
    amazonShare,
    classifiedCards: counts[index],
  }));
}

describe('detectAmazonShareDrop', () => {
  it('alerts when Amazon share more than halves and falls at least ten points', () => {
    const alert = detectAmazonShareDrop(series([0.31, 0.28, 0.33, 0.30, 0.04]));
    expect(alert).toMatchObject({
      baselineShare: 0.305,
      currentShare: 0.04,
      baselineClassifiedCards: 165,
      currentClassifiedCards: 40,
      currentWeekStart: '2026-10-19',
    });
  });

  it('uses the median of the previous four weeks, not their mean', () => {
    const alert = detectAmazonShareDrop(series([0.31, 0.80, 0.33, 0.30, 0.04]));
    expect(alert?.baselineShare).toBe(0.32);
  });

  it('does not alert for normal week-to-week noise', () => {
    expect(detectAmazonShareDrop(series([0.31, 0.28, 0.33, 0.30, 0.26]))).toBeNull();
  });

  it('requires both a halving and a drop of at least ten percentage points', () => {
    expect(detectAmazonShareDrop(series([0.20, 0.20, 0.20, 0.20, 0.101]))).toBeNull();
    expect(detectAmazonShareDrop(series([0.20, 0.20, 0.20, 0.20, 0.10]))).toBeNull();
    expect(detectAmazonShareDrop(series([0.30, 0.30, 0.30, 0.30, 0.15]))).toBeNull();
  });

  it('does not alert when the current week has fewer than 30 classified cards', () => {
    expect(
      detectAmazonShareDrop(series([0.31, 0.28, 0.33, 0.30, 0.04], [40, 42, 45, 38, 29])),
    ).toBeNull();
  });

  it('does not alert when any baseline week has fewer than 30 classified cards', () => {
    expect(
      detectAmazonShareDrop(series([0.31, 0.28, 0.33, 0.30, 0.04], [40, 42, 29, 38, 40])),
    ).toBeNull();
  });

  it('does not alert with fewer than four baseline weeks', () => {
    expect(detectAmazonShareDrop(series([0.31, 0.30, 0.04]).slice(-3))).toBeNull();
  });

  it('rejects invalid share values rather than treating them as an alert', () => {
    const weeks = series([0.31, 0.28, 0.33, 0.30, 0.04]);
    weeks[4].amazonShare = 1.1;
    expect(detectAmazonShareDrop(weeks)).toBeNull();
  });
});

describe('merchantHost and isAmazonHost', () => {
  it.each([
    ['https://www.amazon.com/dp/B000123456?tag=partner', 'amazon.com'],
    ['amazon.com.be/dp/B000123456', 'amazon.com.be'],
    ['https://amazon.co.za/dp/B000123456', 'amazon.co.za'],
    ['//amzn.to/abc123', 'amzn.to'],
  ])('extracts the merchant host from %s', (url, expected) => {
    expect(merchantHost(url)).toBe(expected);
  });

  it.each(['amazon.com', 'shop.amazon.co.uk', 'amazon.com.be', 'amzn.to', 'amzn.eu', 'a.co'])(
    'recognizes Amazon host %s',
    (host) => expect(isAmazonHost(host)).toBe(true),
  );

  it('does not misclassify lookalike hosts', () => {
    expect(isAmazonHost('notamazon.com')).toBe(false);
    expect(isAmazonHost('amazon.com.attacker.example')).toBe(false);
  });

  it.each([null, undefined, '', 'javascript:alert(1)', 'https://', '/dp/B000123456'])(
    'leaves empty or malformed merchant URLs unclassified: %s',
    (url) => expect(merchantHost(url)).toBeNull(),
  );

  it('falls back to a normalized merchant domain when the URL is unavailable', () => {
    expect(merchantHost(null, 'www.amazon.co.uk')).toBe('amazon.co.uk');
  });

  it('falls back to the merchant domain when the URL is malformed', () => {
    expect(merchantHost('not a valid URL %%', 'www.amazon.co.uk')).toBe('amazon.co.uk');
  });

  it('buckets dates by the Monday of their UTC week', () => {
    expect(startOfUtcWeek(new Date('2026-10-21T23:59:00.000Z'))).toBe('2026-10-19');
    expect(startOfUtcWeek(new Date('2026-10-25T23:59:00.000Z'))).toBe('2026-10-19');
    expect(startOfUtcWeek(new Date('2026-10-26T00:00:00.000Z'))).toBe('2026-10-26');
  });
});
