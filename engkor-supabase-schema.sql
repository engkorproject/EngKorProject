-- ============================================================
-- EngKor 데이터베이스 스키마
-- Supabase 프로젝트 생성 후, 왼쪽 메뉴 SQL Editor에서 이 파일 전체를
-- 붙여넣고 "Run" 버튼을 누르면 됩니다. (한 번만 실행하면 됩니다)
-- ============================================================

-- 1) 회원 프로필 테이블
--    로그인 계정(auth.users)마다 이름과 역할(member/leader)을 저장
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  role text not null default 'member' check (role in ('member', 'leader')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- "현재 로그인한 사람이 리더인가?"를 확인하는 함수.
-- security definer로 만들어서 테이블 소유자 권한으로 조회하기 때문에,
-- 정책(policy) 안에서 같은 테이블을 다시 조회해도 무한 루프가 생기지 않음.
create or replace function public.is_leader()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'leader'
  );
$$;

-- 본인 프로필은 본인이 조회 가능
create policy "select_own_profile" on public.profiles
  for select using (auth.uid() = id);

-- 리더는 전체 회원 프로필 조회 가능
create policy "leader_select_all_profiles" on public.profiles
  for select using (public.is_leader());

-- 회원가입하면 자동으로 프로필 행을 만들어줌 (기본 역할: member)
create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', new.email), 'member');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();


-- 2) 하루 과제 제출 테이블 (Writing / Shadowing)
create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles(id) on delete cascade,
  date date not null,
  diary_url text,       -- Writing 스크린샷 (당분간 base64 그대로 저장)
  shadowing_url text,    -- Shadowing 오디오 (당분간 base64 그대로 저장)
  created_at timestamptz not null default now(),
  unique (member_id, date)
);

alter table public.submissions enable row level security;

-- 본인 제출물은 본인이 보고, 쓰고, 수정 가능
create policy "member_manage_own_submissions" on public.submissions
  for all using (auth.uid() = member_id) with check (auth.uid() = member_id);

-- 리더는 전체 제출물 조회 가능
create policy "leader_select_all_submissions" on public.submissions
  for select using (public.is_leader());


-- 3) 주간 피드백 테이블
create table public.weekly_feedback (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles(id) on delete cascade,
  week_key text not null,   -- 예: "2026-07-W3"
  text text,                 -- 리더가 작성한 원본 피드백
  by_date jsonb,              -- 날짜별로 AI가 분류한 피드백
  updated_at timestamptz not null default now(),
  unique (member_id, week_key)
);

alter table public.weekly_feedback enable row level security;

-- 본인 피드백은 본인이 조회만 가능 (수정은 리더만)
create policy "member_select_own_feedback" on public.weekly_feedback
  for select using (auth.uid() = member_id);

-- 리더는 전체 피드백 조회/작성/수정 가능
create policy "leader_manage_all_feedback" on public.weekly_feedback
  for all using (public.is_leader()) with check (public.is_leader());


-- ============================================================
-- 참고: 첫 리더 계정 만드는 법
-- 1. 웹사이트에서 평소처럼 이메일로 회원가입을 한 번 합니다.
--    (자동으로 profiles 테이블에 role='member'로 등록됩니다)
-- 2. Supabase 왼쪽 메뉴 Table Editor → profiles 테이블에서
--    본인 행의 role 값을 'member'에서 'leader'로 직접 바꿔주세요.
-- 이후로는 그 계정으로 로그인하면 리더 대시보드가 보이게 됩니다.
-- ============================================================
