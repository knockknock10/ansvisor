import { generateObject } from 'ai';
import { z } from 'zod';
import { resolveModel } from './ai-provider.js';

export const BUSINESS_MODELS = Object.freeze([
  'saas',
  'e_commerce',
  'marketplace',
  'agency',
  'local_business',
  'publisher',
  'nonprofit',
  'other',
]);

export const CONVERSION_GOALS = Object.freeze([
  'sign_up',
  'demo_request',
  'purchase',
  'lead_form',
  'contact',
  'subscribe',
  'book_appointment',
  'other',
]);

export const BRAND_PROFILE_FIELDS = Object.freeze([
  'productsAndServices',
  'targetCustomers',
  'businessModel',
  'conversionGoals',
]);

export const brandProfileDraftSchema = z.object({
  productsAndServices: z.string().max(2400),
  targetCustomers: z.string().max(1600),
  businessModel: z.enum([...BUSINESS_MODELS, 'unknown']),
  conversionGoals: z.array(z.enum(CONVERSION_GOALS)).max(CONVERSION_GOALS.length),
});

const MAX_SITE_PAGES = 40;
const MAX_FIELD_CHARS = 300;

function cleanText(value, limit = MAX_FIELD_CHARS) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function hostname(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const input = value.trim();
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  } catch {
    return null;
  }
}

function belongsToBrandHost(candidate, allowedHosts) {
  const host = hostname(candidate);
  return Boolean(
    host && allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)),
  );
}

/**
 * Build a bounded, safe website context from the inventory the system already
 * stores. No page bodies are fetched and no arbitrary URLs are requested here.
 * The homepage is always supplied separately, even when the inventory is empty.
 */
export function buildBrandProfileSiteContext(domains, sitePages) {
  const domainRows = Array.isArray(domains) ? domains : [];
  const allowedHosts = domainRows.map((row) => hostname(row?.domain)).filter(Boolean);
  const primary = domainRows.find((row) => row?.is_primary) ?? domainRows[0];
  const primaryHost = hostname(primary?.domain);

  const pageByUrl = new Map();
  for (const row of Array.isArray(sitePages) ? sitePages : []) {
    if (typeof row?.url !== 'string' || !belongsToBrandHost(row.url, allowedHosts)) continue;

    let parsed;
    try {
      parsed = new URL(row.url);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) continue;
    const url = parsed.origin + (parsed.pathname.replace(/\/+$/, '') || '');
    if (!pageByUrl.has(url)) {
      pageByUrl.set(url, {
        url,
        title: cleanText(row.title),
        description: cleanText(row.description),
        h1: cleanText(row.h1),
        aiCitations: Math.max(0, Number(row.ai_citations) || 0),
        gaSessions: Math.max(0, Number(row.ga_sessions) || 0),
        lastModified: cleanText(row.lastmod, 40),
      });
    }
  }

  const pages = [...pageByUrl.values()].sort((a, b) => {
    const aHome = new URL(a.url).pathname === '' || new URL(a.url).pathname === '/';
    const bHome = new URL(b.url).pathname === '' || new URL(b.url).pathname === '/';
    return (
      Number(bHome) - Number(aHome) ||
      b.aiCitations - a.aiCitations ||
      b.gaSessions - a.gaSessions ||
      a.url.localeCompare(b.url)
    );
  });
  const homepage = pages.find((page) => {
    const path = new URL(page.url).pathname;
    return path === '' || path === '/';
  });

  return {
    homepage: homepage ?? {
      url: primaryHost ? `https://${primaryHost}/` : null,
      title: '',
      description: '',
      h1: '',
      aiCitations: 0,
      gaSessions: 0,
      lastModified: '',
    },
    pages: pages.slice(0, MAX_SITE_PAGES),
  };
}

export function missingBrandProfileFields(brand) {
  const missing = [];
  if (!cleanText(brand?.products_and_services, 2400)) missing.push('productsAndServices');
  if (!cleanText(brand?.target_customers, 1600)) missing.push('targetCustomers');
  if (!BUSINESS_MODELS.includes(brand?.business_model)) missing.push('businessModel');
  if (!Array.isArray(brand?.conversion_goals) || brand.conversion_goals.length === 0) {
    missing.push('conversionGoals');
  }
  return missing;
}

/**
 * Drafts missing fields only. Callers deliberately decide which fields are
 * still blank, and only those fields may be returned to the form for preview.
 */
export async function draftBrandProfile({ brand, domains, sitePages, missingFields }) {
  const siteContext = buildBrandProfileSiteContext(domains, sitePages);
  const model = resolveModel(process.env.BRAND_PROFILE_MODEL || process.env.PROMPT_SUGGESTION_MODEL);

  const { object } = await generateObject({
    model,
    schema: brandProfileDraftSchema,
    system: [
      'You are a careful business analyst drafting a brand profile from the brand website.',
      'Use only evidence in the supplied homepage metadata and page inventory.',
      'Do not infer a business model, customer group, service, or conversion goal without evidence.',
      'Use an empty string for unsupported text fields, "unknown" for an unsupported business model, and [] when conversion goals are not evident.',
      'Products and services should be a concise list of what the business sells or provides.',
      'Target customers should describe the audiences the website clearly serves.',
      'Choose one business model from the allowed values; use "unknown" if evidence is insufficient.',
      'Choose only conversion goals supported by the website. Do not treat generic contact details alone as proof of purchase or sign-up goals.',
      'Existing profile values and the missing_fields list are supplied. Draft useful values for missing fields only; existing values must not be changed.',
    ].join('\n'),
    prompt: JSON.stringify({
      brand: {
        name: cleanText(brand.name, 200),
        industry: cleanText(brand.industry, 200),
        description: cleanText(brand.description, 1600),
        language: cleanText(brand.language, 40),
        domains: (domains ?? []).map((row) => cleanText(row.domain, 250)).filter(Boolean),
      },
      currentProfile: {
        productsAndServices: cleanText(brand.products_and_services, 2400),
        targetCustomers: cleanText(brand.target_customers, 1600),
        businessModel: brand.business_model ?? null,
        conversionGoals: Array.isArray(brand.conversion_goals) ? brand.conversion_goals : [],
      },
      missingFields,
      website: siteContext,
    }),
  });

  return object;
}

export function pickMissingDraftFields(draft, missingFields) {
  const allowed = new Set(missingFields);
  const profile = {};

  if (allowed.has('productsAndServices')) {
    const value = cleanText(draft?.productsAndServices, 2400);
    if (value) profile.productsAndServices = value;
  }
  if (allowed.has('targetCustomers')) {
    const value = cleanText(draft?.targetCustomers, 1600);
    if (value) profile.targetCustomers = value;
  }
  if (allowed.has('businessModel')) {
    if (BUSINESS_MODELS.includes(draft?.businessModel)) {
      profile.businessModel = draft.businessModel;
    }
  }
  if (allowed.has('conversionGoals')) {
    const goals = Array.isArray(draft?.conversionGoals) ? draft.conversionGoals : [];
    profile.conversionGoals = [...new Set(goals.filter((goal) => CONVERSION_GOALS.includes(goal)))]
      .slice(0, CONVERSION_GOALS.length);
  }

  return profile;
}
