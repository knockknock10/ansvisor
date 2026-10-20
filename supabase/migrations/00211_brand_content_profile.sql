-- ============================================================================
-- 00211: structured brand profile for content opportunities
-- ============================================================================
-- Store the business context separately from the short brand description so
-- fan-out judging and opportunity generation can use what the brand sells,
-- who it serves, how it earns revenue and which conversions matter.

alter table public.brands
  add column products_and_services text,
  add column target_customers text,
  add column business_model text,
  add column conversion_goals text[] not null default '{}';

alter table public.brands
  add constraint brands_business_model_allowed
  check (
    business_model is null or business_model = any(array[
      'saas',
      'e_commerce',
      'marketplace',
      'agency',
      'local_business',
      'publisher',
      'nonprofit',
      'other'
    ]::text[])
  );

alter table public.brands
  add constraint brands_conversion_goals_allowed
  check (
    conversion_goals <@ array[
      'sign_up',
      'demo_request',
      'purchase',
      'lead_form',
      'contact',
      'subscribe',
      'book_appointment',
      'other'
    ]::text[]
  );

comment on column public.brands.products_and_services is
  'Structured, user-editable summary of products and services; informs prompt judging and content opportunity generation.';

comment on column public.brands.target_customers is
  'Structured, user-editable summary of target customers; informs prompt judging and content opportunity generation.';

comment on column public.brands.business_model is
  'Controlled business model value: saas, e_commerce, marketplace, agency, local_business, publisher, nonprofit, or other.';

comment on column public.brands.conversion_goals is
  'Controlled conversion goal values: sign_up, demo_request, purchase, lead_form, contact, subscribe, book_appointment, other.';
