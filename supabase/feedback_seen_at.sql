-- 멤버 대시보드의 "새 피드백(NEW)" 표시를 DB에 저장하기 위한 컬럼.
-- Supabase 대시보드 > SQL Editor에 붙여넣고 Run (한 번만 실행하면 됩니다).
--
-- 동작 방식:
--  * 리더가 보낸 피드백의 *_feedback_sent_at 이 feedback_seen_at 보다 늦으면 "새 피드백"
--  * 멤버가 그 날짜 카드를 실제로 화면에서 보면(또는 직접 펼치면) 앱이 feedback_seen_at 을 현재 시각으로 갱신
--  * 기기가 달라도 같은 상태가 유지됨 (예전에는 브라우저별로만 기억했음)
--  * 멤버 본인 행은 기존 RLS 정책(member_manage_own_submissions)으로 이미 수정 가능해서 정책/함수 추가는 필요 없음
--  * 리더 화면은 컬럼을 이름으로 골라 읽기 때문에 영향 없음

alter table public.submissions
  add column if not exists feedback_seen_at timestamptz;

-- 이미 보낸 기존 피드백은 "이미 본 것"으로 처리 (첫날 모든 옛 피드백에 NEW가 붙는 것을 방지)
update public.submissions
set feedback_seen_at = now()
where feedback_seen_at is null
  and (diary_feedback_sent_at is not null or shadowing_feedback_sent_at is not null);
