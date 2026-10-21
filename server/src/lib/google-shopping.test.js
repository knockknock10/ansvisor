import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateGoogleShoppingAppearance,
  extractGoogleShoppingProducts,
  getGoogleShoppingTask,
  googleShoppingProductKey,
  hasGoogleShoppingCredentials,
  submitGoogleShoppingTasks,
  waitForGoogleShoppingTask,
} from './google-shopping.js';

function jsonResponse(data, { status = 200, ok = true } = {}) {
  return {
    ok,
    status,
    statusText: status === 404 ? 'Not Found' : 'OK',
    json: async () => data,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('hasGoogleShoppingCredentials', () => {
  it('requires both DataForSEO credentials', () => {
    vi.stubEnv('DATAFORSEO_LOGIN', '');
    vi.stubEnv('DATAFORSEO_PASSWORD', '');
    expect(hasGoogleShoppingCredentials()).toBe(false);

    vi.stubEnv('DATAFORSEO_LOGIN', 'login');
    expect(hasGoogleShoppingCredentials()).toBe(false);

    vi.stubEnv('DATAFORSEO_PASSWORD', 'password');
    expect(hasGoogleShoppingCredentials()).toBe(true);
  });
});

describe('submitGoogleShoppingTasks', () => {
  it('submits in batches of at most 100 and preserves tags and provider costs', async () => {
    vi.stubEnv('DATAFORSEO_LOGIN', 'login');
    vi.stubEnv('DATAFORSEO_PASSWORD', 'password');
    const fetchImpl = vi.fn(async (_url, options) => {
      const payload = JSON.parse(options.body);
      return jsonResponse({
        status_code: 20000,
        cost: payload.length * 0.05,
        tasks_count: payload.length,
        tasks_error: 0,
        tasks: payload.map((task, index) => ({
          id: `task-${task.tag}`,
          status_code: 20100,
          status_message: 'Task Created.',
          cost: 0.05,
          data: { tag: task.tag },
        })),
      });
    });
    const tasks = Array.from({ length: 101 }, (_, index) => ({
      keyword: `product query ${index}`,
      locationCode: 2276,
      languageCode: 'de',
      tag: `prompt-${index}`,
    }));

    const result = await submitGoogleShoppingTasks(tasks, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toHaveLength(100);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toHaveLength(1);
    expect(result.tasks).toHaveLength(101);
    expect(result.tasks.every((task) => task.id && task.error === null)).toBe(true);
    expect(result.tasks[100].tag).toBe('prompt-100');
    expect(result.requests.map((request) => request.cost)).toEqual([5, 0.05]);
  });

  it('rejects empty, too-long, and invalidly targeted tasks before making a request', async () => {
    vi.stubEnv('DATAFORSEO_LOGIN', 'login');
    vi.stubEnv('DATAFORSEO_PASSWORD', 'password');
    const fetchImpl = vi.fn();

    await expect(
      submitGoogleShoppingTasks([{ keyword: ' ', locationCode: 2276, languageCode: 'de' }], {
        fetchImpl,
      }),
    ).rejects.toThrow(/non-empty keyword/);
    await expect(
      submitGoogleShoppingTasks(
        [{ keyword: 'x'.repeat(701), locationCode: 2276, languageCode: 'de' }],
        { fetchImpl },
      ),
    ).rejects.toThrow(/700 characters/);
    await expect(
      submitGoogleShoppingTasks([{ keyword: 'camera', locationCode: 0, languageCode: 'de' }], {
        fetchImpl,
      }),
    ).rejects.toThrow(/locationCode/);
    await expect(
      submitGoogleShoppingTasks([{ keyword: 'camera', locationCode: 2276, languageCode: 'de-DE' }], {
        fetchImpl,
      }),
    ).rejects.toThrow(/two-letter languageCode/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns per-task failures and the reported batch cost when a task is rejected', async () => {
    vi.stubEnv('DATAFORSEO_LOGIN', 'login');
    vi.stubEnv('DATAFORSEO_PASSWORD', 'password');
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        status_code: 20000,
        cost: 0.05,
        tasks_count: 1,
        tasks_error: 1,
        tasks: [{ status_code: 40501, status_message: 'Invalid keyword', data: { tag: 'x' } }],
      }),
    );

    const result = await submitGoogleShoppingTasks(
      [{ keyword: 'camera', locationCode: 2276, languageCode: 'de', tag: 'x' }],
      { fetchImpl },
    );
    expect(result.tasks[0].id).toBeNull();
    expect(result.tasks[0].error).toBe('Invalid keyword');
    expect(result.requests[0].cost).toBe(0.05);
  });

  it('returns an empty result without requiring credentials for no tasks', async () => {
    vi.stubEnv('DATAFORSEO_LOGIN', '');
    vi.stubEnv('DATAFORSEO_PASSWORD', '');
    await expect(submitGoogleShoppingTasks([])).resolves.toEqual({ tasks: [], requests: [] });
  });
});

describe('getGoogleShoppingTask and waitForGoogleShoppingTask', () => {
  it('fetches a result by task id and rejects failed provider tasks', async () => {
    vi.stubEnv('DATAFORSEO_LOGIN', 'login');
    vi.stubEnv('DATAFORSEO_PASSWORD', 'password');
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        status_code: 20000,
        tasks: [{ id: 'abc', status_code: 20000, result: [{ items: [] }] }],
      }),
    );

    await expect(getGoogleShoppingTask('abc', { fetchImpl })).resolves.toMatchObject({
      id: 'abc',
      result: [{ items: [] }],
    });
    expect(fetchImpl.mock.calls[0][0]).toContain('/abc');

    const failure = vi.fn(async () =>
      jsonResponse({
        status_code: 20000,
        tasks: [{ id: 'abc', status_code: 40501, status_message: 'Bad task', result: null }],
      }),
    );
    await expect(getGoogleShoppingTask('abc', { fetchImpl: failure })).rejects.toThrow(/Bad task/);
  });

  it('retries a not-ready task and stops after a successful result', async () => {
    vi.stubEnv('DATAFORSEO_LOGIN', 'login');
    vi.stubEnv('DATAFORSEO_PASSWORD', 'password');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status_code: 20000, tasks: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          status_code: 20000,
          tasks: [{ id: 'abc', status_code: 20000, result: [{ items: [] }] }],
        }),
      );
    const sleep = vi.fn(async () => {});

    await expect(
      waitForGoogleShoppingTask('abc', { fetchImpl, attempts: 3, sleep }),
    ).resolves.toMatchObject({ id: 'abc' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('fails fast for missing credentials', async () => {
    vi.stubEnv('DATAFORSEO_LOGIN', '');
    vi.stubEnv('DATAFORSEO_PASSWORD', '');
    await expect(getGoogleShoppingTask('abc')).rejects.toThrow(/DATAFORSEO_LOGIN/);
  });
});

describe('extractGoogleShoppingProducts', () => {
  it('flattens shopping carousels and organic products, skipping unrelated elements and duplicates', () => {
    const products = extractGoogleShoppingProducts({
      result: [
        {
          items: [
            {
              type: 'google_shopping_sponsored_carousel',
              title: 'Sponsored products',
              items: [
                {
                  title: 'Blue Camera',
                  seller: 'Camera Shop',
                  domain: 'camera.example',
                  price: 99.99,
                  currency: 'EUR',
                },
              ],
            },
            {
              type: 'google_shopping_serp',
              title: 'Blue Camera',
              seller: 'Camera Shop',
              domain: 'camera.example',
              price: 99.99,
              currency: 'EUR',
            },
            { type: 'related_searches', title: 'Camera accessories' },
          ],
        },
      ],
    });

    expect(products).toHaveLength(1);
    expect(products[0].title).toBe('Blue Camera');
  });

  it('deduplicates the same GTIN across merchants but does not treat Google product_id as a GTIN', () => {
    const products = extractGoogleShoppingProducts({
      result: [
        {
          items: [
            { title: 'Same item', gtin: '00012345678905', seller: 'Store A', price: 10 },
            { title: 'Same item', gtin: '00012345678905', seller: 'Store B', price: 11 },
            { title: 'Other item', product_id: '123', seller: 'Store A', price: 12 },
          ],
        },
      ],
    });
    expect(products).toHaveLength(2);
    expect(googleShoppingProductKey({ title: 'Other item', product_id: '123', seller: 'Store A' }))
      .toBe('title:other item|merchant:store a');
  });
});

describe('calculateGoogleShoppingAppearance', () => {
  it('uses successful runs as the denominator and counts a product once per run', () => {
    const product = { title: 'Blue Camera', seller: 'Camera Shop', price: 99 };
    const result = calculateGoogleShoppingAppearance([
      { success: true, runIndex: 0, products: [product, { ...product }] },
      { success: true, runIndex: 1, products: [{ ...product }] },
      { success: true, runIndex: 2, products: [] },
      { success: false, runIndex: 3, products: [] },
    ]);

    expect(result.successfulRunCount).toBe(3);
    expect(result.annotatedRuns[0].products).toHaveLength(1);
    expect(
      result.annotatedRuns[0].products[0].ansvisor_google_shopping_appearance,
    ).toEqual({
      appearance_count: 2,
      successful_run_count: 3,
      appearance_percentage: 66.67,
    });
    expect(result.annotatedRuns[2].products).toEqual([]);
    expect(result.annotatedRuns[3].products).toEqual([]);
  });

  it('matches by GTIN across sellers and reports null percentage when every run failed', () => {
    const result = calculateGoogleShoppingAppearance([
      { success: true, products: [{ title: 'Phone', gtin: '12345678', seller: 'A' }] },
      { success: true, products: [{ title: 'Phone', gtin: '12345678', seller: 'B' }] },
    ]);
    expect(
      result.annotatedRuns[0].products[0].ansvisor_google_shopping_appearance.appearance_percentage,
    ).toBe(100);

    const failed = calculateGoogleShoppingAppearance([{ success: false, products: [] }]);
    expect(failed.successfulRunCount).toBe(0);
    expect(failed.annotatedRuns[0].products).toEqual([]);
  });
});
