declare module '@env' {
  export const VWORLD_API_KEY: string;
  export const BACKEND_API_URL: string; // spring-backend 베이스 URL (Tilko 등기 조회 프록시)
  export const MOBILE_API_KEY: string; // spring-backend /api/mobile/** 인증용 (X-Mobile-Key)
  export const SUPABASE_URL: string;
  export const SUPABASE_ANON_KEY: string;
  export const KAKAO_API_KEY: string; // 카카오 로드뷰 (https://developers.kakao.com)
  export const GOOGLE_MAPS_API_KEY: string; // Google Maps JS API (Street View)
}
