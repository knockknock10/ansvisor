import { describe, it, expect } from 'vitest';
import { regionToLocationCode, languageToCode, defaultLanguageForRegion } from './dataforseo-codes.js';

describe('dataforseo-codes', () => {
  describe('regionToLocationCode', () => {
    it('should map uppercase region codes', () => {
      expect(regionToLocationCode('US')).toBe(2840);
      expect(regionToLocationCode('GB')).toBe(2826);
      expect(regionToLocationCode('DE')).toBe(2276);
      expect(regionToLocationCode('IE')).toBe(2372);
      expect(regionToLocationCode('PL')).toBe(2616);
    });

    it('should be case-insensitive', () => {
      expect(regionToLocationCode('us')).toBe(2840);
      expect(regionToLocationCode('gb')).toBe(2826);
      expect(regionToLocationCode('De')).toBe(2276);
      expect(regionToLocationCode(' de ')).toBe(2276);
    });

    it('should return undefined for unknown regions', () => {
      expect(regionToLocationCode('XX')).toBeUndefined();
      expect(regionToLocationCode('Mars')).toBeUndefined();
    });

    it('should return undefined for null/undefined input', () => {
      expect(regionToLocationCode(null)).toBeUndefined();
      expect(regionToLocationCode(undefined)).toBeUndefined();
      expect(regionToLocationCode('')).toBeUndefined();
      expect(regionToLocationCode(42)).toBeUndefined();
    });
  });

  describe('languageToCode', () => {
    it('should map supported language codes', () => {
      expect(languageToCode('en')).toBe('en');
      expect(languageToCode('de')).toBe('de');
      expect(languageToCode('ja')).toBe('ja');
    });

    it('should be case-insensitive', () => {
      expect(languageToCode('EN')).toBe('en');
      expect(languageToCode('De')).toBe('de');
      expect(languageToCode('JA')).toBe('ja');
      expect(languageToCode('de-DE')).toBe('de');
      expect(languageToCode('pt_BR')).toBe('pt');
    });

    it('should return undefined for unsupported languages', () => {
      expect(languageToCode('zh')).toBeUndefined();
      expect(languageToCode('zh')).toBeUndefined();
    });

    it('should return undefined for null/undefined input', () => {
      expect(languageToCode(null)).toBeUndefined();
      expect(languageToCode(undefined)).toBeUndefined();
      expect(languageToCode('')).toBeUndefined();
      expect(languageToCode(42)).toBeUndefined();
    });
  });
});

describe('defaultLanguageForRegion', () => {
  it('selects a country default including US state codes', () => {
    expect(defaultLanguageForRegion('US-CA')).toBe('en');
    expect(defaultLanguageForRegion('DE')).toBe('de');
    expect(defaultLanguageForRegion('IE')).toBe('en');
    expect(defaultLanguageForRegion('PT')).toBe('pt');
  });

  it('returns undefined for an unknown region', () => {
    expect(defaultLanguageForRegion('XX')).toBeUndefined();
    expect(defaultLanguageForRegion(null)).toBeUndefined();
  });
});
