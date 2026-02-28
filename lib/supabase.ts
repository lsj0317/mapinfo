import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Supabase 프로젝트 URL과 anon key (.env에서 로드)
// 설정 방법: https://supabase.com 에서 무료 프로젝트 생성 후
// Settings > API > Project URL / anon public key 복사
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@env';

export const supabase = createClient(
  SUPABASE_URL || '',
  SUPABASE_ANON_KEY || '',
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  }
);

// 부동산 영업상태 값
export type SalesStatus = '미접촉' | '접촉' | '영업성공' | '영업실패' | '대기중' | '보류';

// 부동산 테이블 타입 (Supabase properties 테이블과 1:1 매핑)
export interface Property {
  property_id: string;       // 부동산 고유번호 (PK)
  lat: number;               // 위도
  lng: number;               // 경도
  parcel_address: string | null;    // 지번주소
  road_address: string | null;      // 도로명주소
  building_name: string | null;     // 건물명
  owner_name: string | null;        // 소유자명
  owner_address: string | null;     // 소유자 주소 (우편발송용)
  purpose: string | null;           // 건물용도
  area: number | null;              // 면적(㎡)
  floor_info: string | null;        // 층수정보
  registration_date: string | null; // 등기일자
  sales_status: SalesStatus;        // 영업상태
  sales_memo: string | null;        // 영업메모
  photo_urls: string[] | null;      // 현장 사진 URL 목록 (Supabase Storage)
  next_contact_date: string | null; // 다음 연락 예정일 (Push 알림용)
  notification_id: string | null;   // 스케줄된 알림 ID
  created_at?: string;
  updated_at?: string;
}

// 더미 데이터 (Supabase 미설정 시 또는 테스트용)
// 주소: 경기도 오산시 가수동 55-5 (가수행복로 일대)
export const DUMMY_PROPERTIES: Property[] = [
  {
    property_id: '1348-2024-999001',
    lat: 37.1496,
    lng: 127.0700,
    parcel_address: '경기도 오산시 가수동 55-5',
    road_address: '경기도 오산시 가수행복로 55-5',
    building_name: '가수행복 아파트 1202동',
    owner_name: '홍길동',
    owner_address: '경기도 오산시 가수동 55-5, 1202동 201호',
    purpose: '공동주택',
    area: 84.50,
    floor_info: '지하1층/지상15층',
    registration_date: '2020-03-15',
    sales_status: '미접촉',
    sales_memo: null,
  },
  {
    property_id: '1348-2024-999002',
    lat: 37.1510,
    lng: 127.0685,
    parcel_address: '경기도 오산시 가수동 101',
    road_address: '경기도 오산시 가수행복로 101',
    building_name: '오산 가수 공장',
    owner_name: '(주)오산산업',
    owner_address: '경기도 오산시 오산동 100, 산업빌딩 5층',
    purpose: '공장',
    area: 1250.00,
    floor_info: '지상2층',
    registration_date: '2015-07-22',
    sales_status: '미접촉',
    sales_memo: null,
  },
  {
    property_id: '1348-2024-999003',
    lat: 37.1480,
    lng: 127.0720,
    parcel_address: '경기도 오산시 가수동 88-3',
    road_address: '경기도 오산시 가수행복로 88-3',
    building_name: '가수물류창고',
    owner_name: '김창고',
    owner_address: '서울특별시 강남구 테헤란로 152, 강남파이낸스센터 10층',
    purpose: '창고',
    area: 3500.00,
    floor_info: '지상3층',
    registration_date: '2018-11-30',
    sales_status: '접촉',
    sales_memo: '2024-01 방문 완료, 관심 있음. 재방문 예정.',
  },
];