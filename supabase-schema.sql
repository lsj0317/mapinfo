-- =============================================
-- 태양광 영업지원 앱 - Supabase 테이블 스키마
-- =============================================
-- Supabase 콘솔 > SQL Editor 에서 실행하세요.
-- https://supabase.com/dashboard > 프로젝트 선택 > SQL Editor

-- 부동산 정보 테이블
CREATE TABLE IF NOT EXISTS properties (
  property_id    TEXT PRIMARY KEY,           -- 부동산 고유번호 (등기부 pin)
  lat            DECIMAL(10, 7) NOT NULL,    -- 위도
  lng            DECIMAL(10, 7) NOT NULL,    -- 경도
  parcel_address TEXT,                       -- 지번주소
  road_address   TEXT,                       -- 도로명주소
  building_name  TEXT,                       -- 건물명
  owner_name     TEXT,                       -- 소유자명
  owner_address  TEXT,                       -- 소유자 주소 (우편발송용)
  purpose        TEXT,                       -- 건물용도 (공장/창고/물류/공동주택 등)
  area           DECIMAL(12, 2),             -- 면적(㎡)
  floor_info     TEXT,                       -- 층수정보
  registration_date TEXT,                    -- 등기일자 (YYYY-MM-DD)
  sales_status   TEXT NOT NULL DEFAULT '미접촉'
                   CHECK (sales_status IN ('미접촉','접촉','영업성공','영업실패','대기중','보류')),
  sales_memo     TEXT,                       -- 영업메모
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

-- updated_at 자동 갱신 함수
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- updated_at 자동 갱신 트리거
DROP TRIGGER IF EXISTS update_properties_updated_at ON properties;
CREATE TRIGGER update_properties_updated_at
  BEFORE UPDATE ON properties
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 위치 기반 검색을 위한 인덱스
CREATE INDEX IF NOT EXISTS idx_properties_location ON properties (lat, lng);
CREATE INDEX IF NOT EXISTS idx_properties_sales_status ON properties (sales_status);

-- =============================================
-- 더미 데이터 삽입 (테스트용)
-- =============================================
INSERT INTO properties (
  property_id, lat, lng,
  parcel_address, road_address, building_name,
  owner_name, owner_address,
  purpose, area, floor_info, registration_date,
  sales_status, sales_memo
) VALUES
(
  '1348-2024-999001',
  37.1496, 127.0700,
  '경기도 오산시 가수동 55-5',
  '경기도 오산시 가수행복로 55-5',
  '가수행복 아파트 1202동',
  '홍길동',
  '경기도 오산시 가수동 55-5, 1202동 201호',
  '공동주택', 84.50, '지하1층/지상15층', '2020-03-15',
  '미접촉', NULL
),
(
  '1348-2024-999002',
  37.1510, 127.0685,
  '경기도 오산시 가수동 101',
  '경기도 오산시 가수행복로 101',
  '오산 가수 공장',
  '(주)오산산업',
  '경기도 오산시 오산동 100, 산업빌딩 5층',
  '공장', 1250.00, '지상2층', '2015-07-22',
  '미접촉', NULL
),
(
  '1348-2024-999003',
  37.1480, 127.0720,
  '경기도 오산시 가수동 88-3',
  '경기도 오산시 가수행복로 88-3',
  '가수물류창고',
  '김창고',
  '서울특별시 강남구 테헤란로 152, 강남파이낸스센터 10층',
  '창고', 3500.00, '지상3층', '2018-11-30',
  '접촉', '2024-01 방문 완료, 관심 있음. 재방문 예정.'
)
ON CONFLICT (property_id) DO NOTHING;

-- =============================================
-- 온라인 등기 열람 이력 테이블 (registry_views)
-- 이미 열람한 주소 캐시 용도
-- =============================================
CREATE TABLE IF NOT EXISTS registry_views (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lat           DOUBLE PRECISION NOT NULL,       -- 위도
  lng           DOUBLE PRECISION NOT NULL,       -- 경도
  road_address  TEXT,                            -- 도로명주소
  jibun_address TEXT,                            -- 지번주소
  viewed_at     TIMESTAMPTZ DEFAULT now()        -- 열람일시
);

-- 좌표 범위 검색 인덱스
CREATE INDEX IF NOT EXISTS idx_registry_views_location ON registry_views (lat, lng);
CREATE INDEX IF NOT EXISTS idx_registry_views_viewed_at ON registry_views (viewed_at DESC);

-- =============================================
-- registry_views 소유자 정보 컬럼 추가
-- (이미 테이블이 있는 경우 이 ALTER TABLE만 실행)
-- =============================================
ALTER TABLE registry_views ADD COLUMN IF NOT EXISTS owner_name    TEXT;  -- 소유자 실명
ALTER TABLE registry_views ADD COLUMN IF NOT EXISTS owner_address TEXT;  -- 소유자 실거주지

-- =============================================
-- RLS (Row Level Security) 설정 (선택사항)
-- 단일 사용자이므로 비활성화 또는 간단하게 설정
-- =============================================
-- ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "모든 접근 허용" ON properties FOR ALL USING (true);
-- ALTER TABLE registry_views ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "모든 접근 허용" ON registry_views FOR ALL USING (true);
