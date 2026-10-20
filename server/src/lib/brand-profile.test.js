import { describe, expect, it, vi } from 'vitest';
import {
  BUSINESS_MODELS,
  CONVERSION_GOALS,
  buildBrandProfileSiteContext,
  missingBrandProfileFields,
  pickMissingDraftFields,
} from './brand-profile.js';

describe('missingBrandProfileFields', () => {
  it('returns only blank or invalid profile values', () => {
    expect(
      missingBrandProfileFields({
        products_and_services: '  ',
        target_customers: 'Finance teams',
        business_model: 'saas',
        conversion_goals: ['demo_request'],
      }),
    ).toEqual(['productsAndServices']);
  });

  it('treats an empty goal list as missing, but retains valid user fields', () => {
    expect(
      missingBrandProfileFields({
        products_and_services: 'Accounting software',
        target_customers: 'Small business owners',
        business_model: 'e_commerce',
        conversion_goals: [],
      }),
    ).toEqual(['conversionGoals']);
  });

  it('treats unsupported stored business-model values as missing', () => {
    expect(
      missingBrandProfileFields({
        products_and_services: 'Service',
        target_customers: 'Teams',
        business_model: 'something-new',
        conversion_goals: ['contact'],
      }),
    ).toEqual(['businessModel']);
  });
});

describe('buildBrandProfileSiteContext', () => {
  it('prioritizes the homepage and then pages with the most useful evidence', () => {
    const context = buildBrandProfileSiteContext(
      [{ domain: 'acme.example', is_primary: true }],
      [
        { url: 'https://acme.example/pricing', title: 'Pricing', ai_citations: 1, ga_sessions: 100 },
        { url: 'https://acme.example/', title: 'Acme', description: 'Tools for teams', h1: 'Work better' },
        { url: 'https://acme.example/product', title: 'Product', ai_citations: 20, ga_sessions: 4 },
      ],
    );

    expect(context.homepage).toMatchObject({
      url: 'https://acme.example',
      title: 'Acme',
      description: 'Tools for teams',
      h1: 'Work better',
    });
    expect(context.pages[0].url).toBe('https://acme.example');
    expect(context.pages[1].url).toBe('https://acme.example/product');
  });

  it('ignores malformed pages and hosts outside the brand domains', () => {
    const context = buildBrandProfileSiteContext(
      [{ domain: 'acme.example', is_primary: true }],
      [
        { url: 'https://notacme.example/steal', title: 'Untrusted' },
        { url: 'javascript:alert(1)', title: 'Unsafe' },
        { url: '::::', title: 'Broken' },
        { url: 'https://shop.acme.example/catalog', title: 'Shop' },
      ],
    );

    expect(context.pages.map((page) => page.title)).toEqual(['Shop']);
    expect(context.homepage.url).toBe('https://acme.example/');
  });

  it('bounds page context to 40 entries and clips each field', () => {
    const pages = Array.from({ length: 60 }, (_, i) => ({
      url: `https://acme.example/category/${i}`,
      title: 'x'.repeat(400),
      ai_citations: i,
    }));
    const context = buildBrandProfileSiteContext([{ domain: 'acme.example', is_primary: true }], pages);
    expect(context.pages).toHaveLength(40);
    expect(context.pages[0].title).toHaveLength(300);
  });

  it('supports an empty inventory without inventing a homepage response', () => {
    const context = buildBrandProfileSiteContext([], []);
    expect(context.homepage).toEqual({
      url: null,
      title: '',
      description: '',
      h1: '',
      aiCitations: 0,
      gaSessions: 0,
      lastModified: '',
    });
    expect(context.pages).toEqual([]);
  });
});

describe('pickMissingDraftFields', () => {
  it('returns only the fields that were missing before generation', () => {
    expect(
      pickMissingDraftFields(
        {
          productsAndServices: 'new services',
          targetCustomers: 'new customers',
          businessModel: 'saas',
          conversionGoals: ['purchase', 'purchase', 'unknown'],
        },
        ['productsAndServices', 'conversionGoals'],
      ),
    ).toEqual({
      productsAndServices: 'new services',
      conversionGoals: ['purchase'],
    });
  });

  it('does not return empty text, an unknown model, or unsupported goals', () => {
    expect(
      pickMissingDraftFields(
        {
          productsAndServices: ' ',
          targetCustomers: 'Customers',
          businessModel: 'unknown',
          conversionGoals: ['fake'],
        },
        ['productsAndServices', 'targetCustomers', 'businessModel', 'conversionGoals'],
      ),
    ).toEqual({ conversionGoals: [] });
  });
});
