import { Router } from 'express';
import supabaseAdmin from '../config/supabase.js';
import { assertBrandAccess } from '../lib/access.js';
import { deleteBrand } from '../lib/brand-delete.js';
import {
  draftBrandProfile,
  missingBrandProfileFields,
  pickMissingDraftFields,
} from '../lib/brand-profile.js';

const router = Router();

/**
 * How long the request waits for the delete before answering that it is
 * still running. Most brands are gone well within it; the largest take
 * minutes, and the deletion carries on after the response.
 */
const WAIT_MS = 20_000;

/**
 * POST /api/brands/:id/profile/draft
 * Draft missing profile fields using the existing site-page inventory.
 * This is a preview only: the user reviews and saves the returned values.
 */
router.post('/:id/profile/draft', async (req, res) => {
  const brandId = req.params.id;
  try {
    await assertBrandAccess(brandId, req.user.id);

    const { data: brand, error: brandError } = await supabaseAdmin
      .from('brands')
      .select(
        'id, name, industry, description, language, products_and_services, target_customers, business_model, conversion_goals',
      )
      .eq('id', brandId)
      .maybeSingle();

    if (brandError) throw brandError;
    if (!brand) return res.status(404).json({ error: 'Brand not found.' });

    const missingFields = missingBrandProfileFields(brand);
    if (missingFields.length === 0) {
      return res.json({ profile: {}, complete: true });
    }

    const [
      { data: domains, error: domainsError },
      { data: sitePages, error: sitePagesError },
    ] = await Promise.all([
      supabaseAdmin
        .from('brand_domains')
        .select('domain, is_primary')
        .eq('brand_id', brandId)
        .order('is_primary', { ascending: false }),
      supabaseAdmin
        .from('site_pages')
        .select('url, title, description, h1, ai_citations, ga_sessions, lastmod')
        .eq('brand_id', brandId)
        .eq('fetch_status', 200)
        .order('ai_citations', { ascending: false })
        .order('ga_sessions', { ascending: false })
        .limit(80),
    ]);

    if (domainsError) throw domainsError;
    if (sitePagesError) throw sitePagesError;
    if (!(domains ?? []).some((row) => typeof row.domain === 'string' && row.domain.trim())) {
      return res.status(400).json({
        error: 'Add a website domain before drafting the profile from your site.',
      });
    }

    const draft = await draftBrandProfile({
      brand,
      domains: domains ?? [],
      sitePages: sitePages ?? [],
      missingFields,
    });

    // The model receives existing values as context, but only fields that were
    // missing before the call can be returned for preview. It never writes to
    // the database, so accepting or rejecting a draft is always the user's choice.
    return res.json({ profile: pickMissingDraftFields(draft, missingFields) });
  } catch (error) {
    req.log?.error?.({ err: error, brandId }, 'brand profile draft failed');
    const status = Number.isInteger(error?.status) ? error.status : 500;
    return res.status(status).json({
      error:
        status < 500
          ? error.message
          : 'Could not draft the brand profile. Please try again.',
    });
  }
});

/**
 * DELETE /api/brands/:id
 * Deletes a brand and all its data. Admins only, as the brands delete policy
 * allows. 200 when it is gone, 202 when it is still being deleted.
 */
router.delete('/:id', async (req, res) => {
  try {
    const brandId = req.params.id;
    await assertBrandAccess(brandId, req.user.id);

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', req.user.id)
      .single();
    if (profile?.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can delete a brand.' });
    }

    const job = deleteBrand(brandId);
    const outcome = await Promise.race([
      job.then(() => 'deleted'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), WAIT_MS)),
    ]);
    // A delete that outlives the request must not surface as an unhandled
    // rejection; brand-delete.js has already logged it.
    job.catch(() => {});

    return outcome === 'deleted'
      ? res.json({ deleted: true })
      : res.status(202).json({ deleted: false, pending: true });
  } catch (error) {
    req.log.error({ err: error }, 'delete brand error');
    return res.status(error.status || 500).json({
      error: error.status ? error.message : 'Failed to delete the brand.',
    });
  }
});

export default router;
