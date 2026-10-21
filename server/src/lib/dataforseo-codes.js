/**
 * Map our internal region / language codes to DataForSEO's numeric location_code
 * and ISO language code used by DataForSEO country-aware endpoints, including
 * Google Ads search volume and Google Shopping products.
 *
 * https://docs.dataforseo.com/v3/keywords_data/google_ads/locations/
 */

const REGION_TO_LOCATION_CODE = {
  US: 2840,
  GB: 2826,
  LI: 2438,
  AT: 2040,
  BE: 2056,
  BG: 2100,
  HR: 2191,
  CY: 2196,
  CZ: 2203,
  DK: 2208,
  EE: 2233,
  FI: 2246,
  GR: 2300,
  HU: 2348,
  IS: 2352,
  IE: 2372,
  LV: 2428,
  LT: 2440,
  LU: 2442,
  MT: 2470,
  NO: 2578,
  PL: 2616,
  PT: 2620,
  RO: 2642,
  SK: 2703,
  SI: 2705,
  CA: 2124,
  AU: 2036,
  DE: 2276,
  FR: 2250,
  IT: 2380,
  ES: 2724,
  NL: 2528,
  SE: 2752,
  CH: 2756,
  TR: 2792,
  JP: 2392,
  BR: 2076,
  IN: 2356,
  KR: 2410,
  MX: 2484,
  SG: 2702,
  AE: 2784,
};

const LANGUAGE_PASSTHROUGH = new Set([
  'en',
  'de',
  'fr',
  'es',
  'tr',
  'ja',
  'pt',
  'hi',
  'ko',
  'it',
  'nl',
  'sv',
  'ar',
  'bg',
  'hr',
  'cs',
  'da',
  'et',
  'fi',
  'el',
  'hu',
  'is',
  'lv',
  'lt',
  'no',
  'pl',
  'ro',
  'sk',
  'sl',
]);

/**
 * @param {string|null|undefined} region ISO 3166-1 alpha-2 (e.g. 'US', 'TR')
 * @returns {number|undefined} DataForSEO numeric location code, or undefined if no mapping
 */
export function regionToLocationCode(region) {
  if (typeof region !== 'string' || !region.trim()) return undefined;
  return REGION_TO_LOCATION_CODE[region.trim().toUpperCase()];
}

/**
 * @param {string|null|undefined} language ISO 639-1 (e.g. 'en', 'tr')
 * @returns {string|undefined} DataForSEO-compatible language code, or undefined
 */
export function languageToCode(language) {
  if (typeof language !== 'string' || !language.trim()) return undefined;
  // Brand settings may carry a BCP-47 tag (for example, "de-DE").
  const lower = language.trim().toLowerCase().split(/[-_]/)[0];
  return LANGUAGE_PASSTHROUGH.has(lower) ? lower : undefined;
}

/**
 * Best-effort language for a country when the brand has no usable language
 * configured. A brand's explicit language takes precedence in the caller.
 * Switzerland is German by default here; brands targeting French- or
 * Italian-speaking Switzerland should set their own language.
 *
 * @param {string|null|undefined} region ISO country or US state code
 * @returns {string|undefined} Supported two-letter language code
 */
export function defaultLanguageForRegion(region) {
  if (!region || typeof region !== 'string') return undefined;
  const country = region.trim().toUpperCase().split('-')[0];
  const defaults = {
    US: 'en',
    GB: 'en',
    CA: 'en',
    AU: 'en',
    AT: 'de',
    BE: 'fr',
    BG: 'bg',
    BR: 'pt',
    CH: 'de',
    HR: 'hr',
    CY: 'el',
    CZ: 'cs',
    DE: 'de',
    DK: 'da',
    EE: 'et',
    ES: 'es',
    FI: 'fi',
    FR: 'fr',
    GR: 'el',
    HU: 'hu',
    IE: 'en',
    IN: 'en',
    IS: 'is',
    IT: 'it',
    JP: 'ja',
    KR: 'ko',
    LT: 'lt',
    LU: 'fr',
    LI: 'de',
    LV: 'lv',
    MT: 'en',
    MX: 'es',
    NL: 'nl',
    NO: 'no',
    PL: 'pl',
    PT: 'pt',
    RO: 'ro',
    SE: 'sv',
    SG: 'en',
    SI: 'sl',
    SK: 'sk',
    TR: 'tr',
    AE: 'ar',
  };
  return defaults[country];
}
