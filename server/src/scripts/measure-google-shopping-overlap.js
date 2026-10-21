#!/usr/bin/env node
/**
 * Compare real ChatGPT Shopping cards with DataForSEO Google Shopping results.
 *
 * Run from server/:
 *   node src/scripts/measure-google-shopping-overlap.js --input ./shopping-overlap-input.json
 *   node src/scripts/measure-google-shopping-overlap.js --input ./shopping-overlap-input.json --output ./google-shopping-overlap-DE.md
 *
 * Input JSON:
 * {
 *   "country": "DE",
 *   "language": "de",
 *   "prompts": [
 *     { "query": "best mirrorless camera", "chatgptProducts": [
 *       { "title": "...", "merchant": "...", "gtin": "optional" }
 *     ]}
 *   ]
 * }
 *
 * Use actual ChatGPT Shopping cards captured for each query. This script makes
 * paid DataForSEO task submissions and reports the request cost returned by
 * the provider. It never fabricates ChatGPT observations or missing products.
 */
import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  defaultLanguageForRegion,
  languageToCode,
  regionToLocationCode,
} from '../lib/dataforseo-codes.js';
import {
  extractGoogleShoppingProducts,
  hasGoogleShoppingCredentials,
  submitGoogleShoppingTasks,
  waitForGoogleShoppingTask,
} from '../lib/google-shopping.js';

const EUROPEAN_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR',
  'GB', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT',
  'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
]);

function getArguments(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--input') args.input = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
    else if (argv[index] === '--help' || argv[index] === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return args;
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replace(/\\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\\p{L}\\p{N}]+/gu, ' ')
    .trim()
    .replace(/\\s+/g, ' ');
}

function gtinFor(product) {
  const value = [product?.gtin, product?.gtin13, product?.ean, product?.upc, product?.isbn]
    .find((item) => typeof item === 'string' || typeof item === 'number');
  return value == null ? '' : String(value).replace(/\\D/g, '');
}

function merchantFor(product) {
  const explicitDomain = product?.merchant_domain ?? product?.domain ??
    product?.url ?? product?.offers?.[0]?.url;
  const candidate = explicitDomain ?? product?.merchant ?? product?.merchants ?? product?.seller;
  const value = Array.isArray(candidate) ? candidate.find((entry) => typeof entry === 'string') : candidate;
  if (typeof value !== 'string' || !value.trim()) return '';
  // Bare seller names such as "MediaMarkt" are names, not hostnames.
  // Treat a value as a domain only if it has URL syntax or a dotted host.
  if (!value.includes('://') && !value.includes('.') && !value.includes('/')) {
    return normalizeText(value);
  }
  try {
    const url = value.includes('://') ? value : `https://${value}`;
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return normalizeText(value);
  }
}

function titleFor(product) {
  return normalizeText(product?.title ?? product?.name ?? product?.product_title);
}

function productIdentity(product) {
  const gtin = gtinFor(product);
  if (gtin) return `gtin:${gtin}`;
  const title = titleFor(product);
  if (!title) return null;
  return `title:${title}|merchant:${merchantFor(product) || 'unknown'}`;
}

function dedupeProducts(products) {
  const seen = new Set();
  return (Array.isArray(products) ? products : []).filter((product) => {
    const identity = productIdentity(product);
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function matchProducts(chatgptProducts, googleProducts) {
  const left = dedupeProducts(chatgptProducts);
  const right = dedupeProducts(googleProducts);
  const consumedGoogle = new Set();
  const matches = [];

  for (const chatgpt of left) {
    const chatGtin = gtinFor(chatgpt);
    const chatTitle = titleFor(chatgpt);
    const chatMerchant = merchantFor(chatgpt);
    const matchIndex = right.findIndex((google, index) => {
      if (consumedGoogle.has(index)) return false;
      const googleGtin = gtinFor(google);
      if (chatGtin && googleGtin) return chatGtin === googleGtin;
      const googleTitle = titleFor(google);
      const googleMerchant = merchantFor(google);
      if (!chatTitle || chatTitle !== googleTitle) return false;
      // Prefer exact normalized merchant identity. When one side doesn't
      // expose any merchant field, title-only matching is a documented fallback.
      return chatMerchant && googleMerchant ? chatMerchant === googleMerchant : true;
    });

    if (matchIndex >= 0) {
      consumedGoogle.add(matchIndex);
      matches.push({ chatgpt, google: right[matchIndex] });
    }
  }

  return { chatgptProducts: left, googleProducts: right, matches };
}

function escapeMarkdown(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function percent(numerator, denominator) {
  return denominator > 0 ? `${((numerator / denominator) * 100).toFixed(1)}%` : 'N/A';
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
}

function buildReport({ country, language, prompts, measurements, cost }) {
  const succeeded = measurements.filter((item) => !item.error);
  const chatgptCount = measurements.reduce((sum, item) => sum + item.chatgptProducts.length, 0);
  const matchedCount = measurements.reduce((sum, item) => sum + item.matches.length, 0);
  const totalGoogleProducts = measurements.reduce((sum, item) => sum + item.googleProducts.length, 0);
  const costText = cost == null ? 'not reported by API' : `$${cost.toFixed(4)} USD`;

  const lines = [
    `## Google Shopping overlap measurement — ${country} (${language})`,
    '',
    `- Measurement date: ${new Date().toISOString()}`,
    `- Prompts supplied: ${prompts.length} (minimum required: 20)`,
    `- Successful Google Shopping lookups: ${succeeded.length}/${measurements.length}`,
    `- ChatGPT products compared: ${chatgptCount}`,
    `- Google Shopping products collected: ${totalGoogleProducts}`,
    `- Matched product pairs: ${matchedCount}`,
    `- ChatGPT product coverage in Google Shopping: ${percent(matchedCount, chatgptCount)}`,
    `- Queries with at least one match: ${succeeded.filter((item) => item.matches.length > 0).length}/${succeeded.length || 0}`,
    `- Query-level hit rate: ${percent(succeeded.filter((item) => item.matches.length > 0).length, succeeded.length)}`,
    `- DataForSEO task submission cost: ${costText}`,
    '',
    '| # | Prompt | ChatGPT products | Google Shopping products | Matches | ChatGPT card overlap | Status |',
    '|---:|---|---:|---:|---:|---:|---|',
  ];

  for (const item of measurements) {
    lines.push(
      `| ${item.index} | ${escapeMarkdown(item.query)} | ${item.chatgptProducts.length} | ${item.googleProducts.length} | ${item.matches.length} | ${percent(item.matches.length, item.chatgptProducts.length)} | ${item.error ? escapeMarkdown(item.error) : 'OK'} |`,
    );
  }

  lines.push('', '### Matched products', '');
  for (const item of measurements) {
    lines.push(`**${item.index}. ${escapeMarkdown(item.query)}**`);
    if (item.error) {
      lines.push(`- Lookup failed: ${escapeMarkdown(item.error)}`);
    } else if (item.matches.length === 0) {
      lines.push('- No product matches under the stated identity rules.');
    } else {
      for (const pair of item.matches) {
        const chatTitle = pair.chatgpt.title ?? pair.chatgpt.name ?? pair.chatgpt.product_title ?? '(untitled)';
        const googleTitle = pair.google.title ?? '(untitled)';
        const chatMerchant = pair.chatgpt.merchant ?? pair.chatgpt.merchants ?? pair.chatgpt.seller ?? '(unknown merchant)';
        const googleMerchant = pair.google.seller ?? pair.google.domain ?? '(unknown merchant)';
        lines.push(
          `- ChatGPT: ${escapeMarkdown(chatTitle)} — ${escapeMarkdown(Array.isArray(chatMerchant) ? chatMerchant.join(', ') : chatMerchant)}; Google: ${escapeMarkdown(googleTitle)} — ${escapeMarkdown(googleMerchant)}`,
        );
      }
    }
  }

  lines.push(
    '',
    '### Method',
    '',
    '- Each supplied query was submitted once to DataForSEO Google Shopping for the same country and language.',
    '- Products were matched by normalized GTIN when both results exposed one; otherwise by normalized title and merchant (title-only fallback when merchant identity was absent).',
    '- Duplicate products within a single response were counted once. A query with no ChatGPT products stays in the denominator of prompt hit rate, but not the ChatGPT-product coverage denominator.',
    '- The report includes provider-reported task submission cost. Task-result GET requests are not billed by DataForSEO.',
    '',
    'This report was generated from the supplied ChatGPT card export and live DataForSEO responses. Do not post it if the input does not represent actual ChatGPT Shopping observations.',
    '',
  );
  return lines.join('\n');
}

async function main() {
  const args = getArguments(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node src/scripts/measure-google-shopping-overlap.js --input FILE [--output FILE]');
    return;
  }
  if (!args.input) throw new Error('Pass --input JSON_FILE (see the script header for the schema).');
  if (!hasGoogleShoppingCredentials()) {
    throw new Error('Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD in server/.env before running this paid measurement.');
  }

  const input = JSON.parse(await readFile(resolve(args.input), 'utf8'));
  const country = typeof input.country === 'string' ? input.country.trim().toUpperCase() : '';
  const prompts = Array.isArray(input.prompts) ? input.prompts : [];
  if (!EUROPEAN_COUNTRIES.has(country)) {
    throw new Error(`Country must be an explicitly supported European market; received "${country}".`);
  }
  if (prompts.length < 20) throw new Error(`At least 20 prompts are required; received ${prompts.length}.`);

  const locationCode = regionToLocationCode(country);
  if (!locationCode) throw new Error(`No DataForSEO location code is mapped for ${country}.`);
  const languageCode =
    languageToCode(input.language) ?? defaultLanguageForRegion(country);
  if (!languageCode) throw new Error(`No language code is mapped for ${country}; add "language" to the input.`);

  const queries = prompts.map((prompt, index) => {
    const query = typeof prompt?.query === 'string' ? prompt.query.trim() : '';
    if (!query) throw new Error(`Prompt ${index + 1} is missing a non-empty query.`);
    if (query.length > 700) throw new Error(`Prompt ${index + 1} exceeds DataForSEO's 700-character keyword limit.`);
    return {
      index: index + 1,
      query,
      chatgptProducts: Array.isArray(prompt.chatgptProducts) ? prompt.chatgptProducts : [],
      tag: `ansvisor-overlap:${country}:${index + 1}`,
      keyword: query,
      locationCode,
      languageCode,
    };
  });

  console.log(`Submitting ${queries.length} paid Google Shopping tasks for ${country}/${languageCode}...`);
  const submission = await submitGoogleShoppingTasks(queries);
  const requestCosts = submission.requests.map((request) => request.cost);
  const totalCost =
    requestCosts.length > 0 && requestCosts.every((value) => typeof value === 'number')
      ? requestCosts.reduce((sum, value) => sum + value, 0)
      : null;

  const resultByTag = new Map();
  for (const result of await mapWithConcurrency(submission.tasks, 4, async (task) => {
    if (!task.id || task.error) return { ...task, products: [], resultError: task.error || 'Task was not accepted' };
    try {
      const response = await waitForGoogleShoppingTask(task.id);
      return { ...task, products: extractGoogleShoppingProducts(response), resultError: null };
    } catch (error) {
      return { ...task, products: [], resultError: error instanceof Error ? error.message : String(error) };
    }
  })) {
    resultByTag.set(result.tag, result);
  }

  const measurements = queries.map((query) => {
    const task = resultByTag.get(query.tag);
    if (!task || task.resultError) {
      return {
        index: query.index,
        query: query.query,
        chatgptProducts: dedupeProducts(query.chatgptProducts),
        googleProducts: [],
        matches: [],
        error: task?.resultError ?? 'Task result is missing',
      };
    }
    return {
      index: query.index,
      query: query.query,
      ...matchProducts(query.chatgptProducts, task.products),
      error: null,
    };
  });

  const report = buildReport({ country, language: languageCode, prompts, measurements, cost: totalCost });
  if (args.output) {
    const outputPath = resolve(args.output);
    await writeFile(outputPath, report, 'utf8');
    console.log(`Wrote measurement report to ${outputPath}`);
  } else {
    console.log(report);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
