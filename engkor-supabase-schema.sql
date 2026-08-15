-- ============================================================
-- EngKor 데이터베이스 스키마
-- Supabase 프로젝트 생성 후, 왼쪽 메뉴 SQL Editor에서 이 파일 전체를
-- 붙여넣고 "Run" 버튼을 누르면 됩니다. (한 번만 실행하면 됩니다)
-- ============================================================

-- 1) 회원 프로필 테이블
--    로그인 계정(auth.users)마다 이름/역할(member/leader)/이메일/시간대를 저장
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  role text not null default 'member' check (role in ('member', 'leader')),
  email text unique,       -- auth.users의 이메일을 캐시(클라이언트에서 auth.users 직접 조회 불가)
  timezone text not null default 'Asia/Seoul',  -- IANA 타임존 문자열, 예: 'Asia/Seoul'
  cohort_id uuid,          -- 현재 소속 기수 (아래 cohorts 테이블 생성 후 FK 연결)
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
-- email은 auth.users에서, timezone은 가입 시 프론트에서 넘겨준 값(없으면 Asia/Seoul)으로 채움
create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name, role, email, timezone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', new.email),
    'member',
    new.email,
    coalesce(new.raw_user_meta_data->>'timezone', 'Asia/Seoul')
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();


-- 2) 챌린지 기수(cohort) 테이블
--    "매달 정원을 새로 정해 재신청받는 기수제" 운영 방식에 맞춰 기수를 별도 관리.
--    나중에 SNS 콘텐츠나 "재신청률" 지표 계산 시에도 활용 가능.
create table public.cohorts (
  id uuid primary key default gen_random_uuid(),
  label text not null,          -- 예: "2026-09"
  start_date date not null,
  end_date date not null,
  created_at timestamptz not null default now()
);

alter table public.cohorts enable row level security;

-- 로그인한 사용자는 누구나 기수 목록 조회 가능 (신청 화면 등에서 필요)
create policy "select_cohorts_authenticated" on public.cohorts
  for select using (auth.role() = 'authenticated');

-- 리더만 기수 생성/수정/삭제 가능
create policy "leader_manage_cohorts" on public.cohorts
  for all using (public.is_leader()) with check (public.is_leader());

-- profiles.cohort_id를 cohorts 테이블과 실제로 연결
alter table public.profiles
  add constraint profiles_cohort_id_fkey foreign key (cohort_id) references public.cohorts(id);


-- 3) 하루 과제 제출 테이블 (Writing / Shadowing)
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


-- 4) 주간 피드백 테이블
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


-- 5) 커뮤니티 리더보드용 뷰
--    멤버는 본인 제출물만 볼 수 있지만(RLS), 랜딩/대시보드의 "커뮤니티 리더보드"는
--    다른 멤버의 완료율도 보여줘야 함. 그렇다고 다른 사람의 제출물 원본(사진/음성)을
--    그대로 노출하면 안 되니까, 완료 "횟수"만 미리 계산해서 보여주는 뷰를 따로 둠.
--    뷰는 기본적으로 테이블 소유자 권한으로 동작해서 RLS를 우회하지만,
--    이 뷰 자체가 노출하는 컬럼은 이름 + 완료 횟수뿐이라 안전함.
create or replace view public.leaderboard as
select
  p.id as member_id,
  p.name,
  count(s.id) filter (
    where s.date >= date_trunc('month', current_date)::date
      and s.diary_url is not null
      and s.shadowing_url is not null
  ) as completed_days
from public.profiles p
left join public.submissions s on s.member_id = p.id
where p.role = 'member'
group by p.id, p.name;

grant select on public.leaderboard to authenticated;


-- ============================================================
-- 참고: 첫 리더 계정 만드는 법
-- 1. 웹사이트에서 평소처럼 이메일로 회원가입을 한 번 합니다.
--    (자동으로 profiles 테이블에 role='member'로 등록됩니다)
-- 2. Supabase 왼쪽 메뉴 Table Editor → profiles 테이블에서
--    본인 행의 role 값을 'member'에서 'leader'로 직접 바꿔주세요.
-- 이후로는 그 계정으로 로그인하면 리더 대시보드가 보이게 됩니다.
--
-- 참고: 보류한 설계 결정
-- - cohort_id는 "현재 기수"만 저장하는 단순 구조. 한 멤버가 여러 달에 걸쳐
--   재신청하며 기수를 옮겨다니는 이력(재신청률 계산용)까지 추적하려면
--   cohort_memberships(member_id, cohort_id, joined_at) 같은 이력 테이블이
--   나중에 필요할 수 있음. 지금은 요청받은 필수 필드 범위로 최소화.
-- ============================================================
