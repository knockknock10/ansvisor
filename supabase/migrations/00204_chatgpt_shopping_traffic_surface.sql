-- ============================================================================
-- 00204: identify ChatGPT Shopping traffic by the feed UTM medium
-- ============================================================================
-- The source remains ChatGPT, so existing ChatGPT totals are inclusive. The
-- optional surface is a nested breakdown; it must never become a second source
-- platform or be added on top of the platform total.

alter table public.ai_traffic_logs
  add column if not exists source_surface text;

alter table public.ga_ai_traffic_stats
  add column if not exists session_medium text not null default '';

alter table public.ga_ai_traffic_stats
  add column if not exists source_surface text;

alter table public.ai_traffic_logs
  drop constraint if exists ai_traffic_logs_source_surface_allowed;

alter table public.ai_traffic_logs
  add constraint ai_traffic_logs_source_surface_allowed
  check (source_surface is null or source_surface = 'shopping');

alter table public.ga_ai_traffic_stats
  drop constraint if exists ga_ai_traffic_stats_source_surface_allowed;

alter table public.ga_ai_traffic_stats
  add constraint ga_ai_traffic_stats_source_surface_allowed
  check (source_surface is null or source_surface = 'shopping');

-- Reconstruct the landing URL's medium on older GA rows where it was tagged.
-- Subsequent syncs store GA4's actual sessionMedium dimension, independently
-- of the landing URL query string.
update public.ga_ai_traffic_stats
set session_medium = lower(coalesce(substring(lower(landing_page_query) from '[?&]utm_medium=([^&#]*)'), ''))
where session_medium = ''
  and lower(landing_page_query) ~ '[?&]utm_medium=';

-- Historical traffic rows kept the full landing URL, so the Shopping surface
-- can be reconstructed without creating a second visit or changing source totals.
update public.ai_traffic_logs
set source_surface = 'shopping'
where source_surface is null
  and source_platform = 'chatgpt.com'
  and lower(url) ~ '[?&]utm_medium=feed(&|#|$)';

-- `visit_of` used to group pageviews by platform alone (00172). Split any
-- already-grouped ChatGPT visit at each surface boundary so backfilled Shopping
-- visits are counted separately from text-answer visits. Rows within the same
-- prior visit and the same surface retain their original session grouping.
with ordered as (
  select
    id,
    brand_id,
    coalesce(visit_of, id) as original_root,
    source_surface,
    created_at,
    lag(id) over (
      partition by brand_id, coalesce(visit_of, id)
      order by created_at, id
    ) as previous_id,
    lag(source_surface) over (
      partition by brand_id, coalesce(visit_of, id)
      order by created_at, id
    ) as previous_surface
  from public.ai_traffic_logs
  where source_platform = 'chatgpt.com'
),
boundaries as (
  select *,
    case
      when previous_id is null or source_surface is distinct from previous_surface then 1
      else 0
    end as starts_surface_visit
  from ordered
),
segments as (
  select *,
    sum(starts_surface_visit) over (
      partition by brand_id, original_root
      order by created_at, id
      rows between unbounded preceding and current row
    ) as segment_number
  from boundaries
),
roots as (
  select id,
    first_value(id) over (
      partition by brand_id, original_root, segment_number
      order by created_at, id
      rows between unbounded preceding and unbounded following
    ) as surface_root
  from segments
)
update public.ai_traffic_logs as visit
set visit_of = case when visit.id = roots.surface_root then null else roots.surface_root end
from roots
where visit.id = roots.id
  and visit.visit_of is distinct from
    case when visit.id = roots.surface_root then null else roots.surface_root end;

update public.ga_ai_traffic_stats
set source_surface = 'shopping'
where source_surface is null
  and coalesce(platform, source) in ('chatgpt.com', 'chat.openai.com', 'search.chatgpt.com', 'chatgpt', 'openai', 'openai.com')
  and lower(session_medium) = 'feed';

-- A GA session source/page may legitimately have multiple mediums now; medium
-- is therefore part of the stored grain and the idempotent upsert key.
alter table public.ga_ai_traffic_stats
  drop constraint if exists ga_ai_traffic_stats_brand_id_date_source_landing_page_query_key;

alter table public.ga_ai_traffic_stats
  add constraint ga_ai_traffic_stats_brand_date_source_page_medium_key
  unique (brand_id, date, source, landing_page_query, session_medium);

comment on column public.ai_traffic_logs.source_surface is
  'Optional surface of the AI source. shopping is inferred when ChatGPT traffic lands on a URL tagged utm_medium=feed; source_platform stays chatgpt.com.';

comment on column public.ga_ai_traffic_stats.session_medium is
  'GA4 sessionMedium, stored separately so feed-tagged ChatGPT Shopping sessions retain their attribution and can be distinguished from text-answer traffic.';

comment on column public.ga_ai_traffic_stats.source_surface is
  'Optional surface of the normalized AI platform. shopping is derived from ChatGPT session_medium=feed.';

create or replace function public.ai_traffic_merged(
  p_brand_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_to_inclusive boolean default true,
  p_analytics boolean default true
)
returns jsonb
language sql
stable
security invoker
set search_path to 'public'
as $$
  with bounds as (
    select
      -- The first whole UTC day inside the window.
      case
        when p_from is null then null
        when (p_from at time zone 'utc')::time = time '00:00' then (p_from at time zone 'utc')::date
        else (p_from at time zone 'utc')::date + 1
      end as first_day,
      coalesce((p_to at time zone 'utc')::date, (now() at time zone 'utc')::date) as last_day
  ),
  snippet as (
    select
      (l.created_at at time zone 'utc')::date as day,
      coalesce(nullif(l.source_platform, ''), 'unknown') as platform,
      l.source_surface as source_surface,
      public.normalize_page_path(l.url) as page
    from public.ai_traffic_logs l
    where l.brand_id = p_brand_id
      and l.visit_of is null
      and l.created_at >= coalesce(p_from, '-infinity'::timestamptz)
      and (p_to is null or l.created_at < p_to or (p_to_inclusive and l.created_at = p_to))
  ),
  -- Days the snippet was active, over the whole day, not just the window.
  snippet_days as (
    select distinct (l.created_at at time zone 'utc')::date as day
    from public.ai_traffic_logs l, bounds b
    where p_analytics
      and l.brand_id = p_brand_id
      and l.visit_of is null
      and l.created_at >= coalesce((b.first_day::timestamp at time zone 'utc'), '-infinity'::timestamptz)
      and l.created_at < ((b.last_day + 1)::timestamp at time zone 'utc')
  ),
  analytics as (
    select
      g.date as day,
      coalesce(g.platform, g.source) as platform,
      g.source_surface as source_surface,
      public.normalize_page_path(g.landing_page) as page,
      g.sessions as visits
    from public.ga_ai_traffic_stats g, bounds b
    where p_analytics
      and g.brand_id = p_brand_id
      and g.sessions > 0
      and g.date >= coalesce(b.first_day, '-infinity'::date)
      and g.date <= b.last_day
      and not exists (select 1 from snippet_days s where s.day = g.date)
  ),
  merged as (
    select day, platform, source_surface, page, 1::bigint as visits, 'snippet' as origin from snippet
    union all
    select day, platform, source_surface, page, visits::bigint, 'analytics' from analytics
  )
  select jsonb_build_object(
    'visits', (select coalesce(sum(visits), 0) from merged),
    'pageviews', (
      select count(*)
      from public.ai_traffic_logs l
      where l.brand_id = p_brand_id
        and l.created_at >= coalesce(p_from, '-infinity'::timestamptz)
        and (p_to is null or l.created_at < p_to or (p_to_inclusive and l.created_at = p_to))
    ),
    'analytics_days', (
      select coalesce(jsonb_agg(distinct day order by day), '[]'::jsonb) from analytics
    ),
    'platforms', (
      select coalesce(jsonb_agg(jsonb_build_object('platform', platform, 'visits', visits) order by visits desc, platform), '[]'::jsonb)
      from (select platform, sum(visits) as visits from merged group by platform) t
    ),
    'surfaces', (
      select coalesce(jsonb_agg(jsonb_build_object('platform', platform, 'surface', source_surface, 'visits', visits) order by visits desc, platform, source_surface), '[]'::jsonb)
      from (
        select platform, source_surface, sum(visits) as visits
        from merged
        where source_surface is not null
        group by platform, source_surface
      ) t
    ),
    'pages', (
      select coalesce(jsonb_agg(jsonb_build_object('page', page, 'visits', visits) order by visits desc, page), '[]'::jsonb)
      from (select page, sum(visits) as visits from merged group by page) t
    ),
    'days', (
      select coalesce(jsonb_agg(jsonb_build_object('day', day, 'platform', platform, 'visits', visits) order by day, platform), '[]'::jsonb)
      from (select day, platform, sum(visits) as visits from merged group by day, platform) t
    )
  );
$$;

revoke all on function public.ai_traffic_merged(uuid, timestamptz, timestamptz, boolean, boolean)
  from public, anon;
grant execute on function public.ai_traffic_merged(uuid, timestamptz, timestamptz, boolean, boolean)
  to authenticated, service_role;

comment on function public.ai_traffic_merged(uuid, timestamptz, timestamptz, boolean, boolean) is
  'AI Traffic (AT-004, spec §5.2): AI-referred visits for one brand in a window, from the tracking snippet on days it was active and from Google Analytics on other whole days, never summed. Returns visits, the snippet''s pageviews, the days Analytics filled, and visits by platform, page and day. Security invoker: RLS decides the brand.';

notify pgrst, 'reload schema';
