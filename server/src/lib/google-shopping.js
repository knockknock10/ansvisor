/**
 * Google Shopping results through DataForSEO's Merchant API.
 *
 * Task submission is paid; task-result GET requests are free. Keep these
 * endpoints separate from dataforseo.js, which serves Google Ads search volume.
 *
 * API docs:
 * https://docs.dataforseo.com/v3/merchant/google/products/task_post/
 * https://docs.dataforseo.com/v3/merchant-google-products-task_get-advanced/
 */

const TASK_POST_URL = 'https://api.dataforseo.com/v3/merchant/google/products/task_post';
const TASK_GET_URL = 'https://api.dataforseo.com/v3/merchant/google/products/task_get/advanced';
const MAX_TASKS_PER_REQUEST = 100;
const DEFAULT_DEPTH = 40;
const MAX_DEPTH = 120;
const SUCCESS_CODES = new Set([20000, 20100]);
const RETRYABLE_API_CODES = new Set([40400, 40401, 40601]);

function authHeader() {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) {
    throw new Error(
      'DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD must be set to use Google Shopping',
    );
  }
  return `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
}

export function hasGoogleShoppingCredentials() {
  return Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
}

function createApiError(message, { status = null, code = null, retryable = false } = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.retryable = retryable;
  return error;
}

async function readJson(response, context) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw createApiError(`${context}: DataForSEO returned invalid JSON`, {
      status: response.status,
      retryable: response.status >= 500,
    });
  }
  if (!response.ok) {
    const detail = data?.status_message || response.statusText || 'unknown error';
    throw createApiError(`${context}: HTTP ${response.status}: ${detail}`, {
      status: response.status,
      code: data?.status_code ?? null,
      retryable:
        response.status === 404 ||
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500,
    });
  }
  if (data?.status_code !== 20000) {
    const code = data?.status_code ?? null;
    throw createApiError(`${context}: ${data?.status_message || 'DataForSEO API error'}`, {
      status: response.status,
      code,
      retryable: RETRYABLE_API_CODES.has(code),
    });
  }
  return data;
}

function normalizeTaskInput(task, index) {
  const keyword = typeof task?.keyword === 'string' ? task.keyword.trim() : '';
  if (!keyword) throw new Error(`Google Shopping task ${index + 1} requires a non-empty keyword`);
  if (keyword.length > 700) {
    throw new Error(`Google Shopping task ${index + 1} keyword exceeds 700 characters`);
  }
  if (!Number.isInteger(task.locationCode) || task.locationCode <= 0) {
    throw new Error(`Google Shopping task ${index + 1} requires a valid locationCode`);
  }
  const languageCode =
    typeof task.languageCode === 'string' ? task.languageCode.trim().toLowerCase() : '';
  if (!/^[a-z]{2}$/.test(languageCode)) {
    throw new Error(`Google Shopping task ${index + 1} requires a two-letter languageCode`);
  }
  const depth = task.depth ?? DEFAULT_DEPTH;
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) {
    throw new Error(`Google Shopping task ${index + 1} depth must be between 1 and ${MAX_DEPTH}`);
  }
  return { ...task, keyword, languageCode, depth };
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function remoteTaskTag(task) {
  return task?.data?.tag ?? task?.tag ?? null;
}

/**
 * Submit Google Shopping lookups. Each lookup is a paid DataForSEO task;
 * batches are capped at the provider's documented 100 tasks per POST.
 *
 * A failed batch is represented on its task rows instead of discarding the
 * successfully submitted rows from earlier batches. Request-level cost is
 * returned as reported by DataForSEO and is never estimated here.
 *
 * @param {Array<{keyword:string, locationCode:number, languageCode:string, tag?:string}>} tasks
 * @param {{ fetchImpl?: typeof fetch, onRequest?: (request: object) => void }} options
 * @returns {Promise<{tasks: object[], requests: object[]}>}
 */
export async function submitGoogleShoppingTasks(tasks, { fetchImpl = fetch, onRequest } = {}) {
  if (!Array.isArray(tasks)) throw new TypeError('Google Shopping tasks must be an array');
  if (tasks.length === 0) return { tasks: [], requests: [] };

  const normalized = tasks.map(normalizeTaskInput);
  const submittedTasks = [];
  const requests = [];
  const credentials = authHeader();

  const batches = chunks(normalized, MAX_TASKS_PER_REQUEST);
  for (const [batchIndex, batch] of batches.entries()) {
    let request;
    try {
      const response = await fetchImpl(TASK_POST_URL, {
        method: 'POST',
        headers: {
          Authorization: credentials,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(
          batch.map((task) => ({
            keyword: task.keyword,
            location_code: task.locationCode,
            language_code: task.languageCode,
            depth: task.depth,
            ...(task.tag ? { tag: task.tag } : {}),
          })),
        ),
      });
      const data = await readJson(response, 'Google Shopping task submission');
      const remoteTasks = Array.isArray(data.tasks) ? data.tasks : [];
      const unusedRemoteTasks = [...remoteTasks];
      request = {
        cost: typeof data.cost === 'number' && Number.isFinite(data.cost) ? data.cost : null,
        tasksCount: data.tasks_count ?? remoteTasks.length,
        tasksError: data.tasks_error ?? 0,
        statusCode: data.status_code,
        error: null,
      };

      batch.forEach((inputTask, index) => {
        const tagIndex = inputTask.tag
          ? unusedRemoteTasks.findIndex((item) => remoteTaskTag(item) === inputTask.tag)
          : -1;
        const remoteIndex =
          tagIndex >= 0 ? tagIndex : unusedRemoteTasks.length === batch.length ? index : 0;
        const [remote] = unusedRemoteTasks.splice(remoteIndex, 1);
        const statusCode = remote?.status_code ?? null;
        const successful =
          Boolean(remote?.id) && (statusCode == null || SUCCESS_CODES.has(statusCode));
        submittedTasks.push({
          ...inputTask,
          id: successful ? remote.id : null,
          statusCode,
          statusMessage: remote?.status_message ?? null,
          taskCost: typeof remote?.cost === 'number' && Number.isFinite(remote.cost) ? remote.cost : null,
          error: successful
            ? null
            : remote?.status_message || 'DataForSEO did not accept this task',
        });
      });
    } catch (error) {
      request = {
        cost: null,
        tasksCount: batch.length,
        tasksError: batch.length,
        statusCode: error?.code ?? null,
        error: error instanceof Error ? error.message : String(error),
      };
      for (const task of batch) {
        submittedTasks.push({
          ...task,
          id: null,
          statusCode: error?.code ?? null,
          statusMessage: null,
          taskCost: null,
          error: request.error,
        });
      }
      // Invalid credentials are not fixed by sending the next batch.
      if (error?.status === 401 || error?.status === 403) {
        for (const remaining of batches.slice(batchIndex + 1).flat()) {
          submittedTasks.push({
            ...remaining,
            id: null,
            statusCode: error.status,
            statusMessage: null,
            taskCost: null,
            error: request.error,
          });
        }
        requests.push(request);
        try {
          onRequest?.(request);
        } catch {
          // Logging hooks must not alter provider results.
        }
        break;
      }
    }

    requests.push(request);
    try {
      onRequest?.(request);
    } catch {
      // Logging hooks must not alter provider results.
    }
  }

  return { tasks: submittedTasks, requests };
}

/**
 * Retrieve one previously submitted task. Result GETs are not billed.
 *
 * @param {string} taskId
 * @param {{ fetchImpl?: typeof fetch }} options
 */
export async function getGoogleShoppingTask(taskId, { fetchImpl = fetch } = {}) {
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw new TypeError('Google Shopping task id is required');
  }

  const response = await fetchImpl(`${TASK_GET_URL}/${encodeURIComponent(taskId)}`, {
    method: 'GET',
    headers: { Authorization: authHeader() },
  });
  const data = await readJson(response, 'Google Shopping task retrieval');
  const task = data.tasks?.[0];
  if (!task) {
    throw createApiError('Google Shopping task is not ready yet', {
      code: 40401,
      retryable: true,
    });
  }
  if (!SUCCESS_CODES.has(task.status_code)) {
    throw createApiError(
      `Google Shopping task failed (${task.status_code ?? 'unknown'}): ${task.status_message || 'Unknown error'}`,
      {
        code: task.status_code ?? null,
        retryable: RETRYABLE_API_CODES.has(task.status_code),
      },
    );
  }
  if (task.result == null) {
    throw createApiError('Google Shopping task result is not ready yet', {
      code: 40401,
      retryable: true,
    });
  }
  return task;
}

/**
 * Poll a task result with bounded retries. Authentication and permanent task
 * failures fail immediately; provider-not-ready and transient HTTP errors retry.
 */
export async function waitForGoogleShoppingTask(
  taskId,
  { fetchImpl = fetch, attempts = 12, delayMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError('Google Shopping task polling attempts must be at least 1');
  }
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await getGoogleShoppingTask(taskId, { fetchImpl });
    } catch (error) {
      lastError = error;
      if (error?.status === 401 || error?.status === 403 || !error?.retryable || attempt === attempts) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
  throw lastError ?? new Error(`Google Shopping task ${taskId} did not become ready`);
}

const PRODUCT_TYPES = new Set(['google_shopping_serp', 'google_shopping_paid']);

function isProductItem(item) {
  return Boolean(
    item &&
      typeof item === 'object' &&
      typeof item.title === 'string' &&
      item.title.trim() &&
      !Array.isArray(item.items) &&
      (item.price != null ||
        item.product_id != null ||
        item.gtin != null ||
        item.product_rating != null ||
        PRODUCT_TYPES.has(item.type)),
  );
}

/**
 * Flatten the Merchant API's mixed SERP structure, including products nested
 * in carousel containers, while discarding unrelated entities such as related
 * searches. A product repeated in a carousel and the organic list is one
 * appearance within the same run.
 */
export function extractGoogleShoppingProducts(task) {
  const products = [];
  const seen = new Set();

  function visit(item) {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (Array.isArray(item.items)) {
      visit(item.items);
      return;
    }
    if (!isProductItem(item)) return;

    const key = googleShoppingProductKey(item);
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    products.push(item);
  }

  for (const result of Array.isArray(task?.result) ? task.result : []) {
    visit(result?.items ?? []);
  }
  return products;
}

function normalizeIdentityText(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function merchantIdentity(card) {
  const domain = typeof card?.domain === 'string' ? card.domain : '';
  const url = typeof card?.url === 'string' ? card.url : '';
  const candidate = domain || url;
  if (candidate) {
    try {
      return new URL(candidate.includes('://') ? candidate : `https://${candidate}`)
        .hostname.toLowerCase()
        .replace(/^www\./, '');
    } catch {
      const recovered = candidate.match(/^(?:https?:\/\/)?(?:www\.)?([^/\s?#]+)/i);
      if (recovered) return normalizeIdentityText(recovered[1]);
    }
  }
  return normalizeIdentityText(card?.seller ?? card?.merchant ?? '');
}

/**
 * Matching identity intentionally uses GTIN/EAN/UPC when present, otherwise
 * normalized title + merchant. Google's dynamic product_id is not a GTIN and
 * must not be treated as one.
 */
export function googleShoppingProductKey(card) {
  const gtin = [card?.gtin, card?.gtin13, card?.ean, card?.upc, card?.isbn]
    .find((value) => typeof value === 'string' || typeof value === 'number');
  const normalizedGtin = gtin == null ? '' : String(gtin).replace(/\D/g, '');
  if (normalizedGtin) return `gtin:${normalizedGtin}`;

  const title = normalizeIdentityText(card?.title ?? card?.product_title ?? card?.name);
  if (!title) return null;
  const merchant = merchantIdentity(card);
  return `title:${title}|merchant:${merchant || 'unknown'}`;
}

/**
 * Annotate each successful run's products with their appearance frequency.
 * A successful run returning no products still belongs in the denominator;
 * failed requests do not. Duplicate cards in a single run count once.
 *
 * @param {Array<{success:boolean, products?:object[], runIndex?:number}>} runs
 */
export function calculateGoogleShoppingAppearance(runs) {
  const safeRuns = Array.isArray(runs) ? runs : [];
  const successfulRuns = safeRuns.filter((run) => run?.success === true);
  const identitiesByRun = new Map();
  const counts = new Map();

  for (const run of successfulRuns) {
    const deduped = [];
    const seen = new Set();
    for (const product of Array.isArray(run.products) ? run.products : []) {
      if (!product || typeof product !== 'object') continue;
      const key = googleShoppingProductKey(product);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push({ product, key });
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    identitiesByRun.set(run, deduped);
  }

  const successfulRunCount = successfulRuns.length;
  const annotatedRuns = safeRuns.map((run) => {
    if (run?.success !== true) return { ...run, products: [] };
    const products = (identitiesByRun.get(run) ?? []).map(({ product, key }) => {
      const appearanceCount = counts.get(key) ?? 0;
      return {
        ...product,
        ansvisor_google_shopping_appearance: {
          appearance_count: appearanceCount,
          successful_run_count: successfulRunCount,
          appearance_percentage:
            successfulRunCount > 0
              ? Math.round((appearanceCount / successfulRunCount) * 10000) / 100
              : null,
        },
      };
    });
    return { ...run, products };
  });

  return { successfulRunCount, annotatedRuns };
}
