const e=`-- Статистика кабинета. Период [p_from 00:00, p_to + 1 00:00) по часовому поясу студии.
-- Разные сущности не смешиваются:
--   visits      — заезды (arrived_at в периоде);
--   completed   — выполненные заказы и их стоимость по цене записи (completed_at в периоде);
--   payments    — фактически полученные деньги минус возвраты (paid_at в периоде);
--   scheduled   — будущие/активные записи с началом в периоде: ожидаемая стоимость, не выручка.
create or replace function public.owner_stats(p_tenant_id uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  t public.tenants;
  v_start timestamptz;
  v_end timestamptz;
begin
  begin
    perform private.assert_member(p_tenant_id);
    if p_to < p_from or p_to - p_from > 366 then perform private.fail('invalid_range'); end if;
  exception when sqlstate 'P0001' then
    return private.err(sqlerrm);
  end;
  select * into t from public.tenants where id = p_tenant_id;
  v_start := private.local_midnight(p_from, t.timezone);
  v_end := private.local_midnight(p_to + 1, t.timezone);

  return jsonb_build_object(
    'ok', true,
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'timezone', t.timezone,
                                 'starts_at', v_start, 'ends_at', v_end),
    'currency', t.currency,
    'visits', (select count(*) from public.bookings
                where tenant_id = t.id and arrived_at >= v_start and arrived_at < v_end),
    'completed', (select jsonb_build_object('count', count(*), 'value_minor', coalesce(sum(price_minor), 0))
                    from public.bookings
                   where tenant_id = t.id and status = 'completed' and completed_at >= v_start and completed_at < v_end),
    'payments', (select jsonb_build_object(
                          'received_minor', coalesce(sum(amount_minor) filter (where kind = 'payment'), 0),
                          'refunded_minor', coalesce(sum(amount_minor) filter (where kind = 'refund'), 0),
                          'net_minor', coalesce(sum(case when kind = 'payment' then amount_minor else -amount_minor end), 0),
                          'count', count(*) filter (where kind = 'payment'))
                   from public.payments
                  where tenant_id = t.id and paid_at >= v_start and paid_at < v_end),
    'scheduled', (select jsonb_build_object('count', count(*), 'expected_value_minor', coalesce(sum(price_minor), 0))
                    from public.bookings
                   where tenant_id = t.id and status in ('new', 'confirmed') and starts_at >= v_start and starts_at < v_end),
    'cancelled', (select count(*) from public.bookings
                   where tenant_id = t.id and status = 'cancelled' and cancelled_at >= v_start and cancelled_at < v_end),
    'no_show', (select count(*) from public.bookings
                 where tenant_id = t.id and status = 'no_show' and starts_at >= v_start and starts_at < v_end),
    'by_service', coalesce((
      select jsonb_agg(jsonb_build_object('service', s.name, 'completed', x.n, 'value_minor', x.v) order by x.v desc)
        from (select service_id, count(*) n, sum(price_minor) v from public.bookings
               where tenant_id = t.id and status = 'completed' and completed_at >= v_start and completed_at < v_end
               group by service_id) x
        join public.services s on s.id = x.service_id), '[]'::jsonb),
    'by_day', coalesce((
      select jsonb_agg(jsonb_build_object('date', d.day, 'visits', d.visits, 'completed', d.completed,
                                          'payments_minor', d.paid) order by d.day)
        from (
          select g.day::date as day,
                 (select count(*) from public.bookings b where b.tenant_id = t.id
                     and (b.arrived_at at time zone t.timezone)::date = g.day::date) as visits,
                 (select count(*) from public.bookings b where b.tenant_id = t.id and b.status = 'completed'
                     and (b.completed_at at time zone t.timezone)::date = g.day::date) as completed,
                 (select coalesce(sum(case when p.kind = 'payment' then p.amount_minor else -p.amount_minor end), 0)
                    from public.payments p where p.tenant_id = t.id
                     and (p.paid_at at time zone t.timezone)::date = g.day::date) as paid
            from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g(day)
        ) d), '[]'::jsonb));
end $$;
`;export{e as default};
