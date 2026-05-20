create table if not exists public.aether_store (
  name text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create or replace function public.set_aether_store_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_aether_store_updated_at on public.aether_store;

create trigger set_aether_store_updated_at
before update on public.aether_store
for each row
execute function public.set_aether_store_updated_at();
