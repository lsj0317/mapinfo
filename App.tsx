import './global.css';
import 'react-native-url-polyfill/auto';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
    StyleSheet, Text, View, SafeAreaView, TouchableOpacity,
    Platform, StatusBar, Alert, FlatList, Animated, Easing,
    ActivityIndicator, Dimensions, TextInput, Modal, ScrollView,
    Share, Image, Linking, AppState, AppStateStatus,
} from 'react-native';
import GoogleMapView, { GoogleMapHandle, type MapRegion as Region } from './GoogleMapView';
import KakaoSkyView, { type KakaoSkyViewHandle } from './KakaoSkyView';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { VWORLD_API_KEY, BACKEND_API_URL, MOBILE_API_KEY, KAKAO_API_KEY, GOOGLE_MAPS_API_KEY } from '@env';
import { supabase, type Property, type SalesStatus, type PlaceRecord, type PlaceStatus, type TargetType, type ProvinceRecord, type CityRecord } from './lib/supabase';
import { REGIONS, ZOOM_LEVEL, type ProvinceData, type CityData, type TownData } from './lib/regions';

// 선택적 패키지 (설치 필요: npx expo install expo-image-picker expo-notifications)
let ImagePicker: typeof import('expo-image-picker') | null = null;
let Notifications: typeof import('expo-notifications') | null = null;
try { ImagePicker = require('expo-image-picker'); } catch { /* expo-image-picker 미설치 */ }
// expo-notifications은 개발 빌드(npx expo run:android)에서만 동작
// Expo Go에서는 자동으로 비활성화
try {
    const n = require('expo-notifications');
    // Expo Go 환경 감지 (Constants.appOwnership === 'expo')
    const Constants = require('expo-constants').default;
    if (Constants?.appOwnership !== 'expo') {
        Notifications = n;
    }
} catch { /* expo-notifications 미설치 또는 Expo Go */ }

const RECENT_PLACES_KEY = 'recent_places';
const FAVORITE_PLACES_KEY = 'favorite_places';
const REGISTRY_CACHE_KEY = 'registry_cache';
const OFFLINE_QUEUE_KEY = 'offline_queue';
const BUILDING_FILTER_KEY = 'building_filter';
const NOTIFICATION_STORE_KEY = 'notification_store';
const ELDERLY_MODE_KEY = 'elderly_mode';
const NOTIFICATIONS_KEY = 'app_notifications';
const LAST_IMPROVEMENTS_COUNT_KEY = 'last_improvements_count';
const SELECTED_REGION_KEY = 'selected_region';
const RECENT_SEARCH_TERMS_KEY = 'recent_search_terms';
const LOCATION_INTRO_SEEN_KEY = 'location_intro_seen';

interface AppNotification {
    id: string;
    type: 'improvement' | 'favorite' | 'registry';
    message: string;
    timestamp: number;
    read: boolean;
}

async function addNotification(type: AppNotification['type'], message: string): Promise<void> {
    try {
        const json = await AsyncStorage.getItem(NOTIFICATIONS_KEY);
        const existing: AppNotification[] = json ? JSON.parse(json) : [];
        existing.unshift({ id: `notif-${Date.now()}`, type, message, timestamp: Date.now(), read: false });
        await AsyncStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(existing.slice(0, 100)));
    } catch {}
}

async function getUnreadNotificationCount(): Promise<number> {
    try {
        const json = await AsyncStorage.getItem(NOTIFICATIONS_KEY);
        if (!json) return 0;
        return (JSON.parse(json) as AppNotification[]).filter(n => !n.read).length;
    } catch { return 0; }
}

async function markAllNotificationsRead(): Promise<void> {
    try {
        const json = await AsyncStorage.getItem(NOTIFICATIONS_KEY);
        if (!json) return;
        const updated = (JSON.parse(json) as AppNotification[]).map(n => ({ ...n, read: true }));
        await AsyncStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(updated));
    } catch {}
}

// ===== Haversine 거리 계산 (미터 단위) =====

// "YY.MM.DD" 형식 (등기 열람일 표기 스펙)
function formatShortDate(iso: string): string {
    const d = new Date(iso);
    const yy = String(d.getFullYear()).slice(2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yy}.${mm}.${dd}`;
}

function formatDistance(meters: number): string {
    return meters >= 1000 ? `${(meters / 1000).toFixed(1)}km` : `${meters}m`;
}

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371e3;
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const dPhi = (lat2 - lat1) * Math.PI / 180;
    const dLam = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;
    return Math.floor(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// 태양광 설치 기준 면적 (㎡)
const SOLAR_MIN_AREA_MEDIUM = 500;  // 고잠재력 필터 기준

// ===== 고령자 모드 글꼴/사이즈 설정 =====

const FONT_SCALE = {
    normal: {
        xs: 11,
        sm: 12,
        md: 13,
        base: 14,
        lg: 15,
        xl: 16,
        '2xl': 17,
        '3xl': 18,
        '4xl': 24,
    },
    elderly: {
        xs: 14,
        sm: 15,
        md: 16,
        base: 17,
        lg: 18,
        xl: 20,
        '2xl': 22,
        '3xl': 24,
        '4xl': 30,
    },
};

const TOUCH_SIZE = {
    normal: { minHeight: 36, padding: 8 },
    elderly: { minHeight: 52, padding: 14 },
};

// ===== 디자인 토큰 (design_handoff_mapinfo_ux 스펙) =====
// 지도/영업/내정보 3탭 개편 시안의 색상·타이포·간격·라운드·그림자·터치 타깃 값.
// 화면별 세부 구현은 순차 반영하며, 신규 UI는 이 토큰을 우선 사용한다.

const COLORS = {
    primary: '#1B64DA',
    primaryTint: '#E8F0FE',
    primarySelectedBg: '#F4F8FE',
    ink: '#16181D',
    inkSub: '#3C434E',
    textMuted: '#5F6670',
    textOnDarkMuted: '#A7ADB6',
    line: '#E6E8EC',
    lineSoft: '#ECEEF1',
    lineSoft2: '#F1F3F6',
    surface: '#F5F7FA',
    white: '#FFFFFF',
    chevron: '#C3C8CE',
    success: '#157A38',
    successTint: '#E7F6EC',
    successTint2: '#EAF7EF',
    successBar: '#16A34A',
    warn: '#8A5A08',
    warnTint: '#FFF7E0',
    warnTint2: '#FFF3E4',
    warnAccent: '#F5A524',
    danger: '#B91C1C',
    dangerStrong: '#DC2626',
    dangerTint: '#FEF2F2',
    neutralBar: '#B6BCC4',
};

const TYPOGRAPHY = {
    screenTitleQuestion: { fontSize: 27, fontWeight: '700' as const, lineHeight: 38, letterSpacing: -0.7 },
    screenTitle: { fontSize: 26, fontWeight: '700' as const, letterSpacing: -0.6 },
    bigNumberXl: { fontSize: 44, fontWeight: '900' as const, letterSpacing: -1.5 },
    bigNumberLg: { fontSize: 34, fontWeight: '700' as const, letterSpacing: -1.2 },
    bigNumberMd: { fontSize: 28, fontWeight: '700' as const, letterSpacing: -1.0 },
    subHeader: { fontSize: 22, fontWeight: '700' as const, lineHeight: 32, letterSpacing: -0.5 },
    listTitle: { fontSize: 18, fontWeight: '700' as const },
    body: { fontSize: 16, fontWeight: '400' as const, lineHeight: 24 },
    bodyStrong: { fontSize: 17, fontWeight: '500' as const, lineHeight: 26 },
    caption: { fontSize: 15, fontWeight: '400' as const, lineHeight: 24 },
    chip: { fontSize: 14, fontWeight: '700' as const },
    tabLabel: { fontSize: 14, fontWeight: '500' as const },
    tabLabelActive: { fontSize: 14, fontWeight: '700' as const },
};

const SPACING = { xs: 6, sm: 8, md: 10, base: 12, lg: 14, xl: 16, xl2: 18, xl3: 20, xl4: 22, xl5: 24, xl6: 28, xl7: 36 };

const RADIUS = { frame: 28, sheet: 24, card: 18, button: 16, input: 14, chip: 10, pill: 999 };

const ELEVATION = {
    card: { shadowColor: '#101828', shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
    floating: { shadowColor: '#101828', shadowOpacity: 0.16, shadowRadius: 18, shadowOffset: { width: 0, height: 6 }, elevation: 6 },
    sheet: { shadowColor: '#101828', shadowOpacity: 0.14, shadowRadius: 24, shadowOffset: { width: 0, height: -6 }, elevation: 12 },
    primaryBtn: { shadowColor: '#1B64DA', shadowOpacity: 0.28, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 4 },
};

const TOUCH_TARGETS = { primaryButton: 62, secondaryButton: 56, recordListItem: 70, iconButton: 54, tabBar: 96 };

// React Query 클라이언트
const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            retry: 1,
            staleTime: 5 * 60 * 1000, // 5분
        },
    },
});

// ===== 타입 정의 =====

interface RegistryCacheItem {
    pnu: string;
    jibunAddr: string;
    uniqueNo: string;
    owner: string;
    address: string;
    cachedAt: number;
}

// ===== API 응답 타입 =====

interface VWorldAddress {
    road: string;
    parcel: string;
}

interface VWorldPoint {
    x: string;
    y: string;
}

interface VWorldPlaceItem {
    id: string;
    title: string;
    address: VWorldAddress;
    point: VWorldPoint;
    category?: string;
}

interface VWorldSearchResponse {
    response: {
        status: string;
        result?: {
            items: VWorldPlaceItem[];
        };
    };
}

interface VWorldFeatureProperties {
    UQ011?: string;   // 용도지역명
    JIMOK?: string;   // 지목명
    [key: string]: string | undefined;
}

interface VWorldFeature {
    properties: VWorldFeatureProperties;
}

interface DaumPostcodeData {
    roadAddress: string;
    jibunAddress: string;
    autoJibunAddress: string;
    [key: string]: string;
}

interface DaumWebViewMessageEvent {
    nativeEvent: { data: string };
}

// 등기 열람 이력 레코드 (registry_views 테이블)
interface RegistryViewRecord {
    id: string;
    lat: number;
    lng: number;
    road_address: string | null;
    jibun_address: string | null;
    owner_name: string | null;
    owner_address: string | null;
    xml_data: string | null;
    viewed_at: string;
    disabled_yn?: string | null;
}

// 토지이용계획 정보
type SolarFeasibilityLevel = 'favorable' | 'neutral' | 'restricted';

interface LandUseInfo {
    zoning: string;                      // 용도지역
    isSolarFeasible: boolean;
    feasibilityNote: string;
    feasibilityLevel: SolarFeasibilityLevel;
}

// 건물 필터 설정
interface BuildingFilter {
    minArea: number;                // 최소 면적 ㎡ (0 = 필터없음)
    selectedCategories: string[];   // 선택된 카테고리 (공장/창고/물류)
    onlyHighPotential: boolean;     // 고잠재력 (면적 500㎡+) 만 표시
}

const DEFAULT_FILTER: BuildingFilter = {
    minArea: 0,
    selectedCategories: ['공장', '창고', '물류'],
    onlyHighPotential: false,
};

// 마커 클러스터
interface PropertyCluster {
    id: string;
    coordinate: { latitude: number; longitude: number };
    count: number;
    items: Property[];
    dominantStatus: SalesStatus;
}

// 오프라인 큐 항목
interface OfflineQueueItem {
    id: string;
    type: 'updateSalesStatus' | 'saveIROSView';
    payload: Record<string, unknown>;
    queuedAt: number;
}

// 알림 저장소
interface NotificationStore {
    [propertyId: string]: {
        notificationId: string;
        scheduledDate: string;
    };
}

// 영업 동선 기록
interface ActivityLog {
    id: string;
    place_id: string | null; // uuid (places.id)
    lat: number;
    lng: number;
    address: string | null;
    visited_at: string;
    sales_status_at_visit: string | null;
    distance_from_prev_km: number;
    created_at?: string;
}

interface Building {
    id: string;
    name: string;
    address: string;
    distance: number;
    latitude: number;
    longitude: number;
    category?: string;
    timestamp?: number;
    propertyId?: string; // Supabase property_id 연결용
}

type MapType = 'standard' | 'cadastral' | 'satellite';

// 영업 대상 유형 필터 (전체/공단/민간주택)
type SalesTargetFilter = 'all' | 'industrial' | 'residential';



// purpose 필드로 유형을 추론하는 키워드 (target_type이 null인 기존 데이터 대응)
const INDUSTRIAL_KEYWORDS = ['공장', '공업', '창고', '물류', '산업', '제조', '작업'];
const RESIDENTIAL_KEYWORDS = ['주택', '아파트', '단독', '다가구', '빌라', '연립', '다세대', '공동주택'];

function inferTargetType(property: Property): TargetType {
    if (property.target_type) return property.target_type;
    const purpose = property.purpose || '';
    if (INDUSTRIAL_KEYWORDS.some(k => purpose.includes(k))) return 'industrial';
    if (RESIDENTIAL_KEYWORDS.some(k => purpose.includes(k))) return 'residential';
    return 'residential'; // 기본값: 민간주택
}

const SALES_TARGET_KEY = 'sales_target_filter';

const APP_VERSION = '1.0.0';

// 영업상태 목록
const SALES_STATUSES: SalesStatus[] = ['미접촉', '접촉', '영업성공', '영업실패', '대기중', '보류'];

const SALES_STATUS_COLORS: Record<SalesStatus, string> = {
    '미접촉': '#9E9E9E',
    '접촉':   '#2196F3',
    '영업성공': '#4CAF50',
    '영업실패': '#F44336',
    '대기중': '#FF9800',
    '보류':   '#9C27B0',
};

// ===== 캐시 헬퍼 =====

async function saveRegistryCache(lat: number, lng: number, data: RegistryCacheItem): Promise<void> {
    try {
        const jsonValue = await AsyncStorage.getItem(REGISTRY_CACHE_KEY);
        const cache: Record<string, RegistryCacheItem> = jsonValue ? JSON.parse(jsonValue) : {};
        const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
        cache[key] = { ...data, cachedAt: Date.now() };
        await AsyncStorage.setItem(REGISTRY_CACHE_KEY, JSON.stringify(cache));
    } catch (e) {
        console.error('Failed to save registry cache', e);
    }
}

async function getRegistryCache(lat: number, lng: number): Promise<RegistryCacheItem | null> {
    try {
        const jsonValue = await AsyncStorage.getItem(REGISTRY_CACHE_KEY);
        if (!jsonValue) return null;
        const cache: Record<string, RegistryCacheItem> = JSON.parse(jsonValue);
        const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
        return cache[key] || null;
    } catch (e) {
        return null;
    }
}

// ===== Supabase 쿼리 함수 =====

// Supabase에서 주변 매물 조회 (위도/경도 기반 ±0.02도 범위)
async function fetchPropertiesFromDB(lat: number, lng: number): Promise<Property[]> {
    const delta = 0.02;
    const { data, error } = await supabase
        .from('properties')
        .select('*')
        .gte('lat', lat - delta)
        .lte('lat', lat + delta)
        .gte('lng', lng - delta)
        .lte('lng', lng + delta);

    if (error) {
        console.warn('Supabase 조회 실패:', error.message);
        return [];
    }

    return data || [];
}

// Supabase 영업상태 업데이트
async function updateSalesStatus(propertyId: string, status: SalesStatus, memo: string | null): Promise<void> {
    const { error } = await supabase
        .from('properties')
        .update({ sales_status: status, sales_memo: memo })
        .eq('property_id', propertyId);

    if (error) {
        console.warn('Supabase 업데이트 실패:', error.message);
    }
}


// VWorld 역지오코딩: 위/경도 → 한글 주소
async function reverseGeocodeKorean(lat: number, lng: number): Promise<string> {
    try {
        const url = `https://api.vworld.kr/req/address?service=address&request=getAddress&version=2.0&crs=epsg:4326&point=${lng},${lat}&type=both&zipcode=false&simple=false&format=json&key=${VWORLD_API_KEY}`;
        const res = await fetch(url);
        const json = await res.json();
        if (json.response?.status === 'OK' && json.response?.result?.length > 0) {
            const road = (json.response.result as { type: string; text: string }[]).find(r => r.type === 'road');
            const parcel = (json.response.result as { type: string; text: string }[]).find(r => r.type === 'parcel');
            return (road?.text || parcel?.text || '').trim() || '주소 정보 없음';
        }
    } catch {}
    // 폴백: expo-location (영어일 수 있음)
    try {
        const fallback = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
        if (fallback.length > 0) {
            const a = fallback[0];
            return `${a.city || a.region || ''} ${a.district || ''} ${a.street || ''} ${a.name !== a.street ? (a.name || '') : ''}`.trim() || '주소 정보 없음';
        }
    } catch {}
    return '주소 정보 없음';
}

async function recordGPSVisit(lat: number, lng: number): Promise<void> {
    try {
        const today = new Date().toISOString().split('T')[0];
        const { data: last } = await supabase
            .from('activity_logs').select('lat,lng')
            .gte('visited_at', `${today}T00:00:00`)
            .order('visited_at', { ascending: false })
            .limit(1);
        let dist = 0;
        if (last?.length) dist = haversineDistance(last[0].lat, last[0].lng, lat, lng) / 1000;

        const { data: places } = await supabase.from('places').select('id,status,lat,lng');
        let placeId: string | null = null, statusAtVisit: string | null = null;
        for (const p of places || []) {
            if (haversineDistance(lat, lng, p.lat, p.lng) <= 100) {
                placeId = p.id; statusAtVisit = p.status; break;
            }
        }

        const address = await reverseGeocodeKorean(lat, lng);
        await supabase.from('activity_logs').insert({
            place_id: placeId, lat, lng, address,
            visited_at: new Date().toISOString(),
            sales_status_at_visit: statusAtVisit,
            distance_from_prev_km: dist,
        });
    } catch (e) { console.warn('GPS 기록 실패:', e); }
}

async function saveIROSView(payload: {
    lat: number;
    lng: number;
    road_address: string;
    jibun_address: string;
    owner_name?: string;
    owner_address?: string;
    xml_data?: string;
}): Promise<void> {
    try {
        await supabase.from('registry_views').insert([{
            ...payload,
            viewed_at: new Date().toISOString(),
        }]);
        await addNotification('registry', `등기부등본 열람: ${payload.road_address || payload.jibun_address || '주소 없음'}`);
    } catch (e) {
        console.warn('IROS 저장 실패:', e);
    }
}

// ===== Zustand 스토어 =====

interface MapStore {
    region: Region;
    setRegion: (region: Region) => void;

    buildings: Building[];
    isLoading: boolean;
    isLoadingMore: boolean;
    lastFetchedRegion: Region | null;
    page: number;
    hasMore: boolean;

    selectedMarker: Building | null;
    setSelectedMarker: (building: Building | null) => void;

    // Supabase 매물 마커
    propertyMarkers: Property[];
    setPropertyMarkers: (props: Property[]) => void;

    mapType: MapType;
    setMapType: (type: MapType) => void;

    // 스마트 필터
    buildingFilter: BuildingFilter;
    setBuildingFilter: (filter: BuildingFilter) => void;

    // 클러스터링 활성화 (줌 레벨 임계치 기반 자동 전환)
    clusteringEnabled: boolean;
    setClusteringEnabled: (enabled: boolean) => void;

    elderlyMode: boolean;
    setElderlyMode: (mode: boolean) => void;

    salesTargetFilter: SalesTargetFilter;
    setSalesTargetFilter: (filter: SalesTargetFilter) => void;

    tilkoBalance: number | null;      // Tilko API 포인트 잔액 (null=미조회)
    setTilkoBalance: (balance: number | null) => void;

    // 지적도 기준 부지 면적 캐시 (좌표키 → 조회 결과)
    parcelAreas: Record<string, { landAreaM2: number; fetchedAt: number }>;
    setParcelArea: (key: string, landAreaM2: number) => void;

    // 목록 정렬/면적 하한 필터 (화면 12·13 공용)
    listSort: 'distance' | 'area';
    setListSort: (sort: 'distance' | 'area') => void;
    minAreaM2: number | null;
    setMinAreaM2: (min: number | null) => void;

    fetchBuildings: (region: Region, page?: number) => Promise<void>;
    saveRecentPlace: (building: Building) => Promise<void>;
    saveFavoritePlace: (building: Building) => Promise<void>;
    removeRecentPlace: (id: string) => Promise<void>;
    removeFavoritePlace: (id: string) => Promise<void>;
}

const useMapStore = create<MapStore>((set, get) => ({
    region: {
        latitude: 37.5665,
        longitude: 126.9780,
        latitudeDelta: 0.002,
        longitudeDelta: 0.002,
    },
    setRegion: (region) => set({ region }),

    buildings: [],
    isLoading: false,
    isLoadingMore: false,
    lastFetchedRegion: null,
    page: 1,
    hasMore: true,

    selectedMarker: null,
    setSelectedMarker: (building) => set({ selectedMarker: building }),

    propertyMarkers: [],
    setPropertyMarkers: (props) => set({ propertyMarkers: props }),

    mapType: 'standard',
    setMapType: (type) => set({ mapType: type }),

    buildingFilter: DEFAULT_FILTER,
    setBuildingFilter: (filter) => {
        set({ buildingFilter: filter });
        AsyncStorage.setItem(BUILDING_FILTER_KEY, JSON.stringify(filter)).catch(() => {});
    },

    clusteringEnabled: true,
    setClusteringEnabled: (enabled) => set({ clusteringEnabled: enabled }),

    elderlyMode: false,
    setElderlyMode: (mode) => {
        set({ elderlyMode: mode });
        AsyncStorage.setItem(ELDERLY_MODE_KEY, JSON.stringify(mode)).catch(console.warn);
    },

    salesTargetFilter: 'all',
    setSalesTargetFilter: (filter) => {
        set({ salesTargetFilter: filter });
        AsyncStorage.setItem(SALES_TARGET_KEY, filter).catch(() => {});
    },

    tilkoBalance: null,
    setTilkoBalance: (balance) => set({ tilkoBalance: balance }),

    parcelAreas: {},
    setParcelArea: (key, landAreaM2) => set(state => ({
        parcelAreas: { ...state.parcelAreas, [key]: { landAreaM2, fetchedAt: Date.now() } },
    })),

    listSort: 'distance',
    setListSort: (sort) => set({ listSort: sort }),
    minAreaM2: null,
    setMinAreaM2: (min) => set({ minAreaM2: min }),

    fetchBuildings: async (currentRegion: Region, page = 1) => {
        const isFirstPage = page === 1;
        if (isFirstPage) {
            set({ isLoading: true, hasMore: true });
        } else {
            set({ isLoadingMore: true });
        }

        try {
            const RADIUS_DEGREE = 0.01;
            const minx = currentRegion.longitude - RADIUS_DEGREE;
            const maxx = currentRegion.longitude + RADIUS_DEGREE;
            const miny = currentRegion.latitude - RADIUS_DEGREE;
            const maxy = currentRegion.latitude + RADIUS_DEGREE;
            const bbox = `${minx},${miny},${maxx},${maxy}`;

            const FACTORY_KEYWORDS = ['공장', '창고', '물류'];
            const pagePerKeyword = Math.ceil(page / FACTORY_KEYWORDS.length);

            const responses = await Promise.all(
                FACTORY_KEYWORDS.map(keyword =>
                    fetch(`https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=10&page=${pagePerKeyword}&query=${encodeURIComponent(keyword)}&type=place&format=json&errorformat=json&bbox=${bbox}&key=${VWORLD_API_KEY}`)
                        .then(r => r.json())
                        .catch(() => null)
                )
            );

            const existingIds = isFirstPage ? new Set<string>() : new Set(get().buildings.map(b => b.id));
            const existingNames = isFirstPage ? new Set<string>() : new Set(get().buildings.map(b => b.name));
            const newBuildings: Building[] = [];
            let totalItemCount = 0;

            responses.forEach((json: VWorldSearchResponse | null) => {
                if (!json || json.response.status === "NOT_FOUND" || !json.response.result) return;
                const items = json.response.result.items;
                totalItemCount += items.length;

                items.forEach((item: VWorldPlaceItem) => {
                    if (existingIds.has(item.id) || existingNames.has(item.title)) return;

                    const itemLat = parseFloat(item.point.y);
                    const itemLng = parseFloat(item.point.x);
                    const distance = haversineDistance(currentRegion.latitude, currentRegion.longitude, itemLat, itemLng);

                    if (distance > 1000) return;

                    existingIds.add(item.id);
                    existingNames.add(item.title);

                    const rawCategory: string = item.category || '';
                    let category = '';
                    if (rawCategory.includes('공장') || rawCategory.includes('제조')) category = '공장';
                    else if (rawCategory.includes('창고') || rawCategory.includes('보관')) category = '창고';
                    else if (rawCategory.includes('물류')) category = '물류';
                    else if (rawCategory) category = rawCategory.split('>').pop()?.trim() || '';

                    newBuildings.push({
                        id: item.id,
                        name: item.title,
                        address: item.address.road || item.address.parcel,
                        distance,
                        latitude: itemLat,
                        longitude: itemLng,
                        category,
                    });
                });
            });

            newBuildings.sort((a, b) => a.distance - b.distance);

            let finalBuildings = newBuildings;
            if (isFirstPage && newBuildings.length === 0) {
                const fallbackRes = await fetch(`https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=20&page=1&query=${encodeURIComponent('산업')}&type=place&format=json&errorformat=json&bbox=${bbox}&key=${VWORLD_API_KEY}`);
                const fallbackJson = await fallbackRes.json();
                if (fallbackJson.response.status === 'OK' && fallbackJson.response.result) {
                    fallbackJson.response.result.items.forEach((item: VWorldPlaceItem) => {
                        const itemLat = parseFloat(item.point.y);
                        const itemLng = parseFloat(item.point.x);
                        const distance = haversineDistance(currentRegion.latitude, currentRegion.longitude, itemLat, itemLng);
                        if (distance > 1000) return;
                        finalBuildings.push({
                            id: item.id,
                            name: item.title,
                            address: item.address.road || item.address.parcel,
                            distance,
                            latitude: itemLat,
                            longitude: itemLng,
                        });
                    });
                    finalBuildings.sort((a, b) => a.distance - b.distance);
                }
            }

            const allBuildings = isFirstPage ? finalBuildings : [...get().buildings, ...finalBuildings];
            set({
                buildings: allBuildings,
                isLoading: false,
                isLoadingMore: false,
                lastFetchedRegion: currentRegion,
                page,
                hasMore: totalItemCount >= 10,
            });
        } catch (error) {
            console.error("API Error:", error);
            set({ isLoading: false, isLoadingMore: false });
        }
    },

    saveRecentPlace: async (building: Building) => {
        try {
            const jsonValue = await AsyncStorage.getItem(RECENT_PLACES_KEY);
            let places: Building[] = jsonValue != null ? JSON.parse(jsonValue) : [];
            places = places.filter(p => p.id !== building.id);
            places.unshift({ ...building, timestamp: Date.now() });
            if (places.length > 50) places = places.slice(0, 50);
            await AsyncStorage.setItem(RECENT_PLACES_KEY, JSON.stringify(places));
        } catch (e) { console.error("Failed to save recent place", e); }
    },

    saveFavoritePlace: async (building: Building) => {
        try {
            const jsonValue = await AsyncStorage.getItem(FAVORITE_PLACES_KEY);
            let places: Building[] = jsonValue != null ? JSON.parse(jsonValue) : [];
            if (places.some(p => p.id === building.id)) {
                Alert.alert("알림", "이미 즐겨찾기에 등록된 장소입니다.");
                return;
            }
            places.unshift({ ...building, timestamp: Date.now() });
            await AsyncStorage.setItem(FAVORITE_PLACES_KEY, JSON.stringify(places));
            Alert.alert("성공", "즐겨찾기에 추가되었습니다.");
        } catch (e) { console.error("Failed to save favorite place", e); }
    },

    removeRecentPlace: async (id: string) => {
        try {
            const jsonValue = await AsyncStorage.getItem(RECENT_PLACES_KEY);
            let places: Building[] = jsonValue != null ? JSON.parse(jsonValue) : [];
            places = places.filter(p => p.id !== id);
            await AsyncStorage.setItem(RECENT_PLACES_KEY, JSON.stringify(places));
        } catch (e) { console.error("Failed to remove recent place", e); }
    },

    removeFavoritePlace: async (id: string) => {
        try {
            const jsonValue = await AsyncStorage.getItem(FAVORITE_PLACES_KEY);
            let places: Building[] = jsonValue != null ? JSON.parse(jsonValue) : [];
            places = places.filter(p => p.id !== id);
            await AsyncStorage.setItem(FAVORITE_PLACES_KEY, JSON.stringify(places));
        } catch (e) { console.error("Failed to remove favorite place", e); }
    },
}));

// ===== Tilko API 함수 =====

/**
 * Supabase tilko_balance 테이블에서 잔액 조회
 */
async function fetchTilkoBalanceFromDB(): Promise<number | null> {
    try {
        const { data, error } = await supabase
            .from('tilko_balance')
            .select('balance, updated_at')
            .eq('id', 1)
            .single();
        if (error || !data) return null;
        return typeof data.balance === 'number' ? data.balance : null;
    } catch {
        return null;
    }
}

/**
 * Supabase tilko_balance 테이블에 잔액 저장 + 사용이력 기록
 */
async function updateTilkoBalanceInDB(
    balanceAfter: number,
    action: string = 'refresh',
    balanceBefore?: number
): Promise<void> {
    try {
        await supabase
            .from('tilko_balance')
            .upsert({ id: 1, balance: balanceAfter, updated_at: new Date().toISOString() });
        await supabase.from('tilko_usage_logs').insert({
            action,
            balance_before: balanceBefore ?? null,
            balance_after: balanceAfter,
        });
    } catch {
        // DB 저장 실패 시 무시 (잔액 조회 자체는 성공)
    }
}

/**
 * spring-backend 모바일 프록시 공통 헤더/에러 처리.
 * Tilko/IROS 자격증명은 서버에만 있고, 앱은 BACKEND_API_URL을 통해서만 등기를 조회한다.
 */
async function callBackendRegistryApi<T>(path: string, options: { method?: 'GET' | 'POST'; body?: object; timeoutMs?: number } = {}): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
    let res: Response;
    try {
        res = await fetch(`${BACKEND_API_URL}${path}`, {
            method: options.method ?? 'GET',
            headers: {
                'X-Mobile-Key': MOBILE_API_KEY,
                'Content-Type': 'application/json',
            },
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeoutId);
    }

    const json = await res.json();
    if (!res.ok) {
        throw new Error(json.error || '등기정보 조회 실패');
    }
    return json as T;
}

/**
 * Tilko API 포인트 잔액 조회 (spring-backend 경유)
 * → 결과를 DB에 저장하고 반환
 */
async function fetchTilkoBalance(): Promise<number | null> {
    try {
        const json = await callBackendRegistryApi<{ pointBalance: number | null }>('/api/mobile/registry/balance');
        if (typeof json.pointBalance === 'number') {
            await updateTilkoBalanceInDB(json.pointBalance, 'api_refresh');
            return json.pointBalance;
        }
        return null;
    } catch {
        return null;
    }
}

async function fetchRegistryInfo(pin: string): Promise<{ owner: string; address: string; xmlData: string; pointBalance: number | null }> {
    const json = await callBackendRegistryApi<{ owner: string; address: string; xmlData: string; pointBalance: number | null }>(
        '/api/mobile/registry/fetch',
        { method: 'POST', body: { pin }, timeoutMs: 150000 }
    );

    // 호출부(등기 조회 3곳)가 반환된 pointBalance로 'post_registry' DB 갱신을 직접 수행함
    return {
        owner: json.owner || '정보 없음',
        address: json.address || '정보 없음',
        xmlData: json.xmlData || '',
        pointBalance: json.pointBalance,
    };
}

async function geocodeAddressToCoord(address: string): Promise<{ lat: number; lng: number } | null> {
    const types = ['ROAD', 'PARCEL'];
    for (const type of types) {
        try {
            const url = `https://api.vworld.kr/req/address?service=address&request=getCoord&version=2.0&crs=EPSG:4326&address=${encodeURIComponent(address)}&refine=true&simple=false&format=json&type=${type}&key=${VWORLD_API_KEY}`;
            const res = await fetch(url);
            const json = await res.json();
            if (json.response?.status === 'OK' && json.response?.result?.point) {
                return {
                    lat: parseFloat(json.response.result.point.y),
                    lng: parseFloat(json.response.result.point.x),
                };
            }
        } catch (_) {}
    }
    return null;
}

// ===== 토지이용계획 API (VWorld) =====

async function fetchLandUseInfo(lat: number, lng: number): Promise<LandUseInfo> {
    const defaultResult: LandUseInfo = {
        zoning: '',
        isSolarFeasible: true,
        feasibilityNote: '정보를 불러올 수 없습니다',
        feasibilityLevel: 'neutral',
    };

    try {
        // VWorld 용도지역 데이터 조회 (LT_C_UQ111)
        const url = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LT_C_UQ111&geometry=false&attribute=true&key=${VWORLD_API_KEY}&geomfilter=POINT(${lng}+${lat})&crs=EPSG:4326&format=json&size=1`;
        const res = await fetch(url);
        const json = await res.json();

        let zoning = '';
        if (json.response?.status === 'OK') {
            const features: VWorldFeature[] = json.response?.result?.featureCollection?.features || [];
            if (features.length > 0) {
                zoning = features[0].properties.UQ011 || features[0].properties.uq011 || '';
            }
        }

        // 태양광 설치 가능성 판단
        const restrictedKeywords = ['보전녹지', '자연환경보전', '개발제한'];
        const favorableKeywords = ['공업', '계획관리', '생산관리', '농림'];
        const limitedKeywords = ['농림', '자연녹지', '생산녹지'];

        let isSolarFeasible = true;
        let feasibilityNote = '';
        let feasibilityLevel: SolarFeasibilityLevel = 'neutral';

        if (!zoning) {
            feasibilityNote = '용도지역 정보를 확인할 수 없습니다';
            feasibilityLevel = 'neutral';
        } else if (restrictedKeywords.some(k => zoning.includes(k))) {
            isSolarFeasible = false;
            feasibilityNote = '설치 제한 가능성 높음 (관할청 확인 필요)';
            feasibilityLevel = 'restricted';
        } else if (favorableKeywords.some(k => zoning.includes(k)) && !limitedKeywords.some(k => zoning.includes(k))) {
            feasibilityNote = '태양광 설치에 유리한 용도지역';
            feasibilityLevel = 'favorable';
        } else if (limitedKeywords.some(k => zoning.includes(k))) {
            feasibilityNote = '이격거리 규제 등 조건부 가능';
            feasibilityLevel = 'neutral';
        } else if (zoning.includes('주거') || zoning.includes('상업')) {
            feasibilityNote = '지붕형 설치 가능 (건물 유형 확인 필요)';
            feasibilityLevel = 'neutral';
        } else {
            feasibilityNote = '관할 기관에 설치 가능 여부 확인 필요';
            feasibilityLevel = 'neutral';
        }

        return { zoning, isSolarFeasible, feasibilityNote, feasibilityLevel };
    } catch (_) {
        return defaultResult;
    }
}

// 위경도 폴리곤(외곽선)의 면적을 평면 근사(슈라이스 공식)로 계산 (㎡)
function polygonAreaM2(ring: number[][]): number {
    if (ring.length < 3) return 0;
    const originLat = ring[0][1];
    const mPerDegLat = 111320;
    const mPerDegLng = 111320 * Math.cos(originLat * Math.PI / 180);
    const pts = ring.map(([lng, lat]) => [lng * mPerDegLng, lat * mPerDegLat]);
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[(i + 1) % pts.length];
        sum += x1 * y2 - x2 * y1;
    }
    return Math.abs(sum) / 2;
}

// 지적도 기준 대지(부지) 면적 조회 (VWorld 연속지적도 LP_PA_CBND_BUBUN, 폴리곤 geometry로 면적 직접 계산)
async function fetchParcelArea(lat: number, lng: number): Promise<{ landAreaM2: number } | null> {
    try {
        const url = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&geometry=true&attribute=false&geomfilter=POINT(${lng}+${lat})&crs=EPSG:4326&format=json&size=1&key=${VWORLD_API_KEY}`;
        const res = await fetch(url);
        const json = await res.json();
        if (json.response?.status !== 'OK') return null;
        const features = json.response?.result?.featureCollection?.features || [];
        if (features.length === 0) return null;
        const geom = features[0].geometry;
        const outerRing: number[][] | undefined = geom?.type === 'MultiPolygon' ? geom.coordinates?.[0]?.[0] : geom?.coordinates?.[0];
        if (!outerRing || outerRing.length < 3) return null;
        const areaM2 = polygonAreaM2(outerRing);
        if (!areaM2 || !isFinite(areaM2)) return null;
        return { landAreaM2: Math.round(areaM2) };
    } catch (_) {
        return null;
    }
}

// ㎡ → 평 변환 (정수 반올림)
function sqmToPyeong(sqm: number): number {
    return Math.round(sqm / 3.3058);
}

// ===== 오프라인 큐 =====

async function addToOfflineQueue(type: OfflineQueueItem['type'], payload: Record<string, unknown>): Promise<void> {
    try {
        const json = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
        const queue: OfflineQueueItem[] = json ? JSON.parse(json) : [];
        queue.push({ id: `q-${Date.now()}`, type, payload, queuedAt: Date.now() });
        await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
    } catch (e) {
        console.error('Queue add failed', e);
    }
}

async function syncOfflineQueue(): Promise<number> {
    try {
        const json = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
        if (!json) return 0;
        const queue: OfflineQueueItem[] = JSON.parse(json);
        if (queue.length === 0) return 0;

        const failed: OfflineQueueItem[] = [];
        for (const item of queue) {
            try {
                if (item.type === 'updateSalesStatus') {
                    const { propertyId, status, memo } = item.payload as { propertyId: string; status: SalesStatus; memo: string | null };
                    await updateSalesStatus(propertyId, status, memo);
                } else if (item.type === 'saveIROSView') {
                    await saveIROSView(item.payload as Parameters<typeof saveIROSView>[0]);
                }
            } catch {
                failed.push(item);
            }
        }
        await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(failed));
        return queue.length - failed.length;
    } catch {
        return 0;
    }
}

// ===== 마커 클러스터링 알고리즘 =====

function clusterProperties(properties: Property[], latitudeDelta: number): PropertyCluster[] {
    const cellSize = latitudeDelta * 1.2;
    if (cellSize <= 0 || properties.length === 0) return [];

    // Grid-based spatial hashing: O(n) instead of O(n²)
    const grid = new Map<string, Property[]>();
    for (const prop of properties) {
        const key = `${Math.floor(prop.lat / cellSize)},${Math.floor(prop.lng / cellSize)}`;
        const cell = grid.get(key);
        if (cell) cell.push(prop);
        else grid.set(key, [prop]);
    }

    const clusters: PropertyCluster[] = [];
    for (const [, items] of grid) {
        const avgLat = items.reduce((s, p) => s + p.lat, 0) / items.length;
        const avgLng = items.reduce((s, p) => s + p.lng, 0) / items.length;

        const counts: Record<string, number> = {};
        for (const p of items) {
            counts[p.sales_status] = (counts[p.sales_status] || 0) + 1;
        }
        let maxCount = 0;
        let dominantStatus: SalesStatus = '미접촉';
        for (const [status, count] of Object.entries(counts)) {
            if (count > maxCount) { maxCount = count; dominantStatus = status as SalesStatus; }
        }

        clusters.push({
            id: `cluster-${items[0].property_id}`,
            coordinate: { latitude: avgLat, longitude: avgLng },
            count: items.length,
            items,
            dominantStatus,
        });
    }
    return clusters;
}

// ===== 사진 업로드 (Supabase Storage) =====

async function uploadPropertyPhoto(propertyId: string, imageUri: string): Promise<string | null> {
    try {
        const response = await fetch(imageUri);
        const blob = await response.blob();
        const ext = imageUri.split('.').pop()?.toLowerCase() || 'jpg';
        const fileName = `${propertyId}/${Date.now()}.${ext}`;

        const { data, error } = await supabase.storage
            .from('property-photos')
            .upload(fileName, blob, { contentType: `image/${ext}`, upsert: false });

        if (error) throw error;

        const { data: { publicUrl } } = supabase.storage
            .from('property-photos')
            .getPublicUrl(data.path);

        return publicUrl;
    } catch (e) {
        console.error('Photo upload failed', e);
        return null;
    }
}

async function deletePropertyPhoto(path: string): Promise<void> {
    const fileName = path.split('/property-photos/')[1];
    if (!fileName) return;
    await supabase.storage.from('property-photos').remove([fileName]);
}

async function updatePropertyPhotoUrls(propertyId: string, urls: string[]): Promise<void> {
    await supabase.from('properties')
        .update({ photo_urls: urls })
        .eq('property_id', propertyId);
}

// ===== Push 알림 스케줄링 =====

async function scheduleFollowUpNotification(
    propertyId: string,
    propertyName: string,
    date: Date,
): Promise<string | null> {
    if (!Notifications) {
        Alert.alert('알림 불가', 'expo-notifications 패키지 설치가 필요합니다.\nnpx expo install expo-notifications');
        return null;
    }
    try {
        const { status } = await Notifications.requestPermissionsAsync();
        if (status !== 'granted') {
            Alert.alert('권한 거부', '알림 권한이 필요합니다. 설정에서 허용해 주세요.');
            return null;
        }

        const notifId = await Notifications.scheduleNotificationAsync({
            content: {
                title: '태양광 영업 리마인더',
                body: `${propertyName} - 오늘이 연락 예정일입니다`,
                data: { propertyId },
                sound: true,
            },
            trigger: { date, type: 'date' } as import('expo-notifications').DateTriggerInput,
        });

        // 알림 ID 저장
        const storeJson = await AsyncStorage.getItem(NOTIFICATION_STORE_KEY);
        const store: NotificationStore = storeJson ? JSON.parse(storeJson) : {};
        store[propertyId] = { notificationId: notifId, scheduledDate: date.toISOString() };
        await AsyncStorage.setItem(NOTIFICATION_STORE_KEY, JSON.stringify(store));

        return notifId;
    } catch (e: any) {
        Alert.alert('알림 설정 실패', e.message);
        return null;
    }
}

async function cancelFollowUpNotification(propertyId: string): Promise<void> {
    if (!Notifications) return;
    try {
        const storeJson = await AsyncStorage.getItem(NOTIFICATION_STORE_KEY);
        if (!storeJson) return;
        const store: NotificationStore = JSON.parse(storeJson);
        const entry = store[propertyId];
        if (entry?.notificationId) {
            await Notifications.cancelScheduledNotificationAsync(entry.notificationId);
            delete store[propertyId];
            await AsyncStorage.setItem(NOTIFICATION_STORE_KEY, JSON.stringify(store));
        }
    } catch { }
}

async function getScheduledNotification(propertyId: string): Promise<{ notificationId: string; scheduledDate: string } | null> {
    try {
        const storeJson = await AsyncStorage.getItem(NOTIFICATION_STORE_KEY);
        if (!storeJson) return null;
        const store: NotificationStore = JSON.parse(storeJson);
        return store[propertyId] || null;
    } catch {
        return null;
    }
}

async function restoreScheduledNotifications(): Promise<void> {
    if (!Notifications) return;
    try {
        const { status } = await Notifications.getPermissionsAsync();
        if (status !== 'granted') return;
        const { data } = await supabase
            .from('properties')
            .select('property_id, building_name, road_address, sales_status, next_contact_date')
            .in('sales_status', ['보류', '대기중'])
            .not('next_contact_date', 'is', null);
        if (!data || data.length === 0) return;
        const storeJson = await AsyncStorage.getItem(NOTIFICATION_STORE_KEY);
        const store: NotificationStore = storeJson ? JSON.parse(storeJson) : {};
        const scheduled = await Notifications.getAllScheduledNotificationsAsync();
        const scheduledIds = new Set((scheduled as { identifier: string }[]).map(n => n.identifier));
        let changed = false;
        for (const prop of data as Array<{ property_id: string; building_name: string | null; road_address: string | null; sales_status: SalesStatus; next_contact_date: string }>) {
            const contactDate = new Date(prop.next_contact_date);
            if (contactDate <= new Date()) continue;
            const entry = store[prop.property_id];
            if (!entry || !scheduledIds.has(entry.notificationId)) {
                const name = prop.building_name || prop.road_address || '매물';
                const label = prop.sales_status === '보류' ? '재방문' : '연락';
                const notifId = await Notifications.scheduleNotificationAsync({
                    content: {
                        title: `${prop.sales_status} 매물 ${label} 예정일`,
                        body: `${name} - 오늘이 ${label} 예정일입니다`,
                        data: { propertyId: prop.property_id },
                        sound: true,
                    },
                    trigger: { date: contactDate, type: 'date' } as Parameters<typeof Notifications.scheduleNotificationAsync>[0]['trigger'],
                });
                store[prop.property_id] = { notificationId: notifId, scheduledDate: contactDate.toISOString() };
                changed = true;
            }
        }
        if (changed) await AsyncStorage.setItem(NOTIFICATION_STORE_KEY, JSON.stringify(store));
    } catch (e) { console.warn('알림 복원 실패:', e); }
}

async function fetchPNU(lat: number, lng: number): Promise<{ pnu: string; jibunAddr: string }> {
    const url = `https://api.vworld.kr/req/address?service=address&request=getAddress&version=2.0&crs=EPSG:4326&point=${lng},${lat}&type=PARCEL&format=json&key=${VWORLD_API_KEY}`;
    const response = await fetch(url);
    const json = await response.json();
    if (json.response.status !== 'OK' || !json.response.result) {
        throw new Error('해당 위치의 PNU 정보를 조회할 수 없습니다.');
    }
    const result = json.response.result[0];
    const structure = result.structure;
    const level5 = structure.level5 || '0-0';
    const parts = level5.split('-');
    const cleanNum = (s: string) => s.replace(/[^0-9]/g, '') || '0';
    const bon = cleanNum(parts[0] || '0').padStart(4, '0');
    const bu = cleanNum(parts[1] || '0').padStart(4, '0');
    const pnu = `${structure.level4LC}1${bon}${bu}`;
    return { pnu, jibunAddr: result.text };
}

async function fetchUniqueNoByAddress(addr: string): Promise<{ uniqueNo: string; realtyType: string; addrFull: string; isSpecial: boolean }[]> {
    const json = await callBackendRegistryApi<{ candidates: { uniqueNo: string; realtyType: string; addrFull: string; special: boolean }[] }>(
        '/api/mobile/registry/search',
        { method: 'POST', body: { address: addr } }
    );
    if (!json.candidates || json.candidates.length === 0) {
        throw new Error('해당 주소에 대한 등기 정보를 찾을 수 없습니다.');
    }
    return json.candidates.map(c => ({
        uniqueNo: c.uniqueNo,
        realtyType: c.realtyType,
        addrFull: c.addrFull,
        isSpecial: c.special,
    }));
}

// ===== 온라인 상태 훅 =====

function useOnlineStatus(): boolean {
    const [isOnline, setIsOnline] = useState(true);

    useEffect(() => {
        let mounted = true;
        const check = async () => {
            // AbortSignal.timeout은 Hermes에서 미지원 → 수동 AbortController 사용
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            try {
                await fetch('https://dapi.kakao.com', {
                    method: 'HEAD',
                    cache: 'no-store',
                    signal: controller.signal,
                });
                clearTimeout(timer);
                if (mounted) setIsOnline(true);
            } catch {
                clearTimeout(timer);
                if (mounted) setIsOnline(false);
            }
        };

        check();
        const interval = setInterval(check, 60000);
        return () => { mounted = false; clearInterval(interval); };
    }, []);

    return isOnline;
}

// ===== 오프라인 배너 컴포넌트 =====

// GPS 버튼 반대편(왼쪽) 말풍선 형태 온/오프라인 표시
const NetworkBubble = React.memo(({ isOnline }: { isOnline: boolean }) => {
    const [prevOnline, setPrevOnline] = useState(isOnline);
    const [showOnline, setShowOnline] = useState(false);
    const fadeAnim = useRef(new Animated.Value(isOnline ? 0 : 1)).current;
    const onlineFadeAnim = useRef(new Animated.Value(0)).current;
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (prevOnline === isOnline) return;
        setPrevOnline(isOnline);

        if (isOnline) {
            // 오프라인 버블 숨기기
            Animated.timing(fadeAnim, { toValue: 0, duration: 300, useNativeDriver: true }).start();
            // 온라인 버블 잠깐 표시 후 사라짐
            setShowOnline(true);
            Animated.sequence([
                Animated.timing(onlineFadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }),
                Animated.delay(2000),
                Animated.timing(onlineFadeAnim, { toValue: 0, duration: 400, useNativeDriver: true }),
            ]).start(() => setShowOnline(false));
        } else {
            // 오프라인 버블 표시
            Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }).start();
        }
    }, [isOnline]);

    return (
        <>
            {/* 오프라인 말풍선 */}
            {!isOnline && (
                <Animated.View style={[offlineStyles.bubble, offlineStyles.offlineBubble, { opacity: fadeAnim }]} pointerEvents="none">
                    <Text style={offlineStyles.bubbleText}>오프라인</Text>
                    <View style={offlineStyles.offlineTail} />
                </Animated.View>
            )}
            {/* 온라인 전환 말풍선 */}
            {showOnline && (
                <Animated.View style={[offlineStyles.bubble, offlineStyles.onlineBubble, { opacity: onlineFadeAnim }]} pointerEvents="none">
                    <Text style={offlineStyles.bubbleText}>온라인</Text>
                    <View style={offlineStyles.onlineTail} />
                </Animated.View>
            )}
        </>
    );
});


const offlineStyles = StyleSheet.create({
    bubble: {
        position: 'absolute',
        bottom: 135,
        left: 16,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: 1,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.15,
        shadowRadius: 4,
        elevation: 6,
        zIndex: 20,
    },
    offlineBubble: { backgroundColor: '#18181B', borderColor: '#DC2626' },
    onlineBubble: { backgroundColor: '#18181B', borderColor: '#27272A' },
    bubbleText: { color: '#FAFAFA', fontSize: 11, fontWeight: '500' },
    offlineTail: {
        position: 'absolute',
        bottom: -7,
        left: 18,
        width: 0,
        height: 0,
        borderLeftWidth: 7,
        borderRightWidth: 7,
        borderTopWidth: 8,
        borderLeftColor: 'transparent',
        borderRightColor: 'transparent',
        borderTopColor: '#18181B',
    },
    onlineTail: {
        position: 'absolute',
        bottom: -7,
        left: 18,
        width: 0,
        height: 0,
        borderLeftWidth: 7,
        borderRightWidth: 7,
        borderTopWidth: 8,
        borderLeftColor: 'transparent',
        borderRightColor: 'transparent',
        borderTopColor: '#18181B',
    },
});

// ===== Google Street View 모달 =====

function buildStreetViewHTML(lat: number, lng: number, googleKey: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    html,body{width:100%;height:100%;background:#000;}
    #pano{width:100%;height:100%;}
    #fallback{display:none;padding:40px 20px;color:#fff;text-align:center;font-size:15px;background:#222;height:100%;justify-content:center;align-items:center;flex-direction:column;}
    #fallback-icon{font-size:48px;margin-bottom:16px;}
  </style>
</head>
<body>
  <div id="pano"></div>
  <div id="fallback">
    <div id="fallback-icon" style="font-size:48px;margin-bottom:16px;color:#888;">--</div>
    <p>이 위치에서는 실제이미지를 제공하지 않습니다.<br><small style="color:#aaa;margin-top:8px;display:block;">건물 외부 또는 주요 도로 주변으로 이동해 다시 시도하세요.</small></p>
  </div>
  <script>
    function initMap() {
      try {
        var sv = new google.maps.StreetViewService();
        sv.getPanorama({ location: { lat: ${lat}, lng: ${lng} }, radius: 50 }, function(data, status) {
          if (status === 'OK') {
            new google.maps.StreetViewPanorama(document.getElementById('pano'), {
              position: { lat: ${lat}, lng: ${lng} },
              pov: { heading: 34, pitch: 10 },
              zoom: 1,
              addressControl: false,
              enableCloseButton: false,
            });
          } else {
            document.getElementById('pano').style.display='none';
            document.getElementById('fallback').style.display='flex';
          }
        });
      } catch(e) {
        document.getElementById('pano').style.display='none';
        document.getElementById('fallback').style.display='flex';
        document.getElementById('fallback-icon').innerText='!';
        document.querySelector('#fallback p').innerText='로드 오류: '+e.message;
      }
    }
  </script>
  <script src="https://maps.googleapis.com/maps/api/js?key=${googleKey}&callback=initMap" async defer></script>
</body>
</html>`;
}

const StreetViewModal = React.memo(({
    visible,
    onClose,
    latitude,
    longitude,
    title,
    buildingName,
}: {
    visible: boolean;
    onClose: () => void;
    latitude: number;
    longitude: number;
    title?: string;
    buildingName?: string;
}) => {
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const googleKey = GOOGLE_MAPS_API_KEY || '';
    const html = useMemo(
        () => buildStreetViewHTML(latitude, longitude, googleKey),
        [latitude, longitude, googleKey],
    );

    return (
        <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
            <View style={{ flex: 1, backgroundColor: '#000' }}>
                {!googleKey ? (
                    <View style={svStyles.noKey}>
                        <Text style={svStyles.noKeyText}>
                            .env에 GOOGLE_MAPS_API_KEY를 설정해 주세요.{'\n'}
                            (Google Cloud Console → Maps JavaScript API 키)
                        </Text>
                    </View>
                ) : (
                    <WebView
                        source={{ html, baseUrl: 'https://maps.googleapis.com' }}
                        style={{ flex: 1 }}
                        javaScriptEnabled
                        domStorageEnabled
                        originWhitelist={['*']}
                        mixedContentMode="always"
                        startInLoadingState
                        renderLoading={() => (
                            <View style={svStyles.loading}>
                                <ActivityIndicator color="#fff" size="large" />
                                <Text style={{ color: '#fff', marginTop: 12 }}>실제이미지 불러오는 중...</Text>
                            </View>
                        )}
                    />
                )}

                {/* 오버레이 헤더: 닫기 + 주소 */}
                <SafeAreaView style={{ position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.xl3, paddingTop: SPACING.base }}>
                    <TouchableOpacity
                        onPress={onClose}
                        style={{ width: 56, height: 56, borderRadius: RADIUS.card, backgroundColor: 'rgba(22,24,29,0.72)', alignItems: 'center', justifyContent: 'center' }}
                        accessibilityLabel="닫기"
                        accessibilityRole="button"
                    >
                        <Text style={{ fontSize: 22, color: COLORS.white, fontWeight: '700' }}>{'×'}</Text>
                    </TouchableOpacity>
                    <View style={{ flex: 1, height: 56, marginLeft: SPACING.base, borderRadius: RADIUS.card, backgroundColor: 'rgba(22,24,29,0.72)', justifyContent: 'center', paddingHorizontal: SPACING.xl2 }}>
                        <Text style={{ fontSize: fs.lg, fontWeight: '700', color: COLORS.white }} numberOfLines={1}>
                            {title || '주소 정보 없음'}
                        </Text>
                    </View>
                </SafeAreaView>

                {/* 하단 확인 카드 */}
                <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: COLORS.white, borderTopLeftRadius: RADIUS.sheet - 2, borderTopRightRadius: RADIUS.sheet - 2, padding: SPACING.xl3, paddingBottom: SPACING.xl5 }}>
                    <Text style={{ fontSize: fs.sm, color: COLORS.textMuted }}>이 건물이 맞나요?</Text>
                    <Text style={{ fontSize: fs.xl + 4, fontWeight: '700', color: COLORS.ink, marginTop: 4, marginBottom: SPACING.xl2 }} numberOfLines={1}>
                        {buildingName || title || '건물 정보 없음'}
                    </Text>
                    <View style={{ flexDirection: 'row', gap: SPACING.base }}>
                        <TouchableOpacity
                            onPress={onClose}
                            style={{ flex: 1, height: 56, borderRadius: RADIUS.button, borderWidth: 1.5, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' }}
                            accessibilityLabel="다시 보기"
                            accessibilityRole="button"
                        >
                            <Text style={{ fontSize: fs.lg, fontWeight: '700', color: COLORS.inkSub }}>다시 보기</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            onPress={onClose}
                            style={{ flex: 1, height: 56, borderRadius: RADIUS.button, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' }}
                            accessibilityLabel="맞아요"
                            accessibilityRole="button"
                        >
                            <Text style={{ fontSize: fs.lg, fontWeight: '700', color: COLORS.white }}>맞아요</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        </Modal>
    );
});

const svStyles = StyleSheet.create({
    loading: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' },
    noKey: { flex: 1, backgroundColor: '#111', justifyContent: 'center', alignItems: 'center', padding: 32 },
    noKeyText: { color: '#fff', fontSize: 14, lineHeight: 24, textAlign: 'center' },
});

const FILTER_CATEGORIES = ['공장', '창고', '물류'];

// ===== 사진 섹션 컴포넌트 (PropertyDetailModal 내부) =====

const PhotoSection = ({
    property,
    onPhotosUpdated,
}: {
    property: Property;
    onPhotosUpdated: (urls: string[]) => void;
}) => {
    const [photos, setPhotos] = useState<string[]>(property.photo_urls || []);
    const [isUploading, setIsUploading] = useState(false);

    const handlePickImage = async () => {
        if (!ImagePicker) {
            Alert.alert(
                '패키지 필요',
                'expo-image-picker가 필요합니다.\n\nnpx expo install expo-image-picker\n\n설치 후 앱을 재시작하세요.',
            );
            return;
        }
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') {
            Alert.alert('권한 필요', '사진 접근 권한이 필요합니다.');
            return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            quality: 0.7,
            allowsMultipleSelection: false,
        });
        if (result.canceled || !result.assets[0]) return;

        setIsUploading(true);
        try {
            const url = await uploadPropertyPhoto(property.property_id, result.assets[0].uri);
            if (url) {
                const updated = [...photos, url];
                setPhotos(updated);
                await updatePropertyPhotoUrls(property.property_id, updated);
                onPhotosUpdated(updated);
            }
        } catch (e: any) {
            Alert.alert('업로드 실패', e.message);
        } finally {
            setIsUploading(false);
        }
    };

    const handleDeletePhoto = (url: string) => {
        Alert.alert('사진 삭제', '이 사진을 삭제하시겠습니까?', [
            { text: '취소', style: 'cancel' },
            {
                text: '삭제',
                style: 'destructive',
                onPress: async () => {
                    const updated = photos.filter(p => p !== url);
                    setPhotos(updated);
                    await Promise.all([
                        updatePropertyPhotoUrls(property.property_id, updated),
                        deletePropertyPhoto(url),
                    ]);
                    onPhotosUpdated(updated);
                },
            },
        ]);
    };

    return (
        <View style={photoStyles.section}>
            <View style={photoStyles.sectionHeader}>
                <Text style={styles.propSectionTitle}>현장 사진</Text>
                <TouchableOpacity
                    style={[photoStyles.addBtn, isUploading && { opacity: 0.5 }]}
                    onPress={handlePickImage}
                    disabled={isUploading}
                >
                    {isUploading
                        ? <ActivityIndicator size="small" color="#fff" />
                        : <Text style={photoStyles.addBtnText}>+ 추가</Text>
                    }
                </TouchableOpacity>
            </View>

            {photos.length === 0 ? (
                <Text style={photoStyles.empty}>현장 사진이 없습니다</Text>
            ) : (
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    {photos.map((url, idx) => (
                        <TouchableOpacity
                            key={idx}
                            onLongPress={() => handleDeletePhoto(url)}
                            style={photoStyles.photoWrap}
                        >
                            <Image source={{ uri: url }} style={photoStyles.photo} />
                            <View style={photoStyles.deleteHint}>
                                <Text style={photoStyles.deleteHintText}>길게 눌러 삭제</Text>
                            </View>
                        </TouchableOpacity>
                    ))}
                </ScrollView>
            )}
        </View>
    );
};

const photoStyles = StyleSheet.create({
    section: {
        backgroundColor: '#F4F4F5',
        borderRadius: 8,
        padding: 14,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: '#E4E4E7',
    },
    sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
    addBtn: { backgroundColor: '#18181B', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 },
    addBtnText: { color: '#FAFAFA', fontSize: 12, fontWeight: '500' },
    empty: { fontSize: 12, color: '#A1A1AA', textAlign: 'center', paddingVertical: 16 },
    photoWrap: { marginRight: 10, borderRadius: 8, overflow: 'hidden' },
    photo: { width: 100, height: 100, borderRadius: 8 },
    deleteHint: { backgroundColor: 'rgba(0,0,0,0.4)', paddingVertical: 3, alignItems: 'center' },
    deleteHintText: { color: '#fff', fontSize: 10 },
});

// ===== 알림 스케줄 섹션 (PropertyDetailModal 내부) =====

const NotificationSection = ({ property, salesStatus }: { property: Property; salesStatus?: SalesStatus }) => {
    const [scheduledInfo, setScheduledInfo] = useState<{ notificationId: string; scheduledDate: string } | null>(null);
    const [showDatePicker, setShowDatePicker] = useState(false);
    const [dateInput, setDateInput] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        getScheduledNotification(property.property_id).then(setScheduledInfo);
    }, [property.property_id]);

    const currentStatus = salesStatus ?? property.sales_status;
    const isFollowUpStatus = currentStatus === '보류' || currentStatus === '대기중';

    const handleSchedule = async () => {
        const parsed = new Date(dateInput);
        if (isNaN(parsed.getTime())) {
            Alert.alert('날짜 오류', 'YYYY-MM-DD 형식으로 입력해 주세요.\n예: 2025-03-15');
            return;
        }
        if (parsed <= new Date()) {
            Alert.alert('날짜 오류', '미래 날짜를 입력해 주세요.');
            return;
        }
        setIsSaving(true);
        const name = property.building_name || property.road_address || '매물';
        const notifId = await scheduleFollowUpNotification(property.property_id, name, parsed);
        if (notifId) {
            const info = { notificationId: notifId, scheduledDate: parsed.toISOString() };
            setScheduledInfo(info);
            // next_contact_date DB 업데이트
            await supabase.from('properties').update({
                next_contact_date: parsed.toISOString(),
                notification_id: notifId,
            }).eq('property_id', property.property_id);
            Alert.alert('알림 설정 완료', `${parsed.toLocaleDateString('ko-KR')}에 알림이 예약되었습니다.`);
            setShowDatePicker(false);
        }
        setIsSaving(false);
    };

    const handleCancel = async () => {
        await cancelFollowUpNotification(property.property_id);
        await supabase.from('properties').update({ next_contact_date: null, notification_id: null }).eq('property_id', property.property_id);
        setScheduledInfo(null);
        Alert.alert('알림 취소', '예약된 알림이 취소되었습니다.');
    };

    return (
        <View style={notifStyles.section}>
            <Text style={styles.propSectionTitle}>연락 예정 알림</Text>

            {isFollowUpStatus && !scheduledInfo && (
                <View style={{ backgroundColor: '#FEF3C7', borderRadius: 6, padding: 10, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ fontSize: 14 }}>💡</Text>
                    <Text style={{ fontSize: 12, color: '#92400E', flex: 1 }}>
                        {currentStatus === '보류' ? '보류 매물입니다. 재방문 예정일 알림을 설정하세요.' : '대기중 매물입니다. 연락 예정일 알림을 설정하세요.'}
                    </Text>
                </View>
            )}

            {scheduledInfo ? (
                <View style={notifStyles.scheduledBox}>
                    <Text style={notifStyles.scheduledIcon}>N</Text>
                    <View style={{ flex: 1 }}>
                        <Text style={notifStyles.scheduledDate}>
                            {new Date(scheduledInfo.scheduledDate).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })}
                        </Text>
                        <Text style={notifStyles.scheduledSub}>알림 예약됨</Text>
                    </View>
                    <TouchableOpacity onPress={handleCancel} style={notifStyles.cancelBtn}>
                        <Text style={notifStyles.cancelBtnText}>취소</Text>
                    </TouchableOpacity>
                </View>
            ) : showDatePicker ? (
                <View style={notifStyles.pickerBox}>
                    <TextInput
                        style={notifStyles.dateInput}
                        placeholder="YYYY-MM-DD (예: 2025-03-15)"
                        value={dateInput}
                        onChangeText={setDateInput}
                        keyboardType="numeric"
                        maxLength={10}
                    />
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                        <TouchableOpacity style={notifStyles.cancelTextBtn} onPress={() => setShowDatePicker(false)}>
                            <Text style={{ color: '#888' }}>취소</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[notifStyles.confirmBtn, isSaving && { opacity: 0.6 }]}
                            onPress={handleSchedule}
                            disabled={isSaving}
                        >
                            {isSaving ? <ActivityIndicator size="small" color="#fff" /> : <Text style={notifStyles.confirmBtnText}>알림 예약</Text>}
                        </TouchableOpacity>
                    </View>
                </View>
            ) : (
                <TouchableOpacity style={notifStyles.addBtn} onPress={() => setShowDatePicker(true)}>
                    <Text style={notifStyles.addBtnText}>연락 예정일 알림 설정</Text>
                </TouchableOpacity>
            )}
        </View>
    );
};

const notifStyles = StyleSheet.create({
    section: { backgroundColor: '#F4F4F5', borderRadius: 8, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#E4E4E7' },
    scheduledBox: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    scheduledIcon: { fontSize: 16, color: '#18181B', fontWeight: '700' },
    scheduledDate: { fontSize: 14, fontWeight: '600', color: '#18181B' },
    scheduledSub: { fontSize: 11, color: '#71717A', marginTop: 2 },
    cancelBtn: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#18181B', borderRadius: 6 },
    cancelBtnText: { color: '#FAFAFA', fontSize: 11, fontWeight: '500' },
    addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#18181B', borderRadius: 8, paddingVertical: 12 },
    addBtnText: { color: '#FAFAFA', fontSize: 13, fontWeight: '500' },
    pickerBox: {},
    dateInput: { borderWidth: 1, borderColor: '#E4E4E7', borderRadius: 8, padding: 10, fontSize: 14, backgroundColor: '#fff' },
    cancelTextBtn: { flex: 1, alignItems: 'center', paddingVertical: 10 },
    confirmBtn: { flex: 2, backgroundColor: '#18181B', borderRadius: 6, alignItems: 'center', paddingVertical: 10 },
    confirmBtnText: { color: '#FAFAFA', fontWeight: '600', fontSize: 13 },
});

// ===== PropertyDetailModal (Supabase 연동 영업관리 모달) =====

const PropertyDetailModal = ({
    visible,
    onClose,
    property,
}: {
    visible: boolean;
    onClose: () => void;
    property: Property | null;
}) => {
    const qc = useQueryClient();
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const ts = elderlyMode ? TOUCH_SIZE.elderly : TOUCH_SIZE.normal;
    const [editStatus, setEditStatus] = useState<SalesStatus>('미접촉');
    const [editMemo, setEditMemo] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        if (property) {
            setEditStatus(property.sales_status);
            setEditMemo(property.sales_memo || '');
        }
    }, [property]);

    const handleSave = async () => {
        if (!property) return;
        setIsSaving(true);
        try {
            await updateSalesStatus(property.property_id, editStatus, editMemo || null);
            // React Query 캐시 무효화
            qc.invalidateQueries({ queryKey: ['properties'] });
            Alert.alert('저장 완료', `영업상태가 '${editStatus}'로 저장되었습니다.`);
            onClose();
        } catch (e: any) {
            Alert.alert('저장 실패', e.message);
        } finally {
            setIsSaving(false);
        }
    };

    if (!property) return null;

    const statusColor = SALES_STATUS_COLORS[property.sales_status] || '#9E9E9E';

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            <View style={styles.modalOverlay}>
                <View style={[styles.modalContent, { maxHeight: Dimensions.get('window').height * 0.88 }]}>
                    {/* 헤더 */}
                    <View style={styles.propModalHeader}>
                        <Text style={[styles.propModalTitle, { fontSize: fs['2xl'] }]} numberOfLines={1}
                            accessibilityRole="header"
                        >
                            {property.building_name || property.road_address || '부동산 정보'}
                        </Text>
                        <View style={[styles.statusBadge, { backgroundColor: statusColor }, elderlyMode && { paddingHorizontal: 14, paddingVertical: 6 }]}>
                            <Text style={[styles.statusBadgeText, { fontSize: fs.sm }]}>{property.sales_status}</Text>
                        </View>
                    </View>

                    <ScrollView showsVerticalScrollIndicator={false}>
                        {/* 등기부등본 정보 섹션 */}
                        <View style={styles.propSection}>
                            <Text style={styles.propSectionTitle}>등기부등본 정보</Text>

                            <View style={styles.propRow}>
                                <Text style={styles.propLabel}>도로명주소</Text>
                                <Text style={styles.propValue}>{property.road_address || '-'}</Text>
                            </View>
                            <View style={styles.propRow}>
                                <Text style={styles.propLabel}>지번주소</Text>
                                <Text style={styles.propValue}>{property.parcel_address || '-'}</Text>
                            </View>
                            <View style={styles.propRow}>
                                <Text style={styles.propLabel}>부동산번호</Text>
                                <Text style={styles.propValue}>{property.property_id}</Text>
                            </View>
                            <View style={styles.propRow}>
                                <Text style={styles.propLabel}>소유자명</Text>
                                <Text style={[styles.propValue, { color: '#1565C0', fontWeight: '700' }]}>
                                    {property.owner_name || '-'}
                                </Text>
                            </View>
                            <View style={styles.propRow}>
                                <Text style={styles.propLabel}>소유자 주소</Text>
                                <Text style={[styles.propValue, { color: '#1565C0' }]}>
                                    {property.owner_address || '-'}
                                </Text>
                            </View>
                            <View style={styles.propRow}>
                                <Text style={styles.propLabel}>건물용도</Text>
                                <Text style={styles.propValue}>{property.purpose || '-'}</Text>
                            </View>
                            <View style={styles.propRow}>
                                <Text style={styles.propLabel}>면적</Text>
                                <Text style={styles.propValue}>
                                    {property.area ? `${property.area} ㎡` : '-'}
                                </Text>
                            </View>
                            <View style={styles.propRow}>
                                <Text style={styles.propLabel}>층수정보</Text>
                                <Text style={styles.propValue}>{property.floor_info || '-'}</Text>
                            </View>
                            <View style={styles.propRow}>
                                <Text style={styles.propLabel}>등기일자</Text>
                                <Text style={styles.propValue}>{property.registration_date || '-'}</Text>
                            </View>
                            <View style={styles.propRow}>
                                <Text style={styles.propLabel}>좌표</Text>
                                <Text style={styles.propValue}>
                                    {property.lat.toFixed(6)}, {property.lng.toFixed(6)}
                                </Text>
                            </View>
                        </View>

                        {/* 우편 발송 안내 */}
                        {property.owner_address && (
                            <View style={[styles.propSection, { backgroundColor: '#E3F2FD' }]}>
                                <Text style={styles.propSectionTitle}>우편 발송 주소</Text>
                                <Text style={{ fontSize: 14, color: '#1565C0', lineHeight: 22 }}>
                                    수신: {property.owner_name}{'\n'}
                                    주소: {property.owner_address}
                                </Text>
                            </View>
                        )}

                        {/* 현장 사진 */}
                        <PhotoSection
                            property={property}
                            onPhotosUpdated={(urls) => {
                                // React Query 캐시 무효화로 자동 반영
                                qc.invalidateQueries({ queryKey: ['properties'] });
                            }}
                        />

                        {/* 연락 예정 알림 */}
                        <NotificationSection property={property} salesStatus={editStatus} />

                        {/* 영업상태 관리 섹션 */}
                        <View style={styles.propSection}>
                            <Text style={styles.propSectionTitle}>영업상태 관리</Text>

                            <View style={[styles.statusGrid, elderlyMode && { gap: 10 }]}>
                                {SALES_STATUSES.map(s => (
                                    <TouchableOpacity
                                        key={s}
                                        style={[
                                            styles.statusChip,
                                            { borderColor: SALES_STATUS_COLORS[s] },
                                            elderlyMode && { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 24, borderWidth: 2 },
                                            editStatus === s && { backgroundColor: SALES_STATUS_COLORS[s] },
                                        ]}
                                        onPress={() => setEditStatus(s)}
                                        accessibilityLabel={`영업상태 ${s} ${editStatus === s ? '선택됨' : ''}`}
                                        accessibilityRole="button"
                                        accessibilityState={{ selected: editStatus === s }}
                                    >
                                        <Text style={[
                                            styles.statusChipText,
                                            { color: editStatus === s ? '#fff' : SALES_STATUS_COLORS[s], fontSize: fs.md },
                                        ]}>
                                            {s}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </View>

                            <Text style={styles.propLabel}>영업메모</Text>
                            <TextInput
                                style={styles.memoInput}
                                placeholder="메모를 입력하세요..."
                                value={editMemo}
                                onChangeText={setEditMemo}
                                multiline
                                numberOfLines={4}
                                textAlignVertical="top"
                            />
                        </View>
                    </ScrollView>

                    {/* 버튼 영역 */}
                    <View style={styles.propModalButtons}>
                        <TouchableOpacity
                            style={[styles.propCancelButton, elderlyMode && { paddingVertical: 18 }]}
                            onPress={onClose}
                            accessibilityLabel="닫기"
                            accessibilityRole="button"
                        >
                            <Text style={[styles.propCancelButtonText, { fontSize: fs.lg }]}>닫기</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.propSaveButton, elderlyMode && { paddingVertical: 18 }, isSaving && { opacity: 0.6 }]}
                            onPress={handleSave}
                            disabled={isSaving}
                            accessibilityLabel="영업상태 저장"
                            accessibilityRole="button"
                        >
                            {isSaving ? (
                                <ActivityIndicator color="#fff" size="small" />
                            ) : (
                                <Text style={[styles.propSaveButtonText, { fontSize: fs.lg }]}>저장</Text>
                            )}
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        </Modal>
    );
};

// ===== 등기부등본 XML 뷰어 =====

function extractXmlField(xml: string, field: string): string {
    const cdataMatch = xml.match(new RegExp(`<${field}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${field}>`));
    if (cdataMatch) return cdataMatch[1].trim();
    const plainMatch = xml.match(new RegExp(`<${field}>([^<]*)<\\/${field}>`));
    return plainMatch ? plainMatch[1].trim() : '';
}

// 화면 15 "쉬운 말 요약" 헬퍼: 등기 접수일에서 "YYYY년 M월 D일" 추출
function extractRegistryDate(receve: string): string {
    const m = receve.match(/\d{4}년\s*\d{1,2}월\s*\d{1,2}일/);
    return m ? m[0].replace(/\s+/g, ' ') : (receve.split('\n')[0] || '').trim();
}

// "권리자 및 기타사항" 텍스트에서 소유자명 추출 (fetchRegistryInfo와 동일 규칙)
function extractOwnerNameFromNomprs(nomprs: string): string {
    const m = nomprs.match(/소유자\s+([^\s]+)/);
    return m ? m[1] : '소유자 미상';
}

// "채권최고액 금000,000,000원" → 억/만원 단위로 반올림 표기
function extractMortgageAmount(nomprs: string): string | null {
    const m = nomprs.match(/채권최고액\s*금?\s*([\d,]+)\s*원/);
    if (!m) return null;
    const amount = parseInt(m[1].replace(/,/g, ''), 10);
    if (!amount) return null;
    if (amount >= 100000000) return `${Math.round(amount / 100000000).toLocaleString()}억원`;
    return `${Math.round(amount / 10000).toLocaleString()}만원`;
}

function parseRegistryXml(xmlData: string) {
    const registerMatch = xmlData.match(/<register>([\s\S]*?)<\/register>/);
    const src = registerMatch ? registerMatch[1] : xmlData;
    const items: Array<{ type: string; xml: string }> = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRe.exec(src)) !== null) {
        const typeM = m[1].match(/<type>([^<]+)<\/type>/);
        if (typeM && typeM[1].trim() !== 'EN') items.push({ type: typeM[1].trim(), xml: m[1] });
    }
    const header = (() => {
        const i = items.find(x => x.type === 'I');
        if (!i) return { address: '', pinNo: '', issDate: '', jurisdiction: '', balDate: '' };
        return {
            address: extractXmlField(i.xml, 'address') || extractXmlField(i.xml, 'wksbi_address'),
            pinNo: extractXmlField(i.xml, 'pin_no') || extractXmlField(i.xml, 'a301pin'),
            issDate: extractXmlField(i.xml, 'iss_date'),
            jurisdiction: extractXmlField(i.xml, 'wksbi_jrisdiction_office'),
            balDate: extractXmlField(i.xml, 'wksbi_cur_date'),
        };
    })();
    return {
        header,
        buildingTitles: items.filter(x => x.type === 'W').map(x => ({
            indi_no: extractXmlField(x.xml, 'wksbw_indi_no'),
            receve: extractXmlField(x.xml, 'wksbw_receve'),
            real_indi_cont: extractXmlField(x.xml, 'wksbw_real_indi_cont'),
            buld_cont: extractXmlField(x.xml, 'wksbw_buld_cont'),
            caus: extractXmlField(x.xml, 'wksbw_caus_and_etc'),
            cont: extractXmlField(x.xml, 'wksbw_common_flag'),
        })),
        landTitles: [
            ...items.filter(x => x.type === 'T').map(x => ({
                indi_no: extractXmlField(x.xml, 'wksbt_indi_no'),
                receve: extractXmlField(x.xml, 'wksbt_receve'),
                real_indi_cont: extractXmlField(x.xml, 'wksbt_real_indi_cont'),
                land_type: extractXmlField(x.xml, 'wksbt_land_type'),
                area: extractXmlField(x.xml, 'wksbt_area'),
                caus: extractXmlField(x.xml, 'wksbt_caus_and_etc'),
                cont: extractXmlField(x.xml, 'wksbt_common_flag'),
            })),
            ...items.filter(x => x.type === 'X').map(x => ({
                indi_no: extractXmlField(x.xml, 'wksbx_indi_no'),
                receve: '',
                real_indi_cont: extractXmlField(x.xml, 'wksbx_real_indi_cont'),
                land_type: extractXmlField(x.xml, 'wksbx_land_type'),
                area: extractXmlField(x.xml, 'wksbx_area'),
                caus: extractXmlField(x.xml, 'wksbx_caus_and_etc'),
                cont: extractXmlField(x.xml, 'wksbx_common_flag'),
            })),
        ],
        exclusiveParts: items.filter(x => x.type === 'Y').map(x => ({
            indi_no: extractXmlField(x.xml, 'wksby_indi_no'),
            receve: extractXmlField(x.xml, 'wksby_receve'),
            build_no: extractXmlField(x.xml, 'wksby_build_no'),
            buld_cont: extractXmlField(x.xml, 'wksby_buld_cont'),
            caus: extractXmlField(x.xml, 'wksby_caus_and_etc'),
            cont: extractXmlField(x.xml, 'wksby_common_flag'),
        })),
        landRights: items.filter(x => x.type === 'Z').map(x => ({
            indi_no: extractXmlField(x.xml, 'wksbz_indi_no'),
            lot_type: extractXmlField(x.xml, 'wksbz_lot_type'),
            lot_num: extractXmlField(x.xml, 'wksbz_lot_num'),
            caus: extractXmlField(x.xml, 'wksbz_caus_and_etc'),
            cont: extractXmlField(x.xml, 'wksbz_common_flag'),
        })),
        gapgu: items.filter(x => x.type === 'K').map(x => ({
            rank_no: extractXmlField(x.xml, 'wksbk_kap_rank_no'),
            aim_cont: extractXmlField(x.xml, 'wksbk_rgs_aim_cont'),
            receve: extractXmlField(x.xml, 'wksbk_receve'),
            rgs_caus: extractXmlField(x.xml, 'wksbk_rgs_caus'),
            nomprs: extractXmlField(x.xml, 'wksbk_nomprs_and_etc'),
            cont: extractXmlField(x.xml, 'wksbk_common_flag'),
        })),
        eulgu: items.filter(x => x.type === 'L' || x.type === 'M').map(x => ({
            rank_no: extractXmlField(x.xml, 'wksbl_eul_rank_no') || extractXmlField(x.xml, 'wksbm_rank_no'),
            aim_cont: extractXmlField(x.xml, 'wksbl_rgs_aim_cont') || extractXmlField(x.xml, 'wksbm_aim_cont'),
            receve: extractXmlField(x.xml, 'wksbl_receve') || extractXmlField(x.xml, 'wksbm_receve'),
            rgs_caus: extractXmlField(x.xml, 'wksbl_rgs_caus') || extractXmlField(x.xml, 'wksbm_rgs_caus'),
            nomprs: extractXmlField(x.xml, 'wksbl_nomprs_and_etc') || extractXmlField(x.xml, 'wksbm_nomprs'),
            cont: extractXmlField(x.xml, 'wksbl_common_flag') || extractXmlField(x.xml, 'wksbm_common_flag'),
        })),
    };
}

const RegistryXmlModal: React.FC<{ visible: boolean; onClose: () => void; xmlData: string }> = ({ visible, onClose, xmlData }) => {
    const { height: H } = Dimensions.get('window');
    if (!xmlData) return null;
    const d = parseRegistryXml(xmlData);

    const SectionHeader = ({ title, sub }: { title: string; sub?: string }) => (
        <View style={rxs.sectionHeader}>
            <Text style={rxs.sectionHeaderText}>{title}</Text>
            {sub ? <Text style={rxs.sectionHeaderSub}>{sub}</Text> : null}
        </View>
    );

    const THead = ({ cols }: { cols: Array<{ label: string; flex: number }> }) => (
        <View style={[rxs.row, { backgroundColor: '#ECEFF1' }]}>
            {cols.map((c, i) => (
                <View key={i} style={[rxs.cell, { flex: c.flex }, i === cols.length - 1 ? { borderRightWidth: 0 } : null]}>
                    <Text style={[rxs.cellTxt, { fontWeight: '700', textAlign: 'center' }]}>{c.label}</Text>
                </View>
            ))}
        </View>
    );

    const GapRow = ({ row }: { row: ReturnType<typeof parseRegistryXml>['gapgu'][0] }) => (
        <View style={[rxs.row, row.cont === '1' && rxs.rowCont]}>
            <View style={[rxs.cell, { flex: 1 }]}><Text style={rxs.cellTxt}>{row.rank_no}</Text></View>
            <View style={[rxs.cell, { flex: 2 }]}><Text style={rxs.cellTxt}>{row.aim_cont}</Text></View>
            <View style={[rxs.cell, { flex: 2 }]}><Text style={rxs.cellTxt}>{row.receve}</Text></View>
            <View style={[rxs.cell, { flex: 2 }]}><Text style={rxs.cellTxt}>{row.rgs_caus}</Text></View>
            <View style={[rxs.cell, { flex: 4, borderRightWidth: 0 }]}><Text style={rxs.cellTxt}>{row.nomprs}</Text></View>
        </View>
    );

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            <View style={rxs.overlay}>
                <View style={[rxs.container, { maxHeight: H * 0.93 }]}>
                    <View style={rxs.titleBar}>
                        <Text style={rxs.titleTxt}>등기사항전부증명서</Text>
                        <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                            <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>✕</Text>
                        </TouchableOpacity>
                    </View>
                    <ScrollView style={{ backgroundColor: '#F0F0EB' }} showsVerticalScrollIndicator>
                        {/* 문서 헤더 */}
                        <View style={rxs.docHeader}>
                            <Text style={rxs.docTitle}>부동산 등기사항전부증명서</Text>
                            <Text style={rxs.docSubtitle}>(말소사항 포함)</Text>
                            <View style={rxs.divider} />
                            {[
                                { label: '고유번호', value: d.header.pinNo },
                                { label: '부동산 표시', value: d.header.address },
                                { label: '발급일자', value: d.header.balDate },
                                { label: '관할등기소', value: d.header.jurisdiction },
                            ].filter(r => r.value).map((r, i) => (
                                <View key={i} style={rxs.docRow}>
                                    <Text style={rxs.docLabel}>{r.label}</Text>
                                    <Text style={rxs.docValue}>{r.value}</Text>
                                </View>
                            ))}
                        </View>

                        {/* 1동 건물 표제부 */}
                        {d.buildingTitles.length > 0 && (
                            <>
                                <SectionHeader title="【 표   제   부 】" sub="( 1동의 건물의 표시 )" />
                                <View style={rxs.table}>
                                    <THead cols={[{ label: '표시\n번호', flex: 1 }, { label: '접수', flex: 2 }, { label: '소재지번 및 건물번호', flex: 3 }, { label: '건물내역', flex: 2 }, { label: '등기원인\n및 기타', flex: 2 }]} />
                                    {d.buildingTitles.map((r, i) => (
                                        <View key={i} style={[rxs.row, r.cont === '1' && rxs.rowCont]}>
                                            <View style={[rxs.cell, { flex: 1 }]}><Text style={rxs.cellTxt}>{r.indi_no}</Text></View>
                                            <View style={[rxs.cell, { flex: 2 }]}><Text style={rxs.cellTxt}>{r.receve}</Text></View>
                                            <View style={[rxs.cell, { flex: 3 }]}><Text style={rxs.cellTxt}>{r.real_indi_cont}</Text></View>
                                            <View style={[rxs.cell, { flex: 2 }]}><Text style={rxs.cellTxt}>{r.buld_cont}</Text></View>
                                            <View style={[rxs.cell, { flex: 2, borderRightWidth: 0 }]}><Text style={rxs.cellTxt}>{r.caus}</Text></View>
                                        </View>
                                    ))}
                                </View>
                            </>
                        )}

                        {/* 전유부분 표제부 */}
                        {d.exclusiveParts.length > 0 && (
                            <>
                                <SectionHeader title="【 표   제   부 】" sub="( 전유부분의 건물의 표시 )" />
                                <View style={rxs.table}>
                                    <THead cols={[{ label: '표시\n번호', flex: 1 }, { label: '접수', flex: 2 }, { label: '건물번호', flex: 2 }, { label: '건물내역', flex: 2 }, { label: '등기원인\n및 기타', flex: 2 }]} />
                                    {d.exclusiveParts.map((r, i) => (
                                        <View key={i} style={[rxs.row, r.cont === '1' && rxs.rowCont]}>
                                            <View style={[rxs.cell, { flex: 1 }]}><Text style={rxs.cellTxt}>{r.indi_no}</Text></View>
                                            <View style={[rxs.cell, { flex: 2 }]}><Text style={rxs.cellTxt}>{r.receve}</Text></View>
                                            <View style={[rxs.cell, { flex: 2 }]}><Text style={rxs.cellTxt}>{r.build_no}</Text></View>
                                            <View style={[rxs.cell, { flex: 2 }]}><Text style={rxs.cellTxt}>{r.buld_cont}</Text></View>
                                            <View style={[rxs.cell, { flex: 2, borderRightWidth: 0 }]}><Text style={rxs.cellTxt}>{r.caus}</Text></View>
                                        </View>
                                    ))}
                                </View>
                            </>
                        )}

                        {/* 토지 표제부 */}
                        {d.landTitles.length > 0 && (
                            <>
                                <SectionHeader title="【 표   제   부 】" sub="( 토지의 표시 )" />
                                <View style={rxs.table}>
                                    <THead cols={[{ label: '표시\n번호', flex: 1 }, { label: '접수', flex: 2 }, { label: '소재지번', flex: 3 }, { label: '지목', flex: 1 }, { label: '면적', flex: 2 }, { label: '등기원인\n및 기타', flex: 2 }]} />
                                    {d.landTitles.map((r, i) => (
                                        <View key={i} style={[rxs.row, r.cont === '1' && rxs.rowCont]}>
                                            <View style={[rxs.cell, { flex: 1 }]}><Text style={rxs.cellTxt}>{r.indi_no}</Text></View>
                                            <View style={[rxs.cell, { flex: 2 }]}><Text style={rxs.cellTxt}>{r.receve}</Text></View>
                                            <View style={[rxs.cell, { flex: 3 }]}><Text style={rxs.cellTxt}>{r.real_indi_cont}</Text></View>
                                            <View style={[rxs.cell, { flex: 1 }]}><Text style={rxs.cellTxt}>{r.land_type}</Text></View>
                                            <View style={[rxs.cell, { flex: 2 }]}><Text style={rxs.cellTxt}>{r.area}</Text></View>
                                            <View style={[rxs.cell, { flex: 2, borderRightWidth: 0 }]}><Text style={rxs.cellTxt}>{r.caus}</Text></View>
                                        </View>
                                    ))}
                                </View>
                            </>
                        )}

                        {/* 대지권 */}
                        {d.landRights.length > 0 && (
                            <>
                                <SectionHeader title="【 대 지 권 의 표 시 】" />
                                <View style={rxs.table}>
                                    <THead cols={[{ label: '표시\n번호', flex: 1 }, { label: '대지권 종류', flex: 2 }, { label: '대지권 비율', flex: 2 }, { label: '등기원인 및 기타사항', flex: 3 }]} />
                                    {d.landRights.map((r, i) => (
                                        <View key={i} style={[rxs.row, r.cont === '1' && rxs.rowCont]}>
                                            <View style={[rxs.cell, { flex: 1 }]}><Text style={rxs.cellTxt}>{r.indi_no}</Text></View>
                                            <View style={[rxs.cell, { flex: 2 }]}><Text style={rxs.cellTxt}>{r.lot_type}</Text></View>
                                            <View style={[rxs.cell, { flex: 2 }]}><Text style={rxs.cellTxt}>{r.lot_num}</Text></View>
                                            <View style={[rxs.cell, { flex: 3, borderRightWidth: 0 }]}><Text style={rxs.cellTxt}>{r.caus}</Text></View>
                                        </View>
                                    ))}
                                </View>
                            </>
                        )}

                        {/* 갑구 */}
                        {d.gapgu.length > 0 && (
                            <>
                                <SectionHeader title="【 갑       구 】" sub="( 소유권에 관한 사항 )" />
                                <View style={rxs.table}>
                                    <THead cols={[{ label: '순위\n번호', flex: 1 }, { label: '등기목적', flex: 2 }, { label: '접수', flex: 2 }, { label: '등기원인', flex: 2 }, { label: '권리자 및 기타사항', flex: 4 }]} />
                                    {d.gapgu.map((r, i) => <GapRow key={i} row={r} />)}
                                </View>
                            </>
                        )}

                        {/* 을구 */}
                        {d.eulgu.length > 0 && (
                            <>
                                <SectionHeader title="【 을       구 】" sub="( 소유권 이외의 권리에 관한 사항 )" />
                                <View style={rxs.table}>
                                    <THead cols={[{ label: '순위\n번호', flex: 1 }, { label: '등기목적', flex: 2 }, { label: '접수', flex: 2 }, { label: '등기원인', flex: 2 }, { label: '권리자 및 기타사항', flex: 4 }]} />
                                    {d.eulgu.map((r, i) => <GapRow key={i} row={r} />)}
                                </View>
                            </>
                        )}

                        {/* 푸터 */}
                        <View style={rxs.footer}>
                            <Text style={rxs.footerTxt}>이 증명서는 등기기록의 내용과 틀림없음을 증명합니다.</Text>
                            {d.header.balDate ? <Text style={rxs.footerDate}>{d.header.balDate}</Text> : null}
                            {d.header.jurisdiction ? <Text style={rxs.footerJuris}>{d.header.jurisdiction}</Text> : null}
                        </View>
                        <View style={{ height: 16 }} />
                    </ScrollView>
                    <TouchableOpacity style={rxs.closeBtn} onPress={onClose}>
                        <Text style={rxs.closeBtnTxt}>닫기</Text>
                    </TouchableOpacity>
                </View>
            </View>
        </Modal>
    );
};

const rxs = StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'flex-end' },
    container: { backgroundColor: '#fff', borderTopLeftRadius: 16, borderTopRightRadius: 16, overflow: 'hidden' },
    titleBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#1A237E', paddingHorizontal: 16, paddingVertical: 12 },
    titleTxt: { color: '#fff', fontSize: 15, fontWeight: '700' },
    docHeader: { backgroundColor: '#fff', margin: 10, borderRadius: 4, padding: 14, borderWidth: 1.5, borderColor: '#333' },
    docTitle: { fontSize: 15, fontWeight: '700', textAlign: 'center', color: '#000' },
    docSubtitle: { fontSize: 11, textAlign: 'center', color: '#555', marginBottom: 6 },
    divider: { height: 1, backgroundColor: '#333', marginVertical: 8 },
    docRow: { flexDirection: 'row', marginTop: 3 },
    docLabel: { fontSize: 11, color: '#666', width: 72 },
    docValue: { fontSize: 11, color: '#000', flex: 1 },
    sectionHeader: { backgroundColor: '#37474F', paddingVertical: 7, paddingHorizontal: 12, marginTop: 10, marginHorizontal: 10, borderTopLeftRadius: 4, borderTopRightRadius: 4, alignItems: 'center' },
    sectionHeaderText: { color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 1 },
    sectionHeaderSub: { color: '#CFD8DC', fontSize: 10, marginTop: 2 },
    table: { marginHorizontal: 10, borderWidth: 1, borderTopWidth: 0, borderColor: '#666', backgroundColor: '#fff' },
    row: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#999' },
    rowCont: { backgroundColor: '#F9F9F9' },
    cell: { padding: 4, borderRightWidth: 1, borderRightColor: '#999' },
    cellTxt: { fontSize: 10, color: '#222', lineHeight: 14 },
    footer: { margin: 10, marginTop: 14, padding: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: '#ccc', borderRadius: 4, alignItems: 'center' },
    footerTxt: { fontSize: 11, color: '#555', textAlign: 'center' },
    footerDate: { fontSize: 12, fontWeight: '600', color: '#333', marginTop: 4 },
    footerJuris: { fontSize: 12, color: '#333', marginTop: 2 },
    closeBtn: { backgroundColor: '#37474F', margin: 12, borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
    closeBtnTxt: { color: '#fff', fontSize: 15, fontWeight: '700' },
});

// ===== 토지이용계획 패널 컴포넌트 =====

const SOLAR_COLORS: Record<SolarFeasibilityLevel, { bg: string; border: string; text: string; badge: string }> = {
    favorable: { bg: '#E8F5E9', border: '#2E7D32', text: '#1B5E20', badge: '#2E7D32' },
    neutral:   { bg: '#E3F2FD', border: '#1565C0', text: '#0D47A1', badge: '#1565C0' },
    restricted: { bg: '#FFEBEE', border: '#C62828', text: '#B71C1C', badge: '#C62828' },
};

const FEASIBILITY_ICONS: Record<SolarFeasibilityLevel, string> = {
    favorable: '+',
    neutral: '-',
    restricted: '!',
};

const LandUsePanel = React.memo(({
    info,
    isLoading,
}: {
    info: LandUseInfo | null;
    isLoading: boolean;
}) => {
    if (isLoading) {
        return (
            <View style={landUseStyles.container}>
                <View style={landUseStyles.loadingRow}>
                    <ActivityIndicator size="small" color="#1565C0" />
                    <Text style={landUseStyles.loadingText}>토지이용계획 조회 중...</Text>
                </View>
            </View>
        );
    }

    if (!info) return null;

    const colors = SOLAR_COLORS[info.feasibilityLevel];
    const icon = FEASIBILITY_ICONS[info.feasibilityLevel];

    return (
        <View style={[landUseStyles.container, { backgroundColor: colors.bg, borderColor: colors.border }]}>
            <View style={landUseStyles.header}>
                <Text style={landUseStyles.headerTitle}>토지이용계획 (태양광 검토)</Text>
                <View style={[landUseStyles.badge, { backgroundColor: colors.badge }]}>
                    <Text style={landUseStyles.badgeText}>
                        {info.feasibilityLevel === 'favorable' ? '설치 유리' :
                         info.feasibilityLevel === 'restricted' ? '제한 가능' : '확인 필요'}
                    </Text>
                </View>
            </View>

            {info.zoning ? (
                <View style={landUseStyles.row}>
                    <Text style={landUseStyles.label}>용도지역</Text>
                    <Text style={[landUseStyles.value, { color: colors.text, fontWeight: '700' }]}>
                        {info.zoning}
                    </Text>
                </View>
            ) : null}

            <View style={landUseStyles.noteRow}>
                <Text style={{ fontSize: 14, marginRight: 6 }}>{icon}</Text>
                <Text style={[landUseStyles.noteText, { color: colors.text }]}>
                    {info.feasibilityNote}
                </Text>
            </View>

            <Text style={landUseStyles.disclaimer}>
                ※ 실제 설치 가능 여부는 관할 지자체에 반드시 확인하세요
            </Text>
        </View>
    );
});

const landUseStyles = StyleSheet.create({
    container: {
        borderWidth: 1.5,
        borderRadius: 10,
        padding: 12,
        marginBottom: 12,
    },
    loadingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    loadingText: {
        fontSize: 13,
        color: '#555',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 8,
    },
    headerTitle: {
        fontSize: 13,
        fontWeight: '700',
        color: '#333',
    },
    badge: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 10,
    },
    badgeText: {
        color: '#fff',
        fontSize: 11,
        fontWeight: '700',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginBottom: 6,
    },
    label: {
        fontSize: 12,
        color: '#666',
        width: 60,
    },
    value: {
        fontSize: 13,
        flex: 1,
    },
    noteRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginTop: 4,
        marginBottom: 6,
    },
    noteText: {
        fontSize: 13,
        flex: 1,
        lineHeight: 18,
    },
    disclaimer: {
        fontSize: 10,
        color: '#888',
        marginTop: 4,
        fontStyle: 'italic',
    },
});

// ===== 등기 열람 확인 시트 (화면 03) =====
// 포인트가 차감되는 등기 열람 전 확인 시트. 기존 Alert.alert 2줄 안내를 대체한다.

interface RegistryConfirmSheetProps {
    visible: boolean;
    onClose: () => void;
    onConfirm: () => void;
    address: string;
    balance: number | null;
    /** true면 "이미 조회한 등기를 다시(유료) 조회" 문구로 전환 */
    isRefresh?: boolean;
}

const RegistryConfirmSheet = ({ visible, onClose, onConfirm, address, balance, isRefresh }: RegistryConfirmSheetProps) => {
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const nextBalance = balance !== null ? Math.max(balance - 1, 0) : null;

    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
            <View style={{ flex: 1, backgroundColor: 'rgba(16,24,40,0.45)', justifyContent: 'flex-end' }}>
                <View style={{ backgroundColor: COLORS.white, borderTopLeftRadius: RADIUS.sheet + 4, borderTopRightRadius: RADIUS.sheet + 4, paddingTop: SPACING.xl6, paddingHorizontal: SPACING.xl3, paddingBottom: SPACING.xl6 }}>
                    <Text style={{ fontSize: fs['2xl'] + 9, fontWeight: '700', color: COLORS.ink, lineHeight: 38 }}>
                        {isRefresh ? '등기부등본을\n다시 열람할까요?' : '등기부등본을\n열람할까요?'}
                    </Text>
                    <Text style={{ fontSize: fs.base, color: COLORS.textMuted, marginTop: SPACING.base }}>
                        열람하면 포인트가 1P 차감됩니다.
                    </Text>

                    <View style={{ backgroundColor: COLORS.surface, borderRadius: RADIUS.card, padding: SPACING.xl3, marginTop: SPACING.xl4 }}>
                        <View style={{ paddingBottom: SPACING.base }}>
                            <Text style={{ fontSize: fs.sm, color: COLORS.textMuted, marginBottom: 4 }}>주소</Text>
                            <Text style={{ fontSize: fs.lg, fontWeight: '700', color: COLORS.ink }} numberOfLines={2}>{address}</Text>
                        </View>
                        <View style={{ height: 1, backgroundColor: COLORS.line }} />
                        <View style={{ paddingTop: SPACING.base }}>
                            <Text style={{ fontSize: fs.sm, color: COLORS.textMuted, marginBottom: 4 }}>남은 포인트</Text>
                            <Text style={{ fontSize: fs.lg, fontWeight: '700', color: COLORS.ink }}>
                                {balance !== null ? `${balance.toLocaleString()}P → ${nextBalance?.toLocaleString()}P` : '미조회'}
                            </Text>
                        </View>
                    </View>

                    <View style={{ backgroundColor: COLORS.warnTint, borderRadius: RADIUS.input, padding: SPACING.xl2, marginTop: SPACING.base }}>
                        <Text style={{ fontSize: fs.sm, color: COLORS.warn }}>
                            24시간 내 같은 주소를 다시 열람하면 무료입니다.
                        </Text>
                    </View>

                    <TouchableOpacity
                        onPress={onConfirm}
                        style={{ height: 60, borderRadius: RADIUS.button, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center', marginTop: SPACING.xl4, ...ELEVATION.primaryBtn }}
                        accessibilityLabel="열람하기"
                        accessibilityRole="button"
                    >
                        <Text style={{ fontSize: fs.xl + 3, fontWeight: '700', color: COLORS.white }}>열람하기</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        onPress={onClose}
                        style={{ height: 60, borderRadius: RADIUS.button, backgroundColor: COLORS.surface, alignItems: 'center', justifyContent: 'center', marginTop: SPACING.base }}
                        accessibilityLabel="다음에 하기"
                        accessibilityRole="button"
                    >
                        <Text style={{ fontSize: fs.lg, fontWeight: '700', color: COLORS.textMuted }}>다음에 하기</Text>
                    </TouchableOpacity>
                </View>
            </View>
        </Modal>
    );
};

// ===== 등기정보 Modal (기존 유지, 직접 Tilko API 조회) =====

const RegistryInfoModal = ({ visible, onClose, marker }: {
    visible: boolean;
    onClose: () => void;
    marker: Building | null;
}) => {
    const [isLoading, setIsLoading] = useState(false);
    const [status, setStatus] = useState('');
    const [result, setResult] = useState<{ owner: string; address: string } | null>(null);
    const [error, setError] = useState('');
    const [pnu, setPnu] = useState('');
    const [uniqueNo, setUniqueNo] = useState('');
    const [fromCache, setFromCache] = useState(false);
    const [directMode, setDirectMode] = useState(false);
    const [directPin, setDirectPin] = useState('');
    const [xmlData, setXmlData] = useState('');
    const [xmlModalVisible, setXmlModalVisible] = useState(false);
    const [landUseInfo, setLandUseInfo] = useState<LandUseInfo | null>(null);
    const [isLoadingLandUse, setIsLoadingLandUse] = useState(false);
    const [isRegisteringProperty, setIsRegisteringProperty] = useState(false);

    useEffect(() => {
        if (visible && marker && !directMode) handleAutoSearch();
    }, [visible, marker]);

    const loadLandUseInfoForMarker = async (lat: number, lng: number) => {
        setIsLoadingLandUse(true);
        try {
            const info = await fetchLandUseInfo(lat, lng);
            setLandUseInfo(info);
        } catch (_) {
            setLandUseInfo(null);
        } finally {
            setIsLoadingLandUse(false);
        }
    };

    const handleDirectSearch = async () => {
        const pin = directPin.trim();
        if (!pin) { setError('고유번호(Pin)를 입력해주세요.'); return; }
        setIsLoading(true);
        setResult(null);
        setError('');
        setFromCache(false);
        try {
            setStatus('등기정보 조회 중...');
            const info = await fetchRegistryInfo(pin);
            setUniqueNo(pin);
            setResult({ owner: info.owner, address: info.address });
            setXmlData(info.xmlData || '');
            setStatus('');
            if (info.pointBalance !== null) {
                useMapStore.getState().setTilkoBalance(info.pointBalance);
                updateTilkoBalanceInDB(info.pointBalance, 'post_registry').catch(() => {});
            }
            if (marker) {
                await saveRegistryCache(marker.latitude, marker.longitude, {
                    pnu: pnu || '',
                    jibunAddr: marker.address || '',
                    uniqueNo: pin,
                    owner: info.owner,
                    address: info.address,
                    cachedAt: Date.now(),
                });
                // Supabase에 소유자 정보 + XML 원문 저장
                saveIROSView({
                    lat: marker.latitude,
                    lng: marker.longitude,
                    road_address: marker.address || '',
                    jibun_address: marker.address || '',
                    owner_name: info.owner !== '정보 없음' ? info.owner : undefined,
                    owner_address: info.address !== '정보 없음' ? info.address : undefined,
                    xml_data: info.xmlData || undefined,
                }).catch(console.warn);
                // 토지이용계획 조회
                loadLandUseInfoForMarker(marker.latitude, marker.longitude);
            }
        } catch (e: any) {
            const msg: string = e.message || '등기정보 조회 중 오류가 발생했습니다.';
            if (msg.startsWith('[잔액부족]')) {
                Alert.alert('💳 잔액 부족', msg.replace('[잔액부족] ', ''));
            } else {
                setError(msg);
            }
            setStatus('');
        } finally {
            setIsLoading(false);
        }
    };

    const handleAutoSearch = async () => {
        if (!marker) return;
        setIsLoading(true);
        setResult(null);
        setError('');
        setPnu('');
        setFromCache(false);
        try {
            setStatus('캐시 확인 중...');
            const cached = await getRegistryCache(marker.latitude, marker.longitude);
            if (cached) {
                setPnu(cached.pnu);
                setResult({ owner: cached.owner, address: cached.address });
                setFromCache(true);
                setStatus('');
                setIsLoading(false);
                return;
            }
            setStatus('PNU 조회 중...');
            const pnuResult = await fetchPNU(marker.latitude, marker.longitude);
            setPnu(pnuResult.pnu);
            setStatus('고유번호 검색 중...');
            const uniqueNoList = await fetchUniqueNoByAddress(pnuResult.jibunAddr);
            const normalItems = uniqueNoList.filter(i => i.uniqueNo && !i.isSpecial);
            const validItem = normalItems.find(i => i.realtyType === '집합건물')
                || normalItems.find(i => i.realtyType === '건물')
                || normalItems[0]
                || uniqueNoList.find(i => i.uniqueNo)
                || uniqueNoList[0];
            const targetUniqueNo = validItem?.uniqueNo || '';
            if (!targetUniqueNo) throw new Error('유효한 부동산 고유번호를 찾을 수 없습니다.');
            setStatus('등기정보 조회 중...');
            const info = await fetchRegistryInfo(targetUniqueNo);
            setUniqueNo(targetUniqueNo);
            setResult({ owner: info.owner, address: info.address });
            setXmlData(info.xmlData || '');
            setStatus('');
            if (info.pointBalance !== null) {
                useMapStore.getState().setTilkoBalance(info.pointBalance);
                updateTilkoBalanceInDB(info.pointBalance, 'post_registry').catch(() => {});
            }
            await saveRegistryCache(marker.latitude, marker.longitude, {
                pnu: pnuResult.pnu,
                jibunAddr: pnuResult.jibunAddr,
                uniqueNo: targetUniqueNo,
                owner: info.owner,
                address: info.address,
                cachedAt: Date.now(),
            });
            // Supabase에 소유자 정보 + XML 원문 저장
            saveIROSView({
                lat: marker.latitude,
                lng: marker.longitude,
                road_address: marker.address || '',
                jibun_address: pnuResult.jibunAddr || '',
                owner_name: info.owner !== '정보 없음' ? info.owner : undefined,
                owner_address: info.address !== '정보 없음' ? info.address : undefined,
                xml_data: info.xmlData || undefined,
            }).catch(console.warn);
            // 토지이용계획 조회 (병렬)
            loadLandUseInfoForMarker(marker.latitude, marker.longitude);
        } catch (e: any) {
            const msg: string = e.message || '등기정보 조회 중 오류가 발생했습니다.';
            if (msg.startsWith('[잔액부족]')) {
                Alert.alert('💳 잔액 부족', msg.replace('[잔액부족] ', ''));
            } else {
                setError(msg);
            }
            setStatus('');
        } finally {
            setIsLoading(false);
        }
    };

    const handleClose = () => {
        setResult(null);
        setError('');
        setPnu('');
        setUniqueNo('');
        setStatus('');
        setFromCache(false);
        setXmlData('');
        setDirectMode(false);
        setDirectPin('');
        setLandUseInfo(null);
        setIsRegisteringProperty(false);
        onClose();
    };

    const handleRegisterAsProperty = async () => {
        if (!result || !marker) return;
        setIsRegisteringProperty(true);
        try {
            const propId = uniqueNo || pnu || `${marker.latitude.toFixed(6)}_${marker.longitude.toFixed(6)}`;
            const { error: insertError } = await supabase.from('properties').insert([{
                property_id: propId,
                lat: marker.latitude,
                lng: marker.longitude,
                road_address: marker.address || null,
                parcel_address: null,
                owner_name: result.owner !== '정보 없음' ? result.owner : null,
                owner_address: result.address !== '정보 없음' ? result.address : null,
                sales_status: '미접촉' as SalesStatus,
                created_at: new Date().toISOString(),
            }]);
            if (insertError) {
                if (insertError.code === '23505') {
                    Alert.alert('이미 등록됨', '이미 매물로 등록된 부동산입니다.\n영업 현황에서 확인하세요.');
                } else {
                    throw insertError;
                }
            } else {
                Alert.alert('등록 완료', '매물로 등록되었습니다.\n홈 탭 > 장소관리에서 영업상태를 관리하세요.');
            }
        } catch (e: any) {
            Alert.alert('등록 실패', e.message || '매물 등록 중 오류가 발생했습니다.');
        } finally {
            setIsRegisteringProperty(false);
        }
    };

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
            <View style={styles.modalOverlay}>
                <View style={styles.modalContent}>
                    <Text style={styles.modalTitle}>등기정보 조회 (Tilko API)</Text>

                    {marker && !directMode && (
                        <View style={{ marginBottom: 12 }}>
                            <Text style={styles.modalLabel}>선택된 위치</Text>
                            <Text style={{ fontSize: 13, color: '#555', marginBottom: 4 }}>{marker.address}</Text>
                            {pnu ? <Text style={{ fontSize: 12, color: '#888' }}>PNU: {pnu}</Text> : null}
                        </View>
                    )}

                    {!isLoading && !result && (
                        <TouchableOpacity
                            style={{
                                alignSelf: 'flex-end',
                                paddingVertical: 6,
                                paddingHorizontal: 12,
                                borderRadius: 6,
                                backgroundColor: directMode ? '#4A90E2' : '#eee',
                                marginBottom: 12,
                            }}
                            onPress={() => { setDirectMode(!directMode); setError(''); }}
                        >
                            <Text style={{ fontSize: 13, color: directMode ? '#fff' : '#555', fontWeight: '600' }}>
                                {directMode ? '자동조회로 전환' : '직접입력'}
                            </Text>
                        </TouchableOpacity>
                    )}

                    {directMode && !isLoading && !result && (
                        <View style={{ marginBottom: 12 }}>
                            <Text style={styles.modalLabel}>고유번호(Pin) 직접입력</Text>
                            <TextInput
                                style={styles.modalInput}
                                placeholder="부동산 고유번호 입력"
                                value={directPin}
                                onChangeText={setDirectPin}
                                keyboardType="default"
                                autoCapitalize="none"
                            />
                            <TouchableOpacity style={styles.modalSearchButton} onPress={handleDirectSearch}>
                                <Text style={styles.modalSearchButtonText}>등기부등본 조회</Text>
                            </TouchableOpacity>
                        </View>
                    )}

                    {isLoading ? (
                        <View style={{ alignItems: 'center', paddingVertical: 20 }}>
                            <ActivityIndicator size="large" color="#3498DB" />
                            <Text style={{ marginTop: 10, color: '#555', fontSize: 14 }}>{status}</Text>
                        </View>
                    ) : null}

                    {error ? (
                        <View style={styles.modalResultBox}>
                            <Text style={styles.modalErrorText}>{error}</Text>
                            <TouchableOpacity
                                style={[styles.modalSearchButton, { marginTop: 10 }]}
                                onPress={handleAutoSearch}
                            >
                                <Text style={styles.modalSearchButtonText}>재시도</Text>
                            </TouchableOpacity>
                        </View>
                    ) : null}

                    {result ? (
                        <View style={styles.modalResultBox}>
                            {fromCache && (
                                <View style={{ backgroundColor: '#E8F5E9', padding: 8, borderRadius: 6, marginBottom: 10 }}>
                                    <Text style={{ fontSize: 12, color: '#2E7D32', textAlign: 'center' }}>
                                        저장된 데이터입니다 (API 비용 미발생)
                                    </Text>
                                </View>
                            )}
                            <Text style={styles.modalResultLabel}>소유주</Text>
                            <Text style={styles.modalResultValue}>{result.owner}</Text>
                            <Text style={styles.modalResultLabel}>주소</Text>
                            <Text style={styles.modalResultValue}>{result.address}</Text>
                            {xmlData ? (
                                <TouchableOpacity
                                    style={{ marginTop: 12, backgroundColor: '#1A237E', borderRadius: 6, paddingVertical: 10, alignItems: 'center' }}
                                    onPress={() => setXmlModalVisible(true)}
                                >
                                    <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>📄 XML 정보 보기 (등기부등본)</Text>
                                </TouchableOpacity>
                            ) : null}
                            {/* 매물로 등록 버튼 */}
                            <TouchableOpacity
                                style={[{ marginTop: 10, backgroundColor: '#16A34A', borderRadius: 6, paddingVertical: 11, alignItems: 'center' }, isRegisteringProperty && { opacity: 0.6 }]}
                                onPress={handleRegisterAsProperty}
                                disabled={isRegisteringProperty}
                            >
                                {isRegisteringProperty
                                    ? <ActivityIndicator size="small" color="#fff" />
                                    : <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>+ 매물로 등록 (영업관리)</Text>
                                }
                            </TouchableOpacity>
                        </View>
                    ) : null}

                    {/* 토지이용계획 패널 */}
                    {result && (
                        <LandUsePanel info={landUseInfo} isLoading={isLoadingLandUse} />
                    )}
                    <RegistryXmlModal visible={xmlModalVisible} onClose={() => setXmlModalVisible(false)} xmlData={xmlData} />

                    <TouchableOpacity style={styles.modalCloseButton} onPress={handleClose}>
                        <Text style={styles.modalCloseButtonText}>닫기</Text>
                    </TouchableOpacity>
                </View>
            </View>
        </Modal>
    );
};

// ===== 스켈레톤 / 로딩 UI =====

const SkeletonItem = () => {
    const opacity = useRef(new Animated.Value(0.3)).current;
    useEffect(() => {
        const anim = Animated.loop(
            Animated.sequence([
                Animated.timing(opacity, { toValue: 1, duration: 800, useNativeDriver: true }),
                Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
            ])
        );
        anim.start();
        return () => anim.stop();
    }, []);
    return (
        <View style={styles.listItem}>
            <Animated.View style={[styles.skeletonBox, { width: '60%', height: 20, marginBottom: 8, opacity }]} />
            <Animated.View style={[styles.skeletonBox, { width: '80%', height: 16, opacity }]} />
        </View>
    );
};

const SkeletonBox = ({ width, height, style }: { width?: number | string; height: number; style?: object }) => {
    const opacity = useRef(new Animated.Value(0.3)).current;
    useEffect(() => {
        const anim = Animated.loop(
            Animated.sequence([
                Animated.timing(opacity, { toValue: 0.7, duration: 700, useNativeDriver: true }),
                Animated.timing(opacity, { toValue: 0.3, duration: 700, useNativeDriver: true }),
            ])
        );
        anim.start();
        return () => anim.stop();
    }, []);
    return (
        <Animated.View style={[{ backgroundColor: '#E4E4E7', borderRadius: 6, opacity }, width ? { width } : { flex: 1 }, { height }, style]} />
    );
};

// ===== 화면 17: 빈 상태 (공용) =====

const EmptyState = ({ title, description, ctaLabel, onPressCta }: {
    title: string;
    description: string;
    ctaLabel?: string;
    onPressCta?: () => void;
}) => {
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    return (
        <View style={{ flex: 1, alignItems: 'center', paddingTop: 120, paddingHorizontal: SPACING.xl3 }}>
            <View style={{ width: 104, height: 104, borderRadius: RADIUS.sheet - 2, backgroundColor: COLORS.primaryTint, alignItems: 'center', justifyContent: 'center', marginBottom: SPACING.xl3 }}>
                <View style={{ alignItems: 'center' }}>
                    <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: COLORS.primary }} />
                    <View style={{ width: 12, height: 12, backgroundColor: COLORS.primary, transform: [{ rotate: '45deg' }], marginTop: -9 }} />
                </View>
            </View>
            <Text style={{ fontSize: fs.xl + 6, fontWeight: '700', color: COLORS.ink, textAlign: 'center', lineHeight: 32 }}>{title}</Text>
            <Text style={{ fontSize: fs.base, color: COLORS.textMuted, textAlign: 'center', lineHeight: 28, marginTop: SPACING.base }}>{description}</Text>
            {ctaLabel && onPressCta && (
                <TouchableOpacity
                    onPress={onPressCta}
                    style={{ height: 64, borderRadius: RADIUS.button, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACING.xl5, marginTop: SPACING.xl4 }}
                    accessibilityLabel={ctaLabel}
                    accessibilityRole="button"
                >
                    <Text style={{ fontSize: fs.lg, fontWeight: '700', color: COLORS.white }}>{ctaLabel}</Text>
                </TouchableOpacity>
            )}
        </View>
    );
};

const LoadingOverlay = ({ visible, message }: { visible: boolean; message: string }) => {
    const [progress, setProgress] = useState(0);
    const fadeAnim = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        if (visible) {
            Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }).start();
            setProgress(0);
            const interval = setInterval(() => {
                setProgress((prev) => {
                    if (prev >= 100) { clearInterval(interval); return 100; }
                    return Math.min(prev + Math.random() * 15, 100);
                });
            }, 100);
            return () => clearInterval(interval);
        } else {
            Animated.timing(fadeAnim, { toValue: 0, duration: 300, useNativeDriver: true }).start();
        }
    }, [visible]);

    if (!visible && progress === 0) return null;

    return (
        <Animated.View style={[styles.loadingOverlay, { opacity: fadeAnim }]} pointerEvents={visible ? 'auto' : 'none'}>
            <View style={styles.loadingBox}>
                <ActivityIndicator size="large" color="#71717A" style={{ marginBottom: 20 }} />
                <Text style={styles.loadingText}>{message}</Text>
                <View style={styles.progressBarContainer}>
                    <View style={[styles.progressBar, { width: `${progress}%` }]} />
                </View>
                <Text style={styles.progressText}>{Math.round(progress)}%</Text>
            </View>
        </Animated.View>
    );
};

// ===== 다음 우편번호 WebView HTML =====

const DAUM_POSTCODE_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: #fff; }
    #error { display:none; padding:20px; color:#E74C3C; font-size:14px; text-align:center; }
  </style>
</head>
<body>
  <div id="error">주소 검색 서비스를 불러오지 못했습니다.<br>네트워크 연결을 확인해 주세요.</div>
  <script>
    function initPostcode() {
      try {
        new daum.Postcode({
          oncomplete: function(data) {
            try {
              window.ReactNativeWebView.postMessage(JSON.stringify(data));
            } catch(e) {
              console.warn('postMessage failed', e);
            }
          },
          width: '100%',
          height: '100%',
          animation: false
        }).embed(document.body, { autoClose: false });
      } catch(e) {
        document.getElementById('error').style.display = 'block';
      }
    }

    var s = document.createElement('script');
    s.src = 'https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js';
    s.onload = initPostcode;
    s.onerror = function() {
      document.getElementById('error').style.display = 'block';
    };
    document.head.appendChild(s);
  </script>
</body>
</html>
`;

// ===== PlaceSearchScreen =====

const PlaceSearchScreen = ({ onBack, onMoveToMap, onSelectRegion }: { onBack: () => void; onMoveToMap: () => void; onSelectRegion?: () => void }) => {
    const [searchInput, setSearchInput] = useState('');
    const [searchResults, setSearchResults] = useState<Building[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [hasSearched, setHasSearched] = useState(false);
    const [recentSearches, setRecentSearches] = useState<string[]>([]);
    const [daumModalVisible, setDaumModalVisible] = useState(false);
    const [pendingResult, setPendingResult] = useState<Building | null>(null);
    const [registryViewed, setRegistryViewed] = useState<Array<{ lat: number; lng: number; viewed_at: string }>>([]);
    const { region, setRegion, setSelectedMarker, elderlyMode, parcelAreas, setParcelArea, listSort, setListSort } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;

    useEffect(() => {
        AsyncStorage.getItem(RECENT_SEARCH_TERMS_KEY).then(json => {
            if (json) setRecentSearches(JSON.parse(json));
        });
        supabase.from('registry_views').select('lat, lng, viewed_at').order('viewed_at', { ascending: false }).then(({ data }) => {
            setRegistryViewed((data || []) as Array<{ lat: number; lng: number; viewed_at: string }>);
        });
    }, []);

    const findViewedAt = (item: Building): string | null => {
        const delta = 0.001;
        const match = registryViewed.find(r => Math.abs(r.lat - item.latitude) <= delta && Math.abs(r.lng - item.longitude) <= delta);
        return match?.viewed_at ?? null;
    };

    const saveRecentSearch = async (term: string) => {
        const next = [term, ...recentSearches.filter(t => t !== term)].slice(0, 10);
        setRecentSearches(next);
        await AsyncStorage.setItem(RECENT_SEARCH_TERMS_KEY, JSON.stringify(next));
    };

    const removeRecentSearch = async (term: string) => {
        const next = recentSearches.filter(t => t !== term);
        setRecentSearches(next);
        await AsyncStorage.setItem(RECENT_SEARCH_TERMS_KEY, JSON.stringify(next));
    };

    // 화면 13: VWorld 장소명 → 주소 순으로 검색
    const performSearch = async (queryText: string) => {
        const q = queryText.trim();
        if (!q) return;
        setIsLoading(true);
        setHasSearched(true);
        try {
            let url = `https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=20&page=1&query=${encodeURIComponent(q)}&type=place&format=json&errorformat=json&key=${VWORLD_API_KEY}`;
            let res = await fetch(url);
            let json = await res.json();
            if (json.response?.status === 'NOT_FOUND' || !json.response?.result) {
                url = `https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=20&page=1&query=${encodeURIComponent(q)}&type=address&format=json&errorformat=json&key=${VWORLD_API_KEY}`;
                res = await fetch(url);
                json = await res.json();
            }
            if (json.response?.status === 'NOT_FOUND' || !json.response?.result) {
                setSearchResults([]);
            } else {
                setSearchResults((json.response.result.items as VWorldPlaceItem[]).map(item => ({
                    id: item.id,
                    name: item.title,
                    address: item.address?.road || item.address?.parcel || '',
                    category: item.category,
                    distance: Math.round(haversineDistance(region.latitude, region.longitude, parseFloat(item.point.y), parseFloat(item.point.x))),
                    latitude: parseFloat(item.point.y),
                    longitude: parseFloat(item.point.x),
                })));
            }
            saveRecentSearch(q);
        } catch {
            Alert.alert('오류', '검색 중 문제가 발생했습니다.');
        } finally {
            setIsLoading(false);
        }
    };

    const sortedResults = useMemo(() => {
        if (listSort !== 'area') return [...searchResults].sort((a, b) => a.distance - b.distance);
        return [...searchResults].sort((a, b) => {
            const keyA = `${a.latitude.toFixed(6)},${a.longitude.toFixed(6)}`;
            const keyB = `${b.latitude.toFixed(6)},${b.longitude.toFixed(6)}`;
            const areaA = parcelAreas[keyA]?.landAreaM2;
            const areaB = parcelAreas[keyB]?.landAreaM2;
            if (areaA === undefined && areaB === undefined) return a.distance - b.distance;
            if (areaA === undefined) return 1;
            if (areaB === undefined) return -1;
            return areaB - areaA;
        });
    }, [searchResults, listSort, parcelAreas]);

    const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: Array<{ item: Building }> }) => {
        viewableItems.forEach(({ item }) => {
            const key = `${item.latitude.toFixed(6)},${item.longitude.toFixed(6)}`;
            if (parcelAreas[key]) return;
            fetchParcelArea(item.latitude, item.longitude).then(result => {
                if (result) setParcelArea(key, result.landAreaM2);
            });
        });
    }).current;

    // 다음 주소검색 완료 → 좌표 변환 후 pendingResult에 저장 (바로 리스트에 추가하지 않음)
    const handleDaumMessage = async (event: DaumWebViewMessageEvent) => {
        const data: DaumPostcodeData = JSON.parse(event.nativeEvent.data);
        setDaumModalVisible(false);
        setIsLoading(true);
        const roadAddr = data.roadAddress || '';
        const jibunAddr = data.jibunAddress || data.autoJibunAddress || '';
        const displayAddr = roadAddr || jibunAddr;
        try {
            const coords = await geocodeAddressToCoord(displayAddr);
            if (coords) {
                setPendingResult({
                    id: `daum-${Date.now()}`,
                    name: roadAddr || jibunAddr,
                    address: jibunAddr || displayAddr,
                    distance: 0,
                    latitude: coords.lat,
                    longitude: coords.lng,
                });
            } else {
                Alert.alert('좌표 변환 실패', '해당 주소의 좌표를 찾을 수 없습니다.\n직접 지도에서 검색해 주세요.');
            }
        } catch {
            Alert.alert('오류', '주소 처리 중 문제가 발생했습니다.');
        } finally {
            setIsLoading(false);
        }
    };

    // pendingResult 확인 → 리스트에 추가
    const confirmPendingResult = () => {
        if (!pendingResult) return;
        setSearchResults(prev => [pendingResult, ...prev]);
        setPendingResult(null);
    };

    // 지도 이동 + 마커
    const moveToLocation = (item: Building) => {
        setSelectedMarker(item);
        setRegion({
            latitude: item.latitude,
            longitude: item.longitude,
            latitudeDelta: 0.002,
            longitudeDelta: 0.002,
        });
        onMoveToMap();
    };

    return (
        <View style={[styles.subScreenContainer, { backgroundColor: COLORS.surface }]}>
            {/* 헤더: 뒤로 + 검색 입력 */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.base, paddingHorizontal: SPACING.xl3, paddingTop: SPACING.lg, paddingBottom: SPACING.base, backgroundColor: COLORS.white, borderBottomWidth: 1, borderBottomColor: COLORS.lineSoft }}>
                <TouchableOpacity onPress={onBack} accessibilityLabel="뒤로 가기" accessibilityRole="button">
                    <Text style={{ fontSize: fs.xl, color: COLORS.inkSub, fontWeight: '700' }}>{'‹'}</Text>
                </TouchableOpacity>
                <View style={{ flex: 1, height: 56, backgroundColor: COLORS.surface, borderRadius: RADIUS.button, flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.xl2 }}>
                    <TextInput
                        style={{ flex: 1, fontSize: fs.base, color: COLORS.ink, padding: 0 }}
                        placeholder="주소 · 건물명으로 찾기"
                        placeholderTextColor={COLORS.textMuted}
                        value={searchInput}
                        onChangeText={setSearchInput}
                        onSubmitEditing={() => performSearch(searchInput)}
                        returnKeyType="search"
                        autoFocus
                    />
                    {searchInput.length > 0 && (
                        <TouchableOpacity onPress={() => { setSearchInput(''); setSearchResults([]); setHasSearched(false); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityLabel="검색어 지우기" accessibilityRole="button">
                            <Text style={{ fontSize: 18, color: COLORS.chevron, fontWeight: '700' }}>{'×'}</Text>
                        </TouchableOpacity>
                    )}
                </View>
            </View>

            {/* 지역으로 찾기 / 주소 직접 입력 */}
            <View style={{ flexDirection: 'row', gap: SPACING.sm, paddingHorizontal: SPACING.xl3, paddingTop: SPACING.base }}>
                {onSelectRegion && (
                    <TouchableOpacity
                        onPress={onSelectRegion}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, backgroundColor: COLORS.white, borderRadius: RADIUS.chip, paddingHorizontal: SPACING.base, paddingVertical: SPACING.sm }}
                        accessibilityLabel="지역으로 찾기"
                        accessibilityRole="button"
                    >
                        <Text style={{ fontSize: fs.sm, fontWeight: '700', color: COLORS.inkSub }}>지역으로 찾기</Text>
                    </TouchableOpacity>
                )}
                <TouchableOpacity
                    onPress={() => setDaumModalVisible(true)}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, backgroundColor: COLORS.white, borderRadius: RADIUS.chip, paddingHorizontal: SPACING.base, paddingVertical: SPACING.sm }}
                    accessibilityLabel="다음 주소 검색 열기"
                    accessibilityRole="button"
                >
                    <Text style={{ fontSize: fs.sm, fontWeight: '700', color: COLORS.inkSub }}>주소 정확히 입력</Text>
                </TouchableOpacity>
            </View>

            {/* 로딩 */}
            {isLoading && (
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={COLORS.primary} />
                    <Text style={{ marginTop: 10, color: COLORS.textMuted }}>검색 중...</Text>
                </View>
            )}

            {/* 다음 주소검색 결과 확인 카드 */}
            {!isLoading && pendingResult && (
                <View style={styles.pendingCard}>
                    <View style={styles.pendingCardBadge}>
                        <Text style={styles.pendingCardBadgeText}>다음 주소검색 결과</Text>
                    </View>
                    <Text style={styles.pendingCardName} numberOfLines={2}>
                        {pendingResult.name}
                    </Text>
                    <Text style={styles.pendingCardAddress} numberOfLines={2}>
                        {pendingResult.address}
                    </Text>
                    <Text style={styles.pendingCardCoord}>
                        {pendingResult.latitude.toFixed(6)}, {pendingResult.longitude.toFixed(6)}
                    </Text>
                    <View style={styles.pendingCardButtons}>
                        <TouchableOpacity
                            style={styles.pendingCancelButton}
                            onPress={() => setPendingResult(null)}
                        >
                            <Text style={styles.pendingCancelButtonText}>취소</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.pendingConfirmButton}
                            onPress={confirmPendingResult}
                        >
                            <Text style={styles.pendingConfirmButtonText}>확인 (목록에 추가)</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            )}

            {/* 검색 결과 / 최근 검색 */}
            {!isLoading && !pendingResult && (
                hasSearched ? (
                    <FlatList
                        data={sortedResults}
                        keyExtractor={(item) => item.id}
                        removeClippedSubviews={true}
                        maxToRenderPerBatch={10}
                        windowSize={5}
                        onViewableItemsChanged={onViewableItemsChanged}
                        viewabilityConfig={{ itemVisiblePercentThreshold: 20 }}
                        ListHeaderComponent={
                            <View>
                                <Text style={{ fontSize: fs.base, fontWeight: '700', color: COLORS.textMuted, paddingHorizontal: SPACING.xl3, marginTop: SPACING.base }}>
                                    검색 결과 {sortedResults.length}곳
                                </Text>
                                <View style={{ flexDirection: 'row', gap: SPACING.sm, paddingHorizontal: SPACING.xl3, marginTop: SPACING.base, marginBottom: SPACING.sm }}>
                                    <TouchableOpacity
                                        onPress={() => setListSort('area')}
                                        style={{ paddingHorizontal: SPACING.base, paddingVertical: SPACING.xs, borderRadius: RADIUS.chip, backgroundColor: listSort === 'area' ? COLORS.primaryTint : COLORS.surface }}
                                    >
                                        <Text style={{ fontSize: fs.sm, fontWeight: listSort === 'area' ? '700' : '500', color: listSort === 'area' ? COLORS.primary : COLORS.inkSub }}>부지 넓은 순</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                        onPress={() => setListSort('distance')}
                                        style={{ paddingHorizontal: SPACING.base, paddingVertical: SPACING.xs, borderRadius: RADIUS.chip, backgroundColor: listSort === 'distance' ? COLORS.primaryTint : COLORS.surface }}
                                    >
                                        <Text style={{ fontSize: fs.sm, fontWeight: listSort === 'distance' ? '700' : '500', color: listSort === 'distance' ? COLORS.primary : COLORS.inkSub }}>가까운 순</Text>
                                    </TouchableOpacity>
                                </View>
                            </View>
                        }
                        renderItem={({ item }) => {
                            const key = `${item.latitude.toFixed(6)},${item.longitude.toFixed(6)}`;
                            const area = parcelAreas[key]?.landAreaM2;
                            const viewedAt = findViewedAt(item);
                            const catStyle = item.category ? Object.entries(BUILDING_CATEGORY_STYLE).find(([k]) => item.category?.includes(k))?.[1] : null;
                            return (
                                <TouchableOpacity
                                    onPress={() => moveToLocation(item)}
                                    style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.white, marginHorizontal: SPACING.xl3, marginBottom: SPACING.base, borderRadius: RADIUS.card, padding: SPACING.base }}
                                    accessibilityLabel={`${item.name} 지도에서 보기`}
                                    accessibilityRole="button"
                                >
                                    <View style={{ width: 52, height: 52, borderRadius: RADIUS.button, backgroundColor: catStyle?.bg || COLORS.surface, alignItems: 'center', justifyContent: 'center', marginRight: SPACING.base }}>
                                        <Text style={{ fontSize: fs.sm, fontWeight: '700', color: catStyle?.text || COLORS.inkSub }}>{item.category?.slice(0, 2) || '위치'}</Text>
                                    </View>
                                    <View style={{ flex: 1 }}>
                                        <Text style={{ fontSize: fs.xl, fontWeight: '700', color: COLORS.ink }} numberOfLines={1}>{item.name}</Text>
                                        <Text style={{ fontSize: fs.sm, color: COLORS.textMuted, marginTop: 2 }} numberOfLines={1}>
                                            {area !== undefined ? `${area.toLocaleString()}㎡(${sqmToPyeong(area).toLocaleString()}평) · ` : ''}{formatDistance(item.distance)}
                                        </Text>
                                        {viewedAt && (
                                            <Text style={{ fontSize: fs.sm - 1, fontWeight: '700', color: COLORS.success, marginTop: 4 }}>
                                                {formatShortDate(viewedAt)} 등기 조회함
                                            </Text>
                                        )}
                                    </View>
                                    <Text style={{ fontSize: 20, color: COLORS.chevron }}>{'›'}</Text>
                                </TouchableOpacity>
                            );
                        }}
                        ListEmptyComponent={
                            <View style={styles.emptyContainer}>
                                <Text style={[styles.emptyText, { fontSize: fs.base }]}>검색 결과가 없습니다.</Text>
                            </View>
                        }
                        contentContainerStyle={{ paddingBottom: 100 }}
                    />
                ) : (
                    <ScrollView contentContainerStyle={{ paddingBottom: 100 }}>
                        {recentSearches.length > 0 && (
                            <View style={{ marginTop: SPACING.base }}>
                                <Text style={{ fontSize: fs.base, fontWeight: '700', color: COLORS.textMuted, paddingHorizontal: SPACING.xl3, marginBottom: SPACING.sm }}>최근 검색</Text>
                                {recentSearches.map(term => (
                                    <View key={term} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.xl3, paddingVertical: SPACING.base }}>
                                        <Text style={{ fontSize: 20, color: COLORS.chevron, marginRight: SPACING.base }}>{'◷'}</Text>
                                        <TouchableOpacity style={{ flex: 1 }} onPress={() => { setSearchInput(term); performSearch(term); }}>
                                            <Text style={{ fontSize: fs.xl - 1, color: COLORS.ink }}>{term}</Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity onPress={() => removeRecentSearch(term)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityLabel={`${term} 삭제`} accessibilityRole="button">
                                            <Text style={{ fontSize: 18, color: COLORS.chevron }}>{'×'}</Text>
                                        </TouchableOpacity>
                                    </View>
                                ))}
                            </View>
                        )}
                        <View style={styles.emptyContainer}>
                            <Text style={[styles.emptyText, { fontSize: fs.base }]}>
                                {'주소 또는 건물명으로 검색하거나\n지역으로 찾기를 이용해 보세요.'}
                            </Text>
                        </View>
                    </ScrollView>
                )
            )}

            {/* 다음 우편번호 서비스 모달 */}
            <Modal
                visible={daumModalVisible}
                animationType="slide"
                onRequestClose={() => setDaumModalVisible(false)}
            >
                <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
                    <View style={styles.daumModalHeader}>
                        <Text style={styles.daumModalTitle}>주소 검색</Text>
                        <TouchableOpacity
                            onPress={() => setDaumModalVisible(false)}
                            style={styles.daumModalClose}
                        >
                            <Text style={styles.daumModalCloseText}>닫기</Text>
                        </TouchableOpacity>
                    </View>
                    <WebView
                        source={{ html: DAUM_POSTCODE_HTML, baseUrl: 'https://t1.daumcdn.net' }}
                        onMessage={handleDaumMessage}
                        javaScriptEnabled
                        domStorageEnabled
                        originWhitelist={['*']}
                        mixedContentMode="always"
                        style={{ flex: 1 }}
                    />
                </SafeAreaView>
            </Modal>
        </View>
    );
};

// ===== RecentPlacesScreen =====

const RecentPlacesScreen = ({ onBack, onMoveToMap }: { onBack: () => void; onMoveToMap: () => void }) => {
    const [places, setPlaces] = useState<Building[]>([]);
    const [searchText, setSearchText] = useState('');
    const { setRegion, setSelectedMarker, removeRecentPlace, elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;

    useEffect(() => { loadPlaces(); }, []);

    const loadPlaces = async () => {
        const json = await AsyncStorage.getItem(RECENT_PLACES_KEY);
        setPlaces(json ? JSON.parse(json) : []);
    };

    const filtered = places.filter(p =>
        !searchText || p.name.includes(searchText) || p.address.includes(searchText)
    );

    return (
        <View style={styles.subScreenContainer}>
            <View style={styles.subScreenHeader}>
                <TouchableOpacity onPress={onBack} style={styles.backButton} accessibilityLabel="뒤로 가기" accessibilityRole="button">
                    <Text style={[styles.backButtonText, { fontSize: fs.lg }]}>{'< 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={[styles.subScreenTitle, { fontSize: fs['2xl'] }]}>최근 본 장소</Text>
                <View style={{ width: 50 }} />
            </View>
            <View style={styles.searchContainer}>
                <TextInput style={[styles.searchInput, { fontSize: fs.base }, elderlyMode && { paddingVertical: 12 }]} placeholder="장소 검색..." value={searchText} onChangeText={setSearchText} accessibilityLabel="장소 검색" />
                {searchText.length > 0 && <TouchableOpacity onPress={() => setSearchText('')} style={[styles.clearButton, elderlyMode && { padding: 12 }]} accessibilityLabel="검색어 지우기" accessibilityRole="button"><Text style={[styles.clearButtonText, { fontSize: fs.base }]}>X</Text></TouchableOpacity>}
            </View>
            <FlatList
                data={filtered}
                keyExtractor={(item) => item.id}
                removeClippedSubviews={true}
                maxToRenderPerBatch={10}
                windowSize={5}
                renderItem={({ item }) => (
                    <View style={[styles.listItemContainer, elderlyMode && { minHeight: 72 }]}>
                        <TouchableOpacity style={[styles.listItem, elderlyMode && { padding: 18 }]} onPress={() => {
                            setSelectedMarker(item);
                            setRegion({ latitude: item.latitude, longitude: item.longitude, latitudeDelta: 0.002, longitudeDelta: 0.002 });
                            onMoveToMap();
                        }} accessibilityLabel={`${item.name}, ${item.address}, 지도에서 보기`} accessibilityRole="button">
                            <Text style={[styles.itemName, { fontSize: fs.lg }]}>{item.name}</Text>
                            <Text style={[styles.itemAddress, { fontSize: fs.md }]}>{item.address}</Text>
                            <Text style={[styles.itemDate, { fontSize: fs.sm }]}>{item.timestamp ? new Date(item.timestamp).toLocaleDateString() : ''}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={[styles.deleteButton, elderlyMode && { paddingHorizontal: 16, paddingVertical: 12 }]} onPress={() => {
                            Alert.alert("삭제 확인", "이 장소를 최근 본 장소에서 삭제하시겠습니까?", [
                                { text: "취소", style: "cancel" },
                                { text: "삭제", style: "destructive", onPress: async () => { await removeRecentPlace(item.id); loadPlaces(); } }
                            ]);
                        }} accessibilityLabel={`${item.name} 삭제`} accessibilityRole="button">
                            <Text style={[styles.deleteButtonText, elderlyMode && { fontSize: 14 }]}>삭제</Text>
                        </TouchableOpacity>
                    </View>
                )}
                ListEmptyComponent={
                    searchText ? (
                        <View style={styles.emptyContainer}><Text style={[styles.emptyText, { fontSize: fs.base }]}>검색 결과가 없습니다.</Text></View>
                    ) : (
                        <EmptyState
                            title={'최근 본 장소가\n아직 없어요'}
                            description={'지도에서 장소를 확인하면\n여기에 기록이 남아요.'}
                            ctaLabel="지도 열기"
                            onPressCta={onMoveToMap}
                        />
                    )
                }
            />
        </View>
    );
};

// ===== FavoritePlacesScreen =====

const FavoritePlacesScreen = ({ onBack, onMoveToMap }: { onBack: () => void; onMoveToMap: () => void }) => {
    const [places, setPlaces] = useState<Building[]>([]);
    const [searchText, setSearchText] = useState('');
    const { setRegion, setSelectedMarker, removeFavoritePlace, elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;

    useEffect(() => { loadPlaces(); }, []);

    const loadPlaces = async () => {
        const json = await AsyncStorage.getItem(FAVORITE_PLACES_KEY);
        setPlaces(json ? JSON.parse(json) : []);
    };

    const filtered = places.filter(p =>
        !searchText || p.name.includes(searchText) || p.address.includes(searchText)
    );

    return (
        <View style={styles.subScreenContainer}>
            <View style={styles.subScreenHeader}>
                <TouchableOpacity onPress={onBack} style={styles.backButton} accessibilityLabel="뒤로 가기" accessibilityRole="button">
                    <Text style={[styles.backButtonText, { fontSize: fs.lg }]}>{'< 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={[styles.subScreenTitle, { fontSize: fs['2xl'] }]}>즐겨 찾는 장소</Text>
                <View style={{ width: 50 }} />
            </View>
            <View style={styles.searchContainer}>
                <TextInput style={[styles.searchInput, { fontSize: fs.base }, elderlyMode && { paddingVertical: 12 }]} placeholder="장소 검색..." value={searchText} onChangeText={setSearchText} accessibilityLabel="장소 검색" />
                {searchText.length > 0 && <TouchableOpacity onPress={() => setSearchText('')} style={[styles.clearButton, elderlyMode && { padding: 12 }]} accessibilityLabel="검색어 지우기" accessibilityRole="button"><Text style={[styles.clearButtonText, { fontSize: fs.base }]}>X</Text></TouchableOpacity>}
            </View>
            <FlatList
                data={filtered}
                keyExtractor={(item) => item.id}
                removeClippedSubviews={true}
                maxToRenderPerBatch={10}
                windowSize={5}
                renderItem={({ item }) => (
                    <View style={[styles.listItemContainer, elderlyMode && { minHeight: 72 }]}>
                        <TouchableOpacity style={[styles.listItem, elderlyMode && { padding: 18 }]} onPress={() => {
                            setSelectedMarker(item);
                            setRegion({ latitude: item.latitude, longitude: item.longitude, latitudeDelta: 0.002, longitudeDelta: 0.002 });
                            onMoveToMap();
                        }} accessibilityLabel={`${item.name}, ${item.address}, 지도에서 보기`} accessibilityRole="button">
                            <Text style={[styles.itemName, { fontSize: fs.lg }]}>{item.name}</Text>
                            <Text style={[styles.itemAddress, { fontSize: fs.md }]}>{item.address}</Text>
                            <Text style={[styles.itemDate, { fontSize: fs.sm }]}>{item.timestamp ? new Date(item.timestamp).toLocaleDateString() : ''}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={[styles.deleteButton, elderlyMode && { paddingHorizontal: 16, paddingVertical: 12 }]} onPress={() => {
                            Alert.alert("즐겨찾기 삭제", "이 장소를 즐겨찾기에서 삭제하시겠습니까?", [
                                { text: "취소", style: "cancel" },
                                { text: "삭제", style: "destructive", onPress: async () => { await removeFavoritePlace(item.id); loadPlaces(); } }
                            ]);
                        }} accessibilityLabel={`${item.name} 즐겨찾기에서 삭제`} accessibilityRole="button">
                            <Text style={[styles.deleteButtonText, elderlyMode && { fontSize: 14 }]}>삭제</Text>
                        </TouchableOpacity>
                    </View>
                )}
                ListEmptyComponent={
                    searchText ? (
                        <View style={styles.emptyContainer}><Text style={[styles.emptyText, { fontSize: fs.base }]}>검색 결과가 없습니다.</Text></View>
                    ) : (
                        <EmptyState
                            title={'즐겨찾는 장소가\n아직 없어요'}
                            description={'지도에서 마음에 드는 장소를\n즐겨찾기에 추가해 보세요.'}
                            ctaLabel="지도 열기"
                            onPressCta={onMoveToMap}
                        />
                    )
                }
            />
        </View>
    );
};

// ===== RegistryDetailScreen (등기 열람 상세 - 인라인) =====

const RegistryDetailScreen = ({ record, onBack, onSoftDelete }: {
    record: RegistryViewRecord;
    onBack: () => void;
    onSoftDelete: (id: string) => void;
}) => {
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const [xmlModalVisible, setXmlModalVisible] = useState(false);

    const handleDelete = () => {
        Alert.alert('삭제 확인', '이 열람 이력을 삭제하시겠습니까?\n삭제된 이력은 목록에서 보이지 않습니다.', [
            { text: '취소', style: 'cancel' },
            { text: '삭제', style: 'destructive', onPress: () => { onSoftDelete(record.id); onBack(); } },
        ]);
    };

    // 화면 15: 갑구 → "소유권 변동" 타임라인, 을구 → "잡혀 있는 담보" 목록
    const parsed = record.xml_data ? parseRegistryXml(record.xml_data) : null;
    const ownershipChanges = parsed
        ? [...parsed.gapgu].reverse().map(row => ({
            name: extractOwnerNameFromNomprs(row.nomprs),
            date: extractRegistryDate(row.receve),
            aim: row.aim_cont || '소유권 변동',
        }))
        : [];
    const mortgages = parsed
        ? parsed.eulgu.map(row => ({
            aim: row.aim_cont || '권리사항',
            date: extractRegistryDate(row.receve),
            amount: extractMortgageAmount(row.nomprs),
        }))
        : [];

    return (
        <View style={[styles.subScreenContainer, { backgroundColor: COLORS.surface }]}>
            <View style={[styles.subScreenHeader, { backgroundColor: COLORS.white, borderBottomColor: COLORS.lineSoft }]}>
                <TouchableOpacity onPress={onBack} style={styles.backButton} accessibilityLabel="뒤로 가기" accessibilityRole="button">
                    <Text style={[styles.backButtonText, { fontSize: fs.lg, color: COLORS.primary }]}>{'< 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={[styles.subScreenTitle, { fontSize: fs['2xl'], color: COLORS.ink }]}>등기 내용</Text>
                {record.xml_data ? (
                    <TouchableOpacity onPress={() => setXmlModalVisible(true)} accessibilityLabel="원문 보기" accessibilityRole="button">
                        <Text style={{ color: COLORS.primary, fontSize: fs.base, fontWeight: '700' }}>원문</Text>
                    </TouchableOpacity>
                ) : <View style={{ width: 40 }} />}
            </View>
            <ScrollView contentContainerStyle={{ padding: SPACING.xl3, paddingBottom: 40, gap: SPACING.base }}>
                {/* 요약 카드 */}
                <View style={{ backgroundColor: COLORS.white, borderRadius: RADIUS.sheet - 2, padding: SPACING.xl3 }}>
                    <Text style={{ fontSize: fs.sm, color: COLORS.textMuted }}>이 건물의 주인</Text>
                    <Text style={{ fontSize: fs.xl + 6, fontWeight: '700', color: COLORS.ink, marginTop: 4 }}>
                        {record.owner_name || '확인 안 됨'}
                    </Text>
                    <View style={{ height: 1, backgroundColor: COLORS.lineSoft2, marginVertical: SPACING.base }} />
                    <Text style={{ fontSize: fs.sm, color: COLORS.textMuted }}>주인 주소</Text>
                    <Text style={{ fontSize: fs.lg, color: COLORS.ink, marginTop: 4 }}>
                        {record.owner_address || '확인 안 됨'}
                    </Text>
                </View>

                {/* 소유권 변동 */}
                {ownershipChanges.length > 0 && (
                    <View style={{ backgroundColor: COLORS.white, borderRadius: RADIUS.sheet - 2, padding: SPACING.xl3 }}>
                        <Text style={{ fontSize: fs.base, fontWeight: '700', color: COLORS.inkSub, marginBottom: SPACING.base }}>소유권 변동</Text>
                        {ownershipChanges.map((item, idx) => (
                            <View key={idx} style={{ flexDirection: 'row' }}>
                                <View style={{ width: 20, alignItems: 'center' }}>
                                    <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: idx === 0 ? COLORS.primary : COLORS.chevron, marginTop: 4 }} />
                                    {idx < ownershipChanges.length - 1 && <View style={{ width: 2, flex: 1, backgroundColor: COLORS.line, marginTop: 2 }} />}
                                </View>
                                <View style={{ flex: 1, paddingBottom: idx < ownershipChanges.length - 1 ? SPACING.xl2 : 0, marginLeft: SPACING.sm }}>
                                    <Text style={{ fontSize: fs.lg, fontWeight: '700', color: COLORS.ink }}>{item.name}</Text>
                                    <Text style={{ fontSize: fs.sm, color: COLORS.textMuted, marginTop: 2 }}>{item.date} {item.aim}</Text>
                                </View>
                            </View>
                        ))}
                    </View>
                )}

                {/* 잡혀 있는 담보 */}
                {mortgages.length > 0 && (
                    <View style={{ backgroundColor: COLORS.white, borderRadius: RADIUS.sheet - 2, padding: SPACING.xl3 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.base }}>
                            <Text style={{ fontSize: fs.base, fontWeight: '700', color: COLORS.inkSub, flex: 1 }}>잡혀 있는 담보</Text>
                            <View style={{ backgroundColor: COLORS.warnTint2, borderRadius: RADIUS.chip, paddingHorizontal: SPACING.base, paddingVertical: 3 }}>
                                <Text style={{ fontSize: fs.sm, fontWeight: '700', color: COLORS.warn }}>{mortgages.length}건</Text>
                            </View>
                        </View>
                        {mortgages.map((item, idx) => (
                            <View key={idx} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: SPACING.base, borderTopWidth: idx === 0 ? 0 : 1, borderTopColor: COLORS.lineSoft2 }}>
                                <Text style={{ fontSize: fs.base, color: COLORS.ink, flex: 1 }} numberOfLines={1}>{item.aim} · {item.date}</Text>
                                {item.amount && <Text style={{ fontSize: fs.lg, fontWeight: '700', color: COLORS.ink }}>{item.amount}</Text>}
                            </View>
                        ))}
                    </View>
                )}

                {/* 우편 발송 공유 */}
                {record.owner_name && record.owner_address && (
                    <View style={{ backgroundColor: COLORS.warnTint, borderRadius: RADIUS.card, padding: SPACING.xl2 }}>
                        <Text style={{ fontSize: fs.sm, fontWeight: '700', color: COLORS.warn, marginBottom: SPACING.sm }}>우편 발송 정보</Text>
                        <Text style={{ fontSize: fs.base, color: COLORS.warn, lineHeight: 22, marginBottom: SPACING.base }}>
                            수신: {record.owner_name}{'\n'}주소: {record.owner_address}
                        </Text>
                        <TouchableOpacity
                            style={{ backgroundColor: COLORS.warn, borderRadius: RADIUS.input, paddingVertical: SPACING.base, alignItems: 'center' }}
                            onPress={async () => {
                                const text = `소유자: ${record.owner_name}\n주소: ${record.owner_address}\n부동산: ${record.road_address || record.jibun_address || ''}`;
                                await Share.share({ title: '소유주 발송 정보', message: text });
                            }}
                        >
                            <Text style={{ color: COLORS.white, fontSize: fs.sm, fontWeight: '700' }}>발송 정보 공유</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {/* 삭제 버튼 */}
                <TouchableOpacity
                    style={{ borderWidth: 1.5, borderColor: COLORS.dangerStrong, borderRadius: RADIUS.input, paddingVertical: SPACING.base, alignItems: 'center' }}
                    onPress={handleDelete}
                    accessibilityLabel="이력 삭제"
                    accessibilityRole="button"
                >
                    <Text style={{ color: COLORS.dangerStrong, fontSize: fs.base, fontWeight: '700' }}>이력 삭제</Text>
                </TouchableOpacity>
            </ScrollView>
            <RegistryXmlModal visible={xmlModalVisible} onClose={() => setXmlModalVisible(false)} xmlData={record.xml_data || ''} />
        </View>
    );
};

// ===== RegistryHistoryScreen (등기 열람 이력) =====

const RegistryHistoryScreen = ({ onBack }: { onBack: () => void }) => {
    const [records, setRecords] = useState<RegistryViewRecord[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchText, setSearchText] = useState('');
    const [selectedRecord, setSelectedRecord] = useState<RegistryViewRecord | null>(null);
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;

    useEffect(() => { loadHistory(); }, []);

    const loadHistory = async () => {
        setIsLoading(true);
        try {
            const { data, error } = await supabase
                .from('registry_views')
                .select('*')
                .order('viewed_at', { ascending: false })
                .limit(200);
            if (!error && data) {
                setRecords((data as RegistryViewRecord[]).filter(r => r.disabled_yn !== 'Y'));
            }
        } catch (e) {
            console.warn('열람 이력 조회 실패:', e);
        } finally {
            setIsLoading(false);
        }
    };

    const handleSoftDelete = async (id: string) => {
        try {
            await supabase.from('registry_views').update({ disabled_yn: 'Y' }).eq('id', id);
            setRecords(prev => prev.filter(r => r.id !== id));
        } catch {
            Alert.alert('오류', '삭제에 실패했습니다.');
        }
    };

    const filtered = records.filter(r =>
        !searchText ||
        (r.road_address || '').includes(searchText) ||
        (r.jibun_address || '').includes(searchText) ||
        (r.owner_name || '').includes(searchText)
    );

    const handleExportCSV = async () => {
        const exportable = filtered.filter(r => r.owner_name && r.owner_address);
        if (exportable.length === 0) {
            Alert.alert('내보내기 불가', '소유자 정보가 확인된 항목이 없습니다.');
            return;
        }
        const BOM = '\uFEFF';
        const headers = '소유자명,소유자주소,부동산주소(도로명),부동산주소(지번),열람일시';
        const rows = exportable.map(r => [
            `"${(r.owner_name || '').replace(/"/g, '""')}"`,
            `"${(r.owner_address || '').replace(/"/g, '""')}"`,
            `"${(r.road_address || '').replace(/"/g, '""')}"`,
            `"${(r.jibun_address || '').replace(/"/g, '""')}"`,
            `"${new Date(r.viewed_at).toLocaleString('ko-KR')}"`,
        ].join(',')).join('\n');
        try {
            await Share.share({ title: `소유주 주소 목록 (${exportable.length}건)`, message: BOM + headers + '\n' + rows });
        } catch (e: any) {
            Alert.alert('공유 실패', e.message);
        }
    };

    if (selectedRecord) {
        return <RegistryDetailScreen record={selectedRecord} onBack={() => setSelectedRecord(null)} onSoftDelete={handleSoftDelete} />;
    }

    const thisMonthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const thisMonthCount = records.filter(r => new Date(r.viewed_at) >= thisMonthStart).length;

    return (
        <View style={[styles.subScreenContainer, { backgroundColor: COLORS.surface }]}>
            <View style={[styles.subScreenHeader, { backgroundColor: COLORS.white, borderBottomColor: COLORS.lineSoft }]}>
                <TouchableOpacity onPress={onBack} style={styles.backButton} accessibilityLabel="뒤로 가기" accessibilityRole="button">
                    <Text style={[styles.backButtonText, { fontSize: fs.lg, color: COLORS.primary }]}>{'< 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={[styles.subScreenTitle, { fontSize: fs['2xl'], color: COLORS.ink }]}>등기 열람 이력</Text>
                <TouchableOpacity onPress={handleExportCSV} accessibilityLabel="내보내기" accessibilityRole="button">
                    <Text style={{ color: COLORS.primary, fontSize: fs.base, fontWeight: '700' }}>내보내기</Text>
                </TouchableOpacity>
            </View>

            {!isLoading && (
                <Text style={{ fontSize: fs.base, color: COLORS.textMuted, paddingHorizontal: SPACING.xl3, paddingTop: SPACING.base, paddingBottom: SPACING.sm }}>
                    {filtered.length}건 · 이번 달 {thisMonthCount}건
                </Text>
            )}

            <View style={styles.searchContainer}>
                <TextInput
                    style={[styles.searchInput, { fontSize: fs.base }]}
                    placeholder="주소 또는 소유자명 검색..."
                    value={searchText}
                    onChangeText={setSearchText}
                />
                {searchText.length > 0 && (
                    <TouchableOpacity onPress={() => setSearchText('')} style={styles.clearButton}>
                        <Text style={styles.clearButtonText}>X</Text>
                    </TouchableOpacity>
                )}
            </View>

            {isLoading ? (
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={COLORS.primary} />
                </View>
            ) : (
                <FlatList
                    data={filtered}
                    keyExtractor={(item) => item.id}
                    removeClippedSubviews={true}
                    maxToRenderPerBatch={10}
                    windowSize={5}
                    contentContainerStyle={{ paddingHorizontal: SPACING.xl3, paddingBottom: 100, gap: SPACING.base }}
                    renderItem={({ item }) => (
                        <View style={{ backgroundColor: COLORS.white, borderRadius: RADIUS.sheet - 2, padding: SPACING.xl3 }}>
                            <Text style={{ fontSize: fs.xl, fontWeight: '700', color: COLORS.ink, marginBottom: SPACING.base }} numberOfLines={2}>
                                {item.road_address || item.jibun_address || '주소 없음'}
                            </Text>
                            <View style={{ flexDirection: 'row', marginBottom: 6 }}>
                                <Text style={{ fontSize: fs.base, color: COLORS.textMuted, minWidth: 52 }}>소유자</Text>
                                <Text style={{ fontSize: fs.lg, color: item.owner_name ? COLORS.ink : COLORS.textMuted, fontWeight: '500', flex: 1 }} numberOfLines={1}>
                                    {item.owner_name || '확인 안 됨'}
                                </Text>
                            </View>
                            <View style={{ flexDirection: 'row', marginBottom: SPACING.base }}>
                                <Text style={{ fontSize: fs.base, color: COLORS.textMuted, minWidth: 52 }}>열람일</Text>
                                <Text style={{ fontSize: fs.lg, color: COLORS.ink, fontWeight: '500', flex: 1 }}>
                                    {formatShortDate(item.viewed_at)}
                                </Text>
                            </View>
                            <TouchableOpacity
                                style={{ height: 52, borderRadius: RADIUS.input, backgroundColor: COLORS.surface, alignItems: 'center', justifyContent: 'center' }}
                                onPress={() => setSelectedRecord(item)}
                                accessibilityLabel="내용 보기"
                                accessibilityRole="button"
                            >
                                <Text style={{ fontSize: fs.lg, fontWeight: '700', color: COLORS.inkSub }}>내용 보기</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                    ListEmptyComponent={
                        <View style={styles.emptyContainer}>
                            <Text style={[styles.emptyText, { fontSize: fs.base }]}>
                                {searchText ? '검색 결과가 없습니다.' : '아직 열람한 이력이 없습니다.'}
                            </Text>
                        </View>
                    }
                    refreshing={isLoading}
                    onRefresh={loadHistory}
                />
            )}
        </View>
    );
};

// ===== SalesRecordFlow (화면 07/08 · 영업 기록 2단계) =====

const PLACE_STATUSES: PlaceStatus[] = ['미접촉', '접촉', '미팅예정', '성사', '거절'];
const PLACE_STATUS_COLORS: Record<PlaceStatus, string> = {
    '미접촉': '#9E9E9E',
    '접촉':   '#2196F3',
    '미팅예정': '#FF9800',
    '성사':   '#4CAF50',
    '거절':   '#F44336',
};

// 화면 07: 상태 선택 문장형 라벨
const SALES_RECORD_OPTIONS: { status: PlaceStatus; label: string }[] = [
    { status: '접촉', label: '접촉했어요' },
    { status: '미접촉', label: '아직 연락 전이에요' },
    { status: '미팅예정', label: '미팅이 잡혔어요' },
    { status: '성사', label: '계약이 성사됐어요' },
    { status: '거절', label: '거절당했어요' },
];

// 화면 08: 자주 쓰는 문구 + 다시 연락할 날 선택지
const SALES_RECORD_QUICK_PHRASES = ['관심 있어 하셨어요', '부재중이었어요', '다음에 다시 방문하기로 했어요'];
const NEXT_CONTACT_OPTIONS: { label: string; days: number }[] = [
    { label: '내일', days: 1 },
    { label: '3일 뒤', days: 3 },
    { label: '1주 뒤', days: 7 },
];

interface SalesRecordFlowProps {
    visible: boolean;
    onClose: () => void;
    onSaved: () => void;
    latitude: number;
    longitude: number;
    address: string;
}

const SalesRecordFlow = ({ visible, onClose, onSaved, latitude, longitude, address }: SalesRecordFlowProps) => {
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const [step, setStep] = useState<'status' | 'detail'>('status');
    const [record, setRecord] = useState<PlaceRecord | null>(null);
    const [status, setStatus] = useState<PlaceStatus | null>(null);
    const [memo, setMemo] = useState('');
    const [nextContactDays, setNextContactDays] = useState<number | null>(null);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        if (!visible) return;
        setStep('status');
        setNextContactDays(null);
        (async () => {
            const delta = 0.001;
            const { data } = await supabase
                .from('places')
                .select('*')
                .gte('lat', latitude - delta)
                .lte('lat', latitude + delta)
                .gte('lng', longitude - delta)
                .lte('lng', longitude + delta)
                .limit(1)
                .maybeSingle();
            if (data) {
                const r = data as PlaceRecord;
                setRecord(r);
                setStatus(r.status);
                setMemo(r.memo || '');
            } else {
                setRecord(null);
                setStatus(null);
                setMemo('');
            }
        })();
    }, [visible, latitude, longitude]);

    const nextContactDate = nextContactDays !== null
        ? new Date(Date.now() + nextContactDays * 24 * 60 * 60 * 1000)
        : null;

    const handleSave = async () => {
        if (!status) return;
        setIsSaving(true);
        try {
            const payload = {
                lat: latitude,
                lng: longitude,
                road_address: address,
                jibun_address: null,
                status,
                status_date: nextContactDate ? nextContactDate.toISOString().split('T')[0] : (record?.status_date ?? null),
                memo: memo || null,
                updated_at: new Date().toISOString(),
            };
            let placeId = record?.id;
            if (record) {
                await supabase.from('places').update(payload).eq('id', record.id);
            } else {
                const { data } = await supabase.from('places').insert([{ ...payload, created_at: new Date().toISOString() }]).select('id').single();
                placeId = data?.id;
            }
            if (nextContactDate && placeId) {
                await scheduleFollowUpNotification(placeId, address, nextContactDate);
            }
            onSaved();
            onClose();
        } catch (e) {
            Alert.alert('저장 실패', '저장 중 오류가 발생했습니다.');
        }
        setIsSaving(false);
    };

    if (!visible) return null;

    const stepIndicator = (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingTop: SPACING.lg, paddingBottom: SPACING.base }}>
            <TouchableOpacity
                onPress={() => step === 'status' ? onClose() : setStep('status')}
                style={{ position: 'absolute', left: SPACING.xl3 }}
                accessibilityLabel={step === 'status' ? '닫기' : '이전 단계'}
                accessibilityRole="button"
            >
                <Text style={{ fontSize: 26, color: COLORS.inkSub }}>{step === 'status' ? '×' : '‹'}</Text>
            </TouchableOpacity>
            <View style={{ flexDirection: 'row', gap: 6 }}>
                <View style={{ width: 26, height: 6, borderRadius: 3, backgroundColor: COLORS.primary }} />
                <View style={{ width: 26, height: 6, borderRadius: 3, backgroundColor: step === 'detail' ? COLORS.primary : COLORS.line }} />
            </View>
        </View>
    );

    return (
        <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
            <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.white }}>
                {stepIndicator}
                {step === 'status' ? (
                    <View style={{ flex: 1, paddingHorizontal: SPACING.xl3 }}>
                        <Text style={{ fontSize: fs.xl + 10, fontWeight: '700', color: COLORS.ink, lineHeight: 38, letterSpacing: -0.7, marginTop: SPACING.base }}>
                            {'이 장소는\n어떤 상태인가요?'}
                        </Text>
                        <Text style={{ fontSize: fs.base, color: COLORS.textMuted, marginTop: SPACING.sm }} numberOfLines={2}>{address}</Text>

                        <ScrollView style={{ marginTop: SPACING.xl3 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 100 }}>
                            {SALES_RECORD_OPTIONS.map(opt => {
                                const selected = status === opt.status;
                                return (
                                    <TouchableOpacity
                                        key={opt.status}
                                        onPress={() => setStatus(opt.status)}
                                        style={{
                                            flexDirection: 'row', alignItems: 'center',
                                            height: 72, borderRadius: RADIUS.card,
                                            borderWidth: selected ? 2 : 1.5, borderColor: selected ? COLORS.primary : COLORS.line,
                                            backgroundColor: selected ? COLORS.primarySelectedBg : COLORS.white,
                                            paddingHorizontal: SPACING.xl2, marginBottom: SPACING.base,
                                        }}
                                        accessibilityRole="button"
                                        accessibilityState={{ selected }}
                                    >
                                        <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: PLACE_STATUS_COLORS[opt.status], marginRight: SPACING.base }} />
                                        <Text style={{ flex: 1, fontSize: fs.lg, fontWeight: '700', color: COLORS.ink }}>{opt.label}</Text>
                                        {selected && <Text style={{ fontSize: 24, color: COLORS.primary, fontWeight: '700' }}>{'✓'}</Text>}
                                    </TouchableOpacity>
                                );
                            })}
                        </ScrollView>
                    </View>
                ) : (
                    <View style={{ flex: 1, paddingHorizontal: SPACING.xl3 }}>
                        <Text style={{ fontSize: fs.xl + 10, fontWeight: '700', color: COLORS.ink, letterSpacing: -0.7, marginTop: SPACING.base }}>
                            무슨 내용이었나요?
                        </Text>
                        <ScrollView style={{ marginTop: SPACING.xl3 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 100 }}>
                            <TextInput
                                style={{ backgroundColor: COLORS.surface, borderRadius: RADIUS.card, padding: SPACING.xl3, minHeight: 150, fontSize: 18, lineHeight: 30, color: COLORS.ink, textAlignVertical: 'top' }}
                                value={memo}
                                onChangeText={setMemo}
                                placeholder="메모를 입력하세요"
                                placeholderTextColor={COLORS.textMuted}
                                multiline
                            />
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, marginTop: SPACING.base }}>
                                {SALES_RECORD_QUICK_PHRASES.map(phrase => (
                                    <TouchableOpacity
                                        key={phrase}
                                        onPress={() => setMemo(m => m ? `${m} ${phrase}` : phrase)}
                                        style={{ borderWidth: 1.5, borderColor: COLORS.line, borderRadius: RADIUS.chip + 2, paddingHorizontal: SPACING.base, paddingVertical: SPACING.md, backgroundColor: COLORS.white }}
                                    >
                                        <Text style={{ fontSize: fs.sm + 1, color: COLORS.inkSub }}>{phrase}</Text>
                                    </TouchableOpacity>
                                ))}
                            </View>

                            <Text style={{ fontSize: fs.base, fontWeight: '700', color: COLORS.inkSub, marginTop: SPACING.xl3, marginBottom: SPACING.base }}>다시 연락할 날</Text>
                            <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
                                {NEXT_CONTACT_OPTIONS.map(opt => {
                                    const selected = nextContactDays === opt.days;
                                    return (
                                        <TouchableOpacity
                                            key={opt.label}
                                            onPress={() => setNextContactDays(selected ? null : opt.days)}
                                            style={{ flex: 1, height: 60, borderRadius: RADIUS.button, borderWidth: selected ? 2 : 1.5, borderColor: selected ? COLORS.primary : COLORS.line, backgroundColor: selected ? COLORS.primarySelectedBg : COLORS.white, alignItems: 'center', justifyContent: 'center' }}
                                            accessibilityRole="button"
                                            accessibilityState={{ selected }}
                                        >
                                            <Text style={{ fontSize: fs.base, fontWeight: '700', color: selected ? COLORS.primary : COLORS.inkSub }}>{opt.label}</Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>

                            {nextContactDate && (
                                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: SPACING.xl2 }}>
                                    <View style={{ width: 20, height: 18, borderRadius: 4, borderWidth: 2, borderColor: COLORS.textMuted, marginRight: SPACING.sm }} />
                                    <Text style={{ fontSize: fs.base, color: COLORS.textMuted }}>
                                        {nextContactDate.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })} · 알림이 예약됩니다
                                    </Text>
                                </View>
                            )}
                        </ScrollView>
                    </View>
                )}

                {/* 하단 고정 CTA */}
                <TouchableOpacity
                    disabled={step === 'status' ? !status : isSaving}
                    onPress={() => step === 'status' ? setStep('detail') : handleSave()}
                    style={{
                        position: 'absolute', left: 20, right: 20, bottom: 28, height: 64,
                        borderRadius: RADIUS.button, backgroundColor: COLORS.primary,
                        alignItems: 'center', justifyContent: 'center',
                        opacity: (step === 'status' && !status) ? 0.4 : 1,
                        ...ELEVATION.primaryBtn,
                    }}
                    accessibilityRole="button"
                >
                    {isSaving
                        ? <ActivityIndicator color={COLORS.white} />
                        : <Text style={{ fontSize: fs.xl + 2, fontWeight: '700', color: COLORS.white }}>{step === 'status' ? '다음' : '저장하기'}</Text>}
                </TouchableOpacity>
            </SafeAreaView>
        </Modal>
    );
};

// ===== SalesActivityScreen =====

const SalesActivityScreen = ({ onBack }: { onBack: () => void }) => {
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;

    const today = new Date();
    const [selectedDate, setSelectedDate] = useState<Date>(today);
    const [logs, setLogs] = useState<ActivityLog[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [showDateInput, setShowDateInput] = useState(false);
    const [dateInput, setDateInput] = useState('');

    const formatDate = (d: Date) => d.toISOString().split('T')[0];
    const isToday = formatDate(selectedDate) === formatDate(today);

    const loadLogs = useCallback(async (date: Date) => {
        setIsLoading(true);
        const dateStr = formatDate(date);
        const { data } = await supabase
            .from('activity_logs')
            .select('*')
            .gte('visited_at', `${dateStr}T00:00:00`)
            .lte('visited_at', `${dateStr}T23:59:59`)
            .order('visited_at', { ascending: true });
        setLogs(data || []);
        setIsLoading(false);
    }, []);

    useEffect(() => { loadLogs(selectedDate); }, [selectedDate]);

    const goToPrev = () => {
        const d = new Date(selectedDate);
        d.setDate(d.getDate() - 1);
        setSelectedDate(d);
    };
    const goToNext = () => {
        if (isToday) return;
        const d = new Date(selectedDate);
        d.setDate(d.getDate() + 1);
        if (formatDate(d) <= formatDate(today)) setSelectedDate(d);
    };

    const totalKm = logs.reduce((s, l) => s + (l.distance_from_prev_km || 0), 0);
    const visitCount = logs.length;

    // 이동 경로: 연속 중복 제거 후 "A → B → C"
    const routeStr = (() => {
        const addrs = logs.map(l => l.address || '').filter(Boolean);
        const deduped: string[] = [];
        for (const a of addrs) { if (deduped[deduped.length - 1] !== a) deduped.push(a); }
        return deduped.join(' → ') || '-';
    })();

    const salesLogs = logs.filter(l => l.sales_status_at_visit !== null);

    const displayDate = selectedDate.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });

    const cardStyle = { backgroundColor: '#fff', borderRadius: 8, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: '#E4E4E7' };

    return (
        <View style={styles.subScreenContainer}>
            <View style={styles.subScreenHeader}>
                <TouchableOpacity onPress={onBack} style={styles.backButton}>
                    <Text style={[styles.backButtonText, { fontSize: fs.lg }]}>{'< 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={[styles.subScreenTitle, { fontSize: fs['2xl'] }]}>영업 동선</Text>
                <View style={{ width: 60 }} />
            </View>

            {/* 날짜 네비게이션 */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#E4E4E7' }}>
                <TouchableOpacity onPress={goToPrev} style={{ paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#F4F4F5', borderRadius: 6 }}>
                    <Text style={{ fontSize: fs.sm, color: '#18181B' }}>{'< 이전'}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { setDateInput(formatDate(selectedDate)); setShowDateInput(v => !v); }}>
                    <Text style={{ fontSize: fs.sm, fontWeight: '600', color: '#18181B' }}>{displayDate}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                    onPress={goToNext}
                    disabled={isToday}
                    style={{ paddingHorizontal: 12, paddingVertical: 6, backgroundColor: isToday ? '#F4F4F5' : '#18181B', borderRadius: 6 }}
                >
                    <Text style={{ fontSize: fs.sm, color: isToday ? '#A1A1AA' : '#fff' }}>{'다음 >'}</Text>
                </TouchableOpacity>
            </View>

            {showDateInput && (
                <View style={{ paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#FAFAFA', borderBottomWidth: 1, borderBottomColor: '#E4E4E7', flexDirection: 'row', gap: 8 }}>
                    <TextInput
                        value={dateInput}
                        onChangeText={setDateInput}
                        placeholder="YYYY-MM-DD"
                        keyboardType="numeric"
                        style={{ flex: 1, borderWidth: 1, borderColor: '#E4E4E7', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6, fontSize: fs.sm, backgroundColor: '#fff' }}
                    />
                    <TouchableOpacity
                        onPress={() => {
                            const parsed = new Date(dateInput);
                            if (!isNaN(parsed.getTime()) && dateInput <= formatDate(today)) {
                                setSelectedDate(parsed);
                                setShowDateInput(false);
                            }
                        }}
                        style={{ backgroundColor: '#18181B', borderRadius: 6, paddingHorizontal: 14, paddingVertical: 6, justifyContent: 'center' }}
                    >
                        <Text style={{ color: '#fff', fontSize: fs.sm }}>이동</Text>
                    </TouchableOpacity>
                </View>
            )}

            <ScrollView contentContainerStyle={{ padding: 16 }}>
                {isLoading ? (
                    <ActivityIndicator color="#18181B" style={{ marginTop: 40 }} />
                ) : logs.length === 0 ? (
                    <View style={{ alignItems: 'center', paddingTop: 60 }}>
                        <Text style={{ fontSize: fs.base, color: '#71717A' }}>이 날의 영업 기록이 없습니다.</Text>
                    </View>
                ) : (
                    <>
                        {/* 요약 카드 */}
                        <View style={[cardStyle, { flexDirection: 'row', gap: 12 }]}>
                            <View style={{ flex: 1, alignItems: 'center', borderRightWidth: 1, borderRightColor: '#E4E4E7' }}>
                                <Text style={{ fontSize: fs.xs, color: '#71717A', marginBottom: 4 }}>총 이동거리</Text>
                                <Text style={{ fontSize: fs['2xl'], fontWeight: '700', color: '#18181B' }}>{totalKm.toFixed(1)} km</Text>
                            </View>
                            <View style={{ flex: 1, alignItems: 'center' }}>
                                <Text style={{ fontSize: fs.xs, color: '#71717A', marginBottom: 4 }}>방문 기록</Text>
                                <Text style={{ fontSize: fs['2xl'], fontWeight: '700', color: '#18181B' }}>{visitCount}곳</Text>
                            </View>
                        </View>

                        {/* 이동 경로 */}
                        <View style={cardStyle}>
                            <Text style={{ fontSize: fs.sm, fontWeight: '600', color: '#52525B', marginBottom: 8 }}>이동 경로</Text>
                            <Text style={{ fontSize: fs.sm, color: '#18181B', lineHeight: 20 }}>{routeStr}</Text>
                        </View>

                        {/* 영업진전사항 */}
                        {salesLogs.length > 0 && (
                            <View style={cardStyle}>
                                <Text style={{ fontSize: fs.sm, fontWeight: '600', color: '#52525B', marginBottom: 10 }}>영업진전사항</Text>
                                {salesLogs.map(l => (
                                    <View key={l.id} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                                        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: SALES_STATUS_COLORS[l.sales_status_at_visit as SalesStatus] || '#9E9E9E', marginRight: 8 }} />
                                        <View style={{ flex: 1 }}>
                                            <Text style={{ fontSize: fs.xs, color: '#71717A' }}>{new Date(l.visited_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</Text>
                                            <Text style={{ fontSize: fs.sm, color: '#18181B' }}>{l.address || '주소 없음'}</Text>
                                        </View>
                                        <View style={{ backgroundColor: SALES_STATUS_COLORS[l.sales_status_at_visit as SalesStatus] || '#9E9E9E', borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 }}>
                                            <Text style={{ fontSize: fs.xs, color: '#fff', fontWeight: '600' }}>{l.sales_status_at_visit}</Text>
                                        </View>
                                    </View>
                                ))}
                            </View>
                        )}

                        {/* 방문 타임라인 */}
                        <View style={cardStyle}>
                            <Text style={{ fontSize: fs.sm, fontWeight: '600', color: '#52525B', marginBottom: 10 }}>방문 기록 타임라인</Text>
                            {logs.map((l, i) => (
                                <View key={l.id} style={{ flexDirection: 'row', marginBottom: 10 }}>
                                    <View style={{ width: 32, alignItems: 'center' }}>
                                        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#18181B', marginTop: 3 }} />
                                        {i < logs.length - 1 && <View style={{ width: 2, flex: 1, backgroundColor: '#E4E4E7', marginTop: 2 }} />}
                                    </View>
                                    <View style={{ flex: 1, paddingBottom: 4 }}>
                                        <Text style={{ fontSize: fs.xs, color: '#71717A' }}>{new Date(l.visited_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}{l.distance_from_prev_km > 0 ? `  +${l.distance_from_prev_km.toFixed(2)}km` : ''}</Text>
                                        <Text style={{ fontSize: fs.sm, color: '#18181B', marginTop: 1 }}>{l.address || `${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}`}</Text>
                                    </View>
                                </View>
                            ))}
                        </View>
                    </>
                )}
            </ScrollView>
        </View>
    );
};

// ===== MoabogiCards (영업 탭 · 오늘 할 일) =====

interface MoabogiCardsProps {
    onShowPlaces: () => void;
    onShowNotifications: () => void;
    onShowReminders: () => void;
    onShowActivity: () => void;
    onShowStats: () => void;
    onOpenProperty: (propertyId: string) => void;
}

const HomeSkeleton = ({ fs }: { fs: typeof FONT_SCALE.normal }) => (
    <>
        {[0, 1].map(i => (
            <View key={i} style={{ backgroundColor: '#fff', borderRadius: 8, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: '#E4E4E7' }}>
                <SkeletonBox width={120} height={12} style={{ marginBottom: 10 }} />
                <SkeletonBox width={60} height={24} />
            </View>
        ))}
        <View style={{ backgroundColor: '#fff', borderRadius: 8, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: '#E4E4E7' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
                <SkeletonBox width={100} height={12} />
                <View style={{ flex: 1 }} />
                <SkeletonBox width={40} height={16} />
            </View>
            <View style={{ flexDirection: 'row', gap: 6 }}>
                {[0, 1, 2, 3].map(i => <SkeletonBox key={i} width={70} height={24} />)}
            </View>
        </View>
    </>
);

const MoabogiCards = ({ onShowPlaces, onShowNotifications, onShowReminders, onShowActivity, onShowStats, onOpenProperty }: MoabogiCardsProps) => {
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const [placeCounts, setPlaceCounts] = useState<Record<PlaceStatus, number>>({
        '미접촉': 0, '접촉': 0, '미팅예정': 0, '성사': 0, '거절': 0,
    });
    const [isLoading, setIsLoading] = useState(true);
    const [unreadCount, setUnreadCount] = useState(0);
    const [todayActivityKm, setTodayActivityKm] = useState(0);
    const [todayVisitCount, setTodayVisitCount] = useState(0);
    const [todoItems, setTodoItems] = useState<Array<{
        property_id: string;
        building_name: string | null;
        road_address: string | null;
        sales_status: SalesStatus;
        next_contact_date: string;
    }>>([]);

    useEffect(() => {
        (async () => {
            try {
                const todayStr = new Date().toISOString().split('T')[0];
                const threeDaysLater = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
                const [placesRes, improvRes, lastCountStr, unread, todayLogs, todoRes] = await Promise.all([
                    supabase.from('places').select('status'),
                    supabase.from('improvements').select('id', { count: 'exact', head: true }),
                    AsyncStorage.getItem(LAST_IMPROVEMENTS_COUNT_KEY),
                    getUnreadNotificationCount(),
                    supabase.from('activity_logs').select('distance_from_prev_km')
                        .gte('visited_at', `${todayStr}T00:00:00`)
                        .lte('visited_at', `${todayStr}T23:59:59`),
                    supabase.from('properties')
                        .select('property_id, building_name, road_address, sales_status, next_contact_date')
                        .not('next_contact_date', 'is', null)
                        .lte('next_contact_date', threeDaysLater)
                        .order('next_contact_date', { ascending: true })
                        .limit(5),
                ]);
                const counts: Record<PlaceStatus, number> = { '미접촉': 0, '접촉': 0, '미팅예정': 0, '성사': 0, '거절': 0 };
                (placesRes.data || []).forEach((row: { status: string }) => {
                    const s = row.status as PlaceStatus;
                    if (s in counts) counts[s]++;
                });
                setPlaceCounts(counts);
                setUnreadCount(unread);
                const logs = todayLogs.data || [];
                setTodayActivityKm(logs.reduce((s: number, l: { distance_from_prev_km: number }) => s + (l.distance_from_prev_km || 0), 0));
                setTodayVisitCount(logs.length);
                setTodoItems((todoRes.data || []) as typeof todoItems);
                // 개선사항 새 항목 알림 체크
                const currentImprovCount = improvRes.count ?? 0;
                const lastCount = lastCountStr ? parseInt(lastCountStr, 10) : null;
                if (lastCount !== null && currentImprovCount > lastCount) {
                    await addNotification('improvement', `개선사항 ${currentImprovCount - lastCount}건이 새로 등록되었습니다.`);
                    const newUnread = await getUnreadNotificationCount();
                    setUnreadCount(newUnread);
                }
                await AsyncStorage.setItem(LAST_IMPROVEMENTS_COUNT_KEY, String(currentImprovCount));
            } catch (_) {}
            setIsLoading(false);
        })();
    }, []);

    const totalPlaces = Object.values(placeCounts).reduce((a, b) => a + b, 0);
    const inProgressPlaces = placeCounts['접촉'] + placeCounts['미팅예정'];
    const now = new Date();
    const today = now.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });

    if (isLoading) {
        return (
            <View style={{ backgroundColor: COLORS.surface }}>
                <HomeSkeleton fs={fs} />
            </View>
        );
    }

    return (
        <View style={{ backgroundColor: COLORS.surface }}>
            {/* 헤더 */}
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: SPACING.xl4 }}>
                <View>
                    <Text style={{ fontSize: fs['2xl'] + 4, fontWeight: '700', color: COLORS.ink }}>오늘 할 일</Text>
                    <Text style={{ fontSize: fs.base, color: COLORS.textMuted, marginTop: 4 }}>{today} · 방문 {todayVisitCount}곳</Text>
                </View>
                <TouchableOpacity
                    onPress={onShowNotifications}
                    style={{ width: 52, height: 52, borderRadius: RADIUS.button, backgroundColor: COLORS.white, alignItems: 'center', justifyContent: 'center' }}
                    accessibilityLabel="알림"
                    accessibilityRole="button"
                >
                    <View style={{ width: 14, height: 14, borderTopLeftRadius: 7, borderTopRightRadius: 7, borderWidth: 2, borderColor: COLORS.inkSub, borderBottomWidth: 0 }} />
                    <View style={{ width: 18, height: 2, backgroundColor: COLORS.inkSub, marginTop: 1 }} />
                    {unreadCount > 0 && (
                        <View style={{ position: 'absolute', top: 10, right: 12, width: 10, height: 10, borderRadius: 5, backgroundColor: COLORS.dangerStrong }} />
                    )}
                </TouchableOpacity>
            </View>

            {/* 할 일 카드 */}
            <View style={{ backgroundColor: COLORS.white, borderRadius: RADIUS.sheet - 4, paddingHorizontal: SPACING.xl2, marginBottom: SPACING.base }}>
                {todoItems.length === 0 ? (
                    <View style={{ paddingVertical: SPACING.xl4, alignItems: 'center' }}>
                        <Text style={{ fontSize: fs.base, color: COLORS.textMuted }}>오늘 예정된 연락이 없어요</Text>
                    </View>
                ) : (
                    todoItems.map((item, idx) => {
                        const contactDate = new Date(item.next_contact_date);
                        const diffDays = Math.ceil((contactDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
                        const isOverdue = diffDays < 0;
                        const isToday = diffDays === 0;
                        const dLabel = isOverdue ? '지남' : isToday ? '오늘' : `${diffDays}일 뒤`;
                        const dBg = isOverdue ? COLORS.dangerTint : isToday ? COLORS.warnTint : COLORS.primaryTint;
                        const dColor = isOverdue ? COLORS.danger : isToday ? COLORS.warn : COLORS.primary;
                        const name = item.building_name || item.road_address || item.property_id;
                        return (
                            <TouchableOpacity
                                key={item.property_id}
                                onPress={() => onOpenProperty(item.property_id)}
                                style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: SPACING.xl, borderTopWidth: idx === 0 ? 0 : 1, borderTopColor: COLORS.lineSoft2 }}
                            >
                                <View style={{ minWidth: 58, height: 34, borderRadius: RADIUS.chip, backgroundColor: dBg, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, marginRight: SPACING.base }}>
                                    <Text style={{ fontSize: fs.sm, fontWeight: '700', color: dColor }}>{dLabel}</Text>
                                </View>
                                <View style={{ flex: 1 }}>
                                    <Text style={{ fontSize: fs.lg, fontWeight: '700', color: COLORS.ink }} numberOfLines={1}>{name}</Text>
                                    <Text style={{ fontSize: fs.base, color: COLORS.textMuted, marginTop: 2 }} numberOfLines={1}>{item.sales_status}</Text>
                                </View>
                                <Text style={{ fontSize: 20, color: COLORS.chevron }}>{'›'}</Text>
                            </TouchableOpacity>
                        );
                    })
                )}
            </View>
            {todoItems.length > 0 && (
                <TouchableOpacity onPress={onShowReminders} style={{ alignSelf: 'flex-end', marginBottom: SPACING.xl2 }}>
                    <Text style={{ fontSize: fs.sm, color: COLORS.primary, fontWeight: '700' }}>전체 보기 {'›'}</Text>
                </TouchableOpacity>
            )}

            {/* 지표 카드 2개 */}
            <View style={{ flexDirection: 'row', gap: SPACING.base, marginBottom: SPACING.base }}>
                <TouchableOpacity onPress={onShowPlaces} style={{ flex: 1, backgroundColor: COLORS.white, borderRadius: RADIUS.card, padding: SPACING.xl2 }}>
                    <Text style={{ fontSize: fs.base, color: COLORS.textMuted }}>내가 관리하는 장소</Text>
                    <Text style={{ fontSize: fs.xl + 12, fontWeight: '700', color: COLORS.ink, marginTop: SPACING.xs }}>{totalPlaces}곳</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={onShowActivity} style={{ flex: 1, backgroundColor: COLORS.white, borderRadius: RADIUS.card, padding: SPACING.xl2 }}>
                    <Text style={{ fontSize: fs.base, color: COLORS.textMuted }}>오늘 이동</Text>
                    <Text style={{ fontSize: fs.xl + 12, fontWeight: '700', color: COLORS.ink, marginTop: SPACING.xs }}>{todayActivityKm.toFixed(1)} km</Text>
                </TouchableOpacity>
            </View>

            {/* 이번 달 성과 */}
            <TouchableOpacity onPress={onShowStats} style={{ backgroundColor: COLORS.white, borderRadius: RADIUS.card, padding: SPACING.xl2 }}>
                <Text style={{ fontSize: fs.base, fontWeight: '700', color: COLORS.inkSub, marginBottom: SPACING.base }}>이번 달 성과</Text>
                <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
                    {[
                        { label: '성사', value: placeCounts['성사'], color: COLORS.success },
                        { label: '진행중', value: inProgressPlaces, color: COLORS.primary },
                        { label: '미접촉', value: placeCounts['미접촉'], color: COLORS.textMuted },
                    ].map(item => (
                        <View key={item.label} style={{ flex: 1, backgroundColor: COLORS.surface, borderRadius: RADIUS.input, paddingVertical: SPACING.base, alignItems: 'center' }}>
                            <Text style={{ fontSize: fs.sm, color: COLORS.textMuted, marginBottom: 4 }}>{item.label}</Text>
                            <Text style={{ fontSize: fs.xl + 4, fontWeight: '700', color: item.color }}>{item.value}</Text>
                        </View>
                    ))}
                </View>
            </TouchableOpacity>
        </View>
    );
};

// ===== RegionSelectScreen (토스 스타일 스텝 선택) =====

// 전국 도/광역시 기본 데이터 (Supabase 미연결 시 폴백)
const DEFAULT_PROVINCES: { name: string; short: string; lat: number; lng: number }[] = [
    { name: '서울특별시', short: '서울', lat: 37.5665, lng: 126.9780 },
    { name: '경기도', short: '경기', lat: 37.2750, lng: 127.0095 },
    { name: '인천광역시', short: '인천', lat: 37.4563, lng: 126.7052 },
    { name: '부산광역시', short: '부산', lat: 35.1796, lng: 129.0756 },
    { name: '대구광역시', short: '대구', lat: 35.8714, lng: 128.6014 },
    { name: '광주광역시', short: '광주', lat: 35.1595, lng: 126.8526 },
    { name: '대전광역시', short: '대전', lat: 36.3504, lng: 127.3845 },
    { name: '울산광역시', short: '울산', lat: 35.5384, lng: 129.3114 },
    { name: '세종특별자치시', short: '세종', lat: 36.4800, lng: 127.2590 },
    { name: '강원특별자치도', short: '강원', lat: 37.8228, lng: 128.1555 },
    { name: '충청북도', short: '충북', lat: 36.6357, lng: 127.4917 },
    { name: '충청남도', short: '충남', lat: 36.6588, lng: 126.6728 },
    { name: '전북특별자치도', short: '전북', lat: 35.8203, lng: 127.1089 },
    { name: '전라남도', short: '전남', lat: 34.8161, lng: 126.4629 },
    { name: '경상북도', short: '경북', lat: 36.4919, lng: 128.8889 },
    { name: '경상남도', short: '경남', lat: 35.4606, lng: 128.2132 },
    { name: '제주특별자치도', short: '제주', lat: 33.4996, lng: 126.5312 },
];

const CITIES_PER_PAGE = 12;

interface RegionSelectScreenProps {
    onBack: () => void;
    onComplete: (province: string, city: string, lat: number, lng: number, zoom?: number) => void;
}

const RegionSelectScreen = React.memo(({ onBack, onComplete }: RegionSelectScreenProps) => {
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const ts = elderlyMode ? TOUCH_SIZE.elderly : TOUCH_SIZE.normal;

    type Step = 'province' | 'city' | 'condition';
    type ConditionType = 'urban' | 'industrial';
    const [step, setStep] = useState<Step>('province');
    const [selectedProvince, setSelectedProvince] = useState<string | null>(null);
    const [selectedCity, setSelectedCity] = useState<string | null>(null);
    const [selectedCityCoords, setSelectedCityCoords] = useState<{ lat: number; lng: number } | null>(null);
    const [cityPage, setCityPage] = useState(0);

    // Step 3 상태
    const [selectedCondition, setSelectedCondition] = useState<ConditionType | null>(null);
    type IndustrialItem = { id: string; name: string; lat: number; lng: number; address: string };
    const [industrialList, setIndustrialList] = useState<IndustrialItem[]>([]);
    const [loadingIndustrial, setLoadingIndustrial] = useState(false);
    const [selectedIndustrial, setSelectedIndustrial] = useState<IndustrialItem | null>(null);

    // Supabase 데이터 상태
    const [provinces, setProvinces] = useState<{ name: string; short: string; lat: number; lng: number; id?: string }[]>(DEFAULT_PROVINCES);
    const [cities, setCities] = useState<{ name: string; lat: number; lng: number }[]>([]);
    const [loadingProvinces, setLoadingProvinces] = useState(true);
    const [loadingCities, setLoadingCities] = useState(false);

    // Supabase에서 도/광역시 목록 로드
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const { data, error } = await supabase
                    .from('provinces')
                    .select('id, name, short_name, latitude, longitude, sort_order')
                    .order('sort_order', { ascending: true });
                if (!cancelled && data && data.length > 0 && !error) {
                    setProvinces(data.map((p: any) => ({
                        id: p.id,
                        name: p.name,
                        short: p.short_name,
                        lat: p.latitude,
                        lng: p.longitude,
                    })));
                }
            } catch {
                // Supabase 미연결 시 폴백 데이터 유지
            } finally {
                if (!cancelled) setLoadingProvinces(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // 선택된 도/광역시의 시/군/구 로드
    const loadCities = useCallback(async (provinceName: string) => {
        setLoadingCities(true);
        setCities([]);
        setCityPage(0);
        setSelectedCity(null);

        try {
            // 1) Supabase에서 조회 시도
            const provinceMatch = provinces.find(p => p.name === provinceName);
            if (provinceMatch?.id) {
                const { data, error } = await supabase
                    .from('cities')
                    .select('name, latitude, longitude, sort_order')
                    .eq('province_id', provinceMatch.id)
                    .order('sort_order', { ascending: true });
                if (data && data.length > 0 && !error) {
                    setCities(data.map((c: any) => ({ name: c.name, lat: c.latitude, lng: c.longitude })));
                    setLoadingCities(false);
                    return;
                }
            }

            // 2) 폴백: regions.ts 로컬 데이터
            const regionMatch = REGIONS.find(r => r.name === provinceName || r.short === provinceMatch?.short);
            if (regionMatch) {
                setCities(regionMatch.cities.map(c => ({ name: c.name, lat: c.latitude, lng: c.longitude })));
            } else {
                setCities([]);
            }
        } catch {
            // 폴백: regions.ts
            const shortName = provinces.find(p => p.name === provinceName)?.short;
            const regionMatch = REGIONS.find(r => r.name === provinceName || r.short === shortName);
            if (regionMatch) {
                setCities(regionMatch.cities.map(c => ({ name: c.name, lat: c.latitude, lng: c.longitude })));
            }
        } finally {
            setLoadingCities(false);
        }
    }, [provinces]);

    const handleProvinceSelect = useCallback((name: string) => {
        setSelectedProvince(prev => prev === name ? null : name);
    }, []);

    const handleNextFromProvince = useCallback(() => {
        if (!selectedProvince) return;
        loadCities(selectedProvince);
        setStep('city');
    }, [selectedProvince, loadCities]);

    const handleCitySelect = useCallback((name: string) => {
        setSelectedCity(prev => prev === name ? null : name);
    }, []);

    const handleNextFromCity = useCallback(() => {
        if (!selectedProvince || !selectedCity) return;
        const cityData = cities.find(c => c.name === selectedCity);
        if (cityData) {
            setSelectedCityCoords({ lat: cityData.lat, lng: cityData.lng });
            setSelectedCondition(null);
            setIndustrialList([]);
            setSelectedIndustrial(null);
            setStep('condition');
        }
    }, [selectedProvince, selectedCity, cities]);

    const fetchIndustrialComplexes = useCallback(async (cityName: string) => {
        setLoadingIndustrial(true);
        setIndustrialList([]);
        setSelectedIndustrial(null);
        try {
            const seen = new Set<string>();
            const results: IndustrialItem[] = [];
            for (const q of ['산업단지', '공업단지', '산단']) {
                const url = `https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=10&page=1&query=${encodeURIComponent(cityName + ' ' + q)}&type=place&format=json&key=${VWORLD_API_KEY}`;
                const res = await fetch(url);
                const json = await res.json();
                if (json.response?.status === 'OK') {
                    for (const item of (json.response?.result?.items || [])) {
                        if (!seen.has(item.id)) {
                            seen.add(item.id);
                            results.push({
                                id: item.id,
                                name: item.title,
                                lat: parseFloat(item.point.y),
                                lng: parseFloat(item.point.x),
                                address: item.address?.road || item.address?.parcel || '',
                            });
                        }
                    }
                }
            }
            setIndustrialList(results);
        } catch {}
        setLoadingIndustrial(false);
    }, []);

    const handleConditionSelect = useCallback((condition: ConditionType) => {
        setSelectedCondition(prev => prev === condition ? null : condition);
        setSelectedIndustrial(null);
        if (condition !== selectedCondition && condition === 'industrial' && selectedCity) {
            fetchIndustrialComplexes(selectedCity);
        }
    }, [selectedCondition, selectedCity, fetchIndustrialComplexes]);

    const handleComplete = useCallback(() => {
        if (!selectedCityCoords || !selectedCondition) return;
        if (selectedCondition === 'urban') {
            onComplete(selectedProvince!, selectedCity!, selectedCityCoords.lat, selectedCityCoords.lng, 0.05);
        } else if (selectedIndustrial) {
            onComplete(selectedProvince!, selectedCity!, selectedIndustrial.lat, selectedIndustrial.lng, 0.02);
        }
    }, [selectedCityCoords, selectedCondition, selectedIndustrial, selectedProvince, selectedCity, onComplete]);

    const handleBack = useCallback(() => {
        if (step === 'condition') {
            setStep('city');
            setSelectedCondition(null);
            setIndustrialList([]);
            setSelectedIndustrial(null);
        } else if (step === 'city') {
            setStep('province');
            setSelectedCity(null);
            setCities([]);
        } else {
            onBack();
        }
    }, [step, onBack]);

    // 페이징 계산
    const totalPages = Math.ceil(cities.length / CITIES_PER_PAGE);
    const pagedCities = cities.slice(cityPage * CITIES_PER_PAGE, (cityPage + 1) * CITIES_PER_PAGE);

    const selectedProvinceShort = provinces.find(p => p.name === selectedProvince)?.short || '';

    return (
        <View style={{ flex: 1, backgroundColor: COLORS.surface }}>
            {/* 헤더 */}
            <View style={{
                flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                paddingHorizontal: SPACING.xl3, paddingTop: SPACING.lg, paddingBottom: SPACING.base,
                backgroundColor: COLORS.white, borderBottomWidth: 1, borderBottomColor: COLORS.lineSoft,
            }}>
                <TouchableOpacity onPress={handleBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityLabel="뒤로 가기" accessibilityRole="button">
                    <Text style={{ fontSize: fs.lg, color: COLORS.primary, fontWeight: '700' }}>{'< 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={{ fontSize: fs.lg, fontWeight: '700', color: COLORS.ink }}>지역으로 찾기</Text>
                <View style={{ width: 50 }} />
            </View>

            {/* 스텝 브레드크럼 */}
            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', paddingHorizontal: SPACING.xl3, paddingTop: SPACING.lg, paddingBottom: SPACING.base, gap: SPACING.xs }}>
                {step !== 'province' && (
                    <>
                        <View style={{ paddingHorizontal: SPACING.base, paddingVertical: SPACING.xs, borderRadius: RADIUS.pill, backgroundColor: COLORS.ink }}>
                            <Text style={{ fontSize: fs.sm, fontWeight: '700', color: COLORS.white }}>{selectedProvinceShort}</Text>
                        </View>
                        <Text style={{ fontSize: 16, color: COLORS.chevron }}>{'›'}</Text>
                    </>
                )}
                {step === 'condition' && (
                    <>
                        <View style={{ paddingHorizontal: SPACING.base, paddingVertical: SPACING.xs, borderRadius: RADIUS.pill, backgroundColor: COLORS.ink }}>
                            <Text style={{ fontSize: fs.sm, fontWeight: '700', color: COLORS.white }}>{selectedCity}</Text>
                        </View>
                        <Text style={{ fontSize: 16, color: COLORS.chevron }}>{'›'}</Text>
                    </>
                )}
                <View style={{ paddingHorizontal: SPACING.base, paddingVertical: SPACING.xs, borderRadius: RADIUS.pill, backgroundColor: COLORS.surface }}>
                    <Text style={{ fontSize: fs.sm, fontWeight: '500', color: COLORS.textMuted }}>
                        {step === 'province' ? '도/광역시' : step === 'city' ? '시·군·구' : '유형'}
                    </Text>
                </View>
            </View>

            {/* 메인 콘텐츠 */}
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: SPACING.xl3, paddingBottom: 120 }}>
                {step === 'province' ? (
                    <>
                        {/* Step 1: 지역 선택 */}
                        <Text style={{ fontSize: fs.xl + 10, fontWeight: '700', color: COLORS.ink, lineHeight: 38, letterSpacing: -0.7, marginBottom: SPACING.xs }}>
                            {'어느 지역인가요?'}
                        </Text>
                        <Text style={{ fontSize: fs.base, color: COLORS.textMuted, marginBottom: SPACING.xl5 }}>
                            조회하려는 도 또는 광역시를 선택하세요
                        </Text>

                        {loadingProvinces ? (
                            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                                <ActivityIndicator size="large" color={COLORS.primary} />
                                <Text style={{ marginTop: SPACING.base, color: COLORS.textMuted, fontSize: fs.base }}>지역 정보 로딩 중...</Text>
                            </View>
                        ) : (
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm }}>
                                {provinces.map(p => {
                                    const isSelected = selectedProvince === p.name;
                                    return (
                                        <TouchableOpacity
                                            key={p.name}
                                            onPress={() => handleProvinceSelect(p.name)}
                                            style={{
                                                paddingHorizontal: SPACING.xl2,
                                                paddingVertical: SPACING.base + 2,
                                                borderRadius: RADIUS.pill,
                                                borderWidth: 1.5,
                                                borderColor: isSelected ? COLORS.ink : COLORS.line,
                                                backgroundColor: isSelected ? COLORS.ink : COLORS.white,
                                            }}
                                            accessibilityRole="radio"
                                            accessibilityState={{ checked: isSelected }}
                                            accessibilityLabel={p.name}
                                        >
                                            <Text style={{
                                                fontSize: fs.lg, fontWeight: isSelected ? '700' : '500',
                                                color: isSelected ? COLORS.white : COLORS.inkSub,
                                            }}>
                                                {p.short}
                                            </Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        )}

                        {selectedProvince && (
                            <View style={{
                                marginTop: SPACING.xl5, backgroundColor: COLORS.primaryTint, borderRadius: RADIUS.input, padding: SPACING.lg,
                                flexDirection: 'row', alignItems: 'center',
                            }}>
                                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.primary, marginRight: SPACING.base }} />
                                <Text style={{ fontSize: fs.base, color: COLORS.primary, fontWeight: '700' }}>
                                    선택: {selectedProvince}
                                </Text>
                            </View>
                        )}
                    </>
                ) : step === 'city' ? (
                    <>
                        {/* Step 2: 상세 지역 선택 */}
                        <Text style={{ fontSize: fs.xl + 10, fontWeight: '700', color: COLORS.ink, lineHeight: 38, letterSpacing: -0.7, marginBottom: SPACING.xs }}>
                            {'어느 시·군인가요?'}
                        </Text>
                        <Text style={{ fontSize: fs.base, color: COLORS.textMuted, marginBottom: SPACING.xl3 }}>
                            {selectedProvinceShort} 내 시·군·구를 선택하세요
                        </Text>

                        {loadingCities ? (
                            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                                <ActivityIndicator size="large" color={COLORS.primary} />
                                <Text style={{ marginTop: SPACING.base, color: COLORS.textMuted, fontSize: fs.base }}>시·군·구 로딩 중...</Text>
                            </View>
                        ) : cities.length === 0 ? (
                            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                                <Text style={{ color: COLORS.textMuted, fontSize: fs.base }}>등록된 시·군·구가 없습니다</Text>
                            </View>
                        ) : (
                            <>
                                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm }}>
                                    {pagedCities.map(c => {
                                        const isSelected = selectedCity === c.name;
                                        return (
                                            <TouchableOpacity
                                                key={c.name}
                                                onPress={() => handleCitySelect(c.name)}
                                                style={{
                                                    paddingHorizontal: SPACING.xl,
                                                    paddingVertical: SPACING.base,
                                                    borderRadius: RADIUS.button,
                                                    borderWidth: 1.5,
                                                    borderColor: isSelected ? COLORS.ink : COLORS.line,
                                                    backgroundColor: isSelected ? COLORS.ink : COLORS.white,
                                                    minWidth: 80,
                                                    alignItems: 'center',
                                                }}
                                                accessibilityRole="radio"
                                                accessibilityState={{ checked: isSelected }}
                                                accessibilityLabel={c.name}
                                            >
                                                <Text style={{
                                                    fontSize: fs.lg, fontWeight: isSelected ? '700' : '500',
                                                    color: isSelected ? COLORS.white : COLORS.inkSub,
                                                }}>
                                                    {c.name}
                                                </Text>
                                            </TouchableOpacity>
                                        );
                                    })}
                                </View>

                                {/* 페이징 */}
                                {totalPages > 1 && (
                                    <View style={{
                                        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                                        marginTop: SPACING.xl5, gap: SPACING.xl2,
                                    }}>
                                        <TouchableOpacity
                                            onPress={() => setCityPage(prev => Math.max(0, prev - 1))}
                                            disabled={cityPage === 0}
                                            style={{
                                                paddingHorizontal: SPACING.xl, paddingVertical: SPACING.sm, borderRadius: RADIUS.input,
                                                backgroundColor: cityPage === 0 ? COLORS.surface : COLORS.ink,
                                            }}
                                        >
                                            <Text style={{ color: cityPage === 0 ? COLORS.textMuted : COLORS.white, fontSize: fs.sm, fontWeight: '600' }}>이전</Text>
                                        </TouchableOpacity>
                                        <Text style={{ fontSize: fs.sm, color: COLORS.textMuted, fontWeight: '600' }}>
                                            {cityPage + 1} / {totalPages}
                                        </Text>
                                        <TouchableOpacity
                                            onPress={() => setCityPage(prev => Math.min(totalPages - 1, prev + 1))}
                                            disabled={cityPage >= totalPages - 1}
                                            style={{
                                                paddingHorizontal: SPACING.xl, paddingVertical: SPACING.sm, borderRadius: RADIUS.input,
                                                backgroundColor: cityPage >= totalPages - 1 ? COLORS.surface : COLORS.ink,
                                            }}
                                        >
                                            <Text style={{ color: cityPage >= totalPages - 1 ? COLORS.textMuted : COLORS.white, fontSize: fs.sm, fontWeight: '600' }}>다음</Text>
                                        </TouchableOpacity>
                                    </View>
                                )}
                            </>
                        )}

                        {selectedCity && (
                            <View style={{
                                marginTop: SPACING.xl3, backgroundColor: COLORS.primaryTint, borderRadius: RADIUS.input, padding: SPACING.lg,
                                flexDirection: 'row', alignItems: 'center',
                            }}>
                                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.primary, marginRight: SPACING.base }} />
                                <Text style={{ fontSize: fs.base, color: COLORS.primary, fontWeight: '700' }}>
                                    선택: {selectedProvinceShort} {'>'} {selectedCity}
                                </Text>
                            </View>
                        )}
                    </>
                ) : (
                    <>
                        {/* Step 3: 영업 유형 선택 */}
                        <Text style={{ fontSize: fs.xl + 10, fontWeight: '700', color: COLORS.ink, lineHeight: 38, letterSpacing: -0.7, marginBottom: SPACING.xs }}>
                            {'어떤 유형으로 찾을까요?'}
                        </Text>
                        <Text style={{ fontSize: fs.base, color: COLORS.textMuted, marginBottom: SPACING.xl3 }}>
                            {selectedProvinceShort} {selectedCity}의 탐색 유형을 선택하세요
                        </Text>

                        {/* 도심 / 산업단지 */}
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, marginBottom: SPACING.xl6 }}>
                            {([
                                { key: 'urban' as ConditionType, label: '도심' },
                                { key: 'industrial' as ConditionType, label: '산업단지' },
                            ]).map(({ key, label }) => {
                                const isSel = selectedCondition === key;
                                return (
                                    <TouchableOpacity
                                        key={key}
                                        onPress={() => handleConditionSelect(key)}
                                        style={{
                                            paddingHorizontal: SPACING.xl4, paddingVertical: SPACING.base + 1,
                                            borderRadius: RADIUS.pill, borderWidth: 1.5,
                                            borderColor: isSel ? COLORS.ink : COLORS.line,
                                            backgroundColor: isSel ? COLORS.ink : COLORS.white,
                                        }}
                                        accessibilityRole="radio"
                                        accessibilityState={{ checked: isSel }}
                                    >
                                        <Text style={{ fontSize: fs.lg, fontWeight: isSel ? '700' : '500', color: isSel ? COLORS.white : COLORS.inkSub }}>
                                            {label}
                                        </Text>
                                    </TouchableOpacity>
                                );
                            })}
                        </View>

                        {/* 산업단지 목록 */}
                        {selectedCondition === 'industrial' && (
                            <>
                                <Text style={{ fontSize: fs.base, fontWeight: '700', color: COLORS.ink, marginBottom: SPACING.base }}>
                                    {selectedCity} 산업단지 목록
                                </Text>
                                {loadingIndustrial ? (
                                    <View style={{ alignItems: 'center', paddingVertical: 28 }}>
                                        <ActivityIndicator size="small" color={COLORS.primary} />
                                        <Text style={{ marginTop: SPACING.sm, color: COLORS.textMuted, fontSize: fs.base }}>산업단지 조회 중...</Text>
                                    </View>
                                ) : industrialList.length === 0 ? (
                                    <View style={{ alignItems: 'center', paddingVertical: SPACING.xl3, backgroundColor: COLORS.surface, borderRadius: RADIUS.input }}>
                                        <Text style={{ color: COLORS.textMuted, fontSize: fs.base, textAlign: 'center' }}>
                                            {'산업단지를 찾을 수 없습니다\n도심 탐색을 이용해주세요'}
                                        </Text>
                                    </View>
                                ) : (
                                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm }}>
                                        {industrialList.map(item => {
                                            const isSel = selectedIndustrial?.id === item.id;
                                            return (
                                                <TouchableOpacity
                                                    key={item.id}
                                                    onPress={() => setSelectedIndustrial(prev => prev?.id === item.id ? null : item)}
                                                    style={{
                                                        paddingHorizontal: SPACING.xl, paddingVertical: SPACING.base,
                                                        borderRadius: RADIUS.button, borderWidth: 1.5,
                                                        borderColor: isSel ? COLORS.ink : COLORS.line,
                                                        backgroundColor: isSel ? COLORS.ink : COLORS.white,
                                                    }}
                                                    accessibilityRole="radio"
                                                    accessibilityState={{ checked: isSel }}
                                                >
                                                    <Text style={{ fontSize: fs.base, fontWeight: isSel ? '700' : '500', color: isSel ? COLORS.white : COLORS.inkSub }}>
                                                        {item.name}
                                                    </Text>
                                                </TouchableOpacity>
                                            );
                                        })}
                                    </View>
                                )}
                            </>
                        )}
                    </>
                )}
            </ScrollView>

            {/* 하단 다음/완료 버튼 */}
            <View style={{
                position: 'absolute', bottom: 0, left: 0, right: 0,
                paddingHorizontal: SPACING.xl3, paddingVertical: SPACING.lg, paddingBottom: SPACING.xl6,
                backgroundColor: COLORS.surface,
                borderTopWidth: 1, borderTopColor: COLORS.lineSoft,
            }}>
                {(() => {
                    const isCondStep = step === 'condition';
                    const canProceed = step === 'province' ? !!selectedProvince
                        : step === 'city' ? !!selectedCity
                        : selectedCondition === 'urban' || (selectedCondition === 'industrial' && !!selectedIndustrial);
                    const onPress = step === 'province' ? handleNextFromProvince
                        : step === 'city' ? handleNextFromCity
                        : handleComplete;
                    const label = isCondStep ? '지도 보기' : '다음';
                    return (
                        <TouchableOpacity
                            onPress={onPress}
                            disabled={!canProceed}
                            style={{
                                height: 64,
                                backgroundColor: canProceed ? COLORS.primary : COLORS.surface,
                                borderRadius: RADIUS.button, alignItems: 'center', justifyContent: 'center',
                                ...(canProceed ? ELEVATION.primaryBtn : null),
                            }}
                            accessibilityRole="button"
                        >
                            <Text style={{ fontSize: fs.xl + 3, fontWeight: '700', color: canProceed ? COLORS.white : COLORS.textMuted }}>
                                {label}
                            </Text>
                        </TouchableOpacity>
                    );
                })()}
            </View>
        </View>
    );
});

// ===== PlaceDetailScreen =====

const PlaceDetailScreen = ({ place, onBack, onMoveToMap }: {
    place: PlaceRecord;
    onBack: () => void;
    onMoveToMap: (lat: number, lng: number, address: string) => void;
}) => {
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;

    const infoRows: { label: string; value: string | null }[] = [
        { label: '도로명주소', value: place.road_address },
        { label: '지번주소', value: place.jibun_address },
        { label: '위도', value: String(place.lat) },
        { label: '경도', value: String(place.lng) },
        { label: '상태일자', value: place.status_date },
        { label: '메모', value: place.memo },
        { label: '등록일', value: place.created_at ? new Date(place.created_at).toLocaleString('ko-KR') : null },
        { label: '수정일', value: place.updated_at ? new Date(place.updated_at).toLocaleString('ko-KR') : null },
    ];

    const displayAddress = place.road_address || place.jibun_address || `${place.lat.toFixed(6)}, ${place.lng.toFixed(6)}`;

    return (
        <View style={styles.subScreenContainer}>
            <View style={styles.subScreenHeader}>
                <TouchableOpacity onPress={onBack} style={styles.backButton}>
                    <Text style={[styles.backButtonText, { fontSize: fs.lg }]}>{'< 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={[styles.subScreenTitle, { fontSize: fs['2xl'] }]}>장소 상세</Text>
                <TouchableOpacity
                    onPress={() => onMoveToMap(place.lat, place.lng, displayAddress)}
                    style={{ paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#18181B', borderRadius: 6, marginRight: 4 }}
                >
                    <Text style={{ color: '#FAFAFA', fontSize: fs.xs, fontWeight: '600' }}>지도보기</Text>
                </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ padding: 16 }}>
                {/* 상태 배지 */}
                <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 8, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#E4E4E7' }}>
                    <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: PLACE_STATUS_COLORS[place.status], marginRight: 10 }} />
                    <Text style={{ fontSize: fs.lg, fontWeight: '700', color: PLACE_STATUS_COLORS[place.status] }}>{place.status}</Text>
                    {place.status_date && (
                        <Text style={{ fontSize: fs.sm, color: '#71717A', marginLeft: 12 }}>{place.status_date}</Text>
                    )}
                </View>

                {/* 상세 정보 행 */}
                {infoRows.map(({ label, value }) => value ? (
                    <View key={label} style={{ backgroundColor: '#fff', borderRadius: 8, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#E4E4E7' }}>
                        <Text style={{ fontSize: fs.xs, color: '#71717A', marginBottom: 4 }}>{label}</Text>
                        <Text style={{ fontSize: fs.base, color: '#18181B', fontWeight: '500' }}>{value}</Text>
                    </View>
                ) : null)}
            </ScrollView>
        </View>
    );
};

// ===== PlaceManagementListScreen =====

const PLACE_LIST_PAGE_SIZE = 20;

// 화면 05 정렬 우선순위: 행동이 필요한 상태부터
const PLACE_STATUS_PRIORITY: PlaceStatus[] = ['미팅예정', '접촉', '미접촉', '성사', '거절'];
const PLACE_GROUP_FETCH_CAP = 500;

const PlaceManagementListScreen = ({ onBack, onMoveToMap }: {
    onBack: () => void;
    onMoveToMap: (lat: number, lng: number, address: string) => void;
}) => {
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const [places, setPlaces] = useState<PlaceRecord[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [pageIndex, setPageIndex] = useState(0);
    const [searchText, setSearchText] = useState('');
    const [searchInput, setSearchInput] = useState('');
    const [selectedStatus, setSelectedStatus] = useState<PlaceStatus | null>(null);
    const [selectedPlace, setSelectedPlace] = useState<PlaceRecord | null>(null);
    const [statusCounts, setStatusCounts] = useState<Record<PlaceStatus, number>>({
        '미접촉': 0, '접촉': 0, '미팅예정': 0, '성사': 0, '거절': 0,
    });

    // 필터 칩 건수 (검색/필터와 무관하게 전체 기준)
    useEffect(() => {
        supabase.from('places').select('status').then(({ data }) => {
            const counts: Record<PlaceStatus, number> = { '미접촉': 0, '접촉': 0, '미팅예정': 0, '성사': 0, '거절': 0 };
            (data || []).forEach((row: { status: string }) => {
                const s = row.status as PlaceStatus;
                if (s in counts) counts[s]++;
            });
            setStatusCounts(counts);
        });
    }, []);
    const totalCount = Object.values(statusCounts).reduce((a, b) => a + b, 0);

    const isGrouped = selectedStatus === null && !searchText.trim();

    const loadPlaces = async (reset: boolean, currentSearch: string, currentStatus: PlaceStatus | null, currentPage: number) => {
        if (isLoading) return;
        setIsLoading(true);
        try {
            if (currentStatus === null && !currentSearch.trim()) {
                // 전체 + 검색어 없음: 상태별 그룹핑을 위해 한 번에 불러와 클라이언트에서 정렬
                const { data, error } = await supabase
                    .from('places')
                    .select('*')
                    .order('created_at', { ascending: false })
                    .limit(PLACE_GROUP_FETCH_CAP);
                if (!error && data) {
                    setPlaces(data as PlaceRecord[]);
                    setHasMore(false);
                }
            } else {
                let query = supabase
                    .from('places')
                    .select('*')
                    .order('created_at', { ascending: false })
                    .range(currentPage * PLACE_LIST_PAGE_SIZE, (currentPage + 1) * PLACE_LIST_PAGE_SIZE - 1);
                if (currentStatus) query = query.eq('status', currentStatus);
                if (currentSearch.trim()) {
                    query = query.or(
                        `road_address.ilike.%${currentSearch.trim()}%,jibun_address.ilike.%${currentSearch.trim()}%,memo.ilike.%${currentSearch.trim()}%`
                    );
                }
                const { data, error } = await query;
                if (!error && data) {
                    const newItems = data as PlaceRecord[];
                    setPlaces(prev => (reset ? newItems : [...prev, ...newItems]));
                    setPageIndex(currentPage + 1);
                    setHasMore(newItems.length === PLACE_LIST_PAGE_SIZE);
                }
            }
        } catch (_) {}
        setIsLoading(false);
    };

    useEffect(() => {
        loadPlaces(true, searchText, selectedStatus, 0);
    }, [searchText, selectedStatus]);

    const handleSearchSubmit = () => {
        setSearchText(searchInput);
    };

    const handleLoadMore = () => {
        if (!isLoading && hasMore) {
            loadPlaces(false, searchText, selectedStatus, pageIndex);
        }
    };

    // 상태별 섹션 그룹핑 (전체 필터 + 검색 없음일 때만)
    const sections = useMemo(() => {
        if (!isGrouped) return null;
        return PLACE_STATUS_PRIORITY
            .map(status => ({ status, items: places.filter(p => p.status === status) }))
            .filter(section => section.items.length > 0);
    }, [isGrouped, places]);

    if (selectedPlace) {
        return (
            <PlaceDetailScreen
                place={selectedPlace}
                onBack={() => setSelectedPlace(null)}
                onMoveToMap={onMoveToMap}
            />
        );
    }

    const renderPlaceCard = (item: PlaceRecord) => (
        <TouchableOpacity
            key={item.id}
            style={{ backgroundColor: COLORS.white, marginHorizontal: SPACING.xl3, marginBottom: SPACING.base, borderRadius: RADIUS.card, padding: SPACING.xl2 }}
            onPress={() => setSelectedPlace(item)}
            accessibilityRole="button"
        >
            <Text style={{ fontSize: fs.lg, fontWeight: '700', color: COLORS.ink, marginBottom: 4 }} numberOfLines={1}>
                {item.road_address || item.jibun_address || `${item.lat.toFixed(6)}, ${item.lng.toFixed(6)}`}
            </Text>
            {item.memo ? (
                <Text style={{ fontSize: fs.base, color: COLORS.textMuted, lineHeight: 24 }} numberOfLines={2}>{item.memo}</Text>
            ) : null}
            {item.status_date && (
                <View style={{ alignSelf: 'flex-start', backgroundColor: COLORS.warnTint2, borderRadius: RADIUS.chip, paddingHorizontal: SPACING.base, paddingVertical: 4, marginTop: SPACING.sm }}>
                    <Text style={{ fontSize: fs.sm, fontWeight: '700', color: COLORS.warn }}>{item.status_date}</Text>
                </View>
            )}
        </TouchableOpacity>
    );

    return (
        <View style={styles.subScreenContainer}>
            <View style={styles.subScreenHeader}>
                <TouchableOpacity onPress={onBack} style={styles.backButton} accessibilityLabel="뒤로 가기" accessibilityRole="button">
                    <Text style={[styles.backButtonText, { fontSize: fs.lg }]}>{'< 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={[styles.subScreenTitle, { fontSize: fs['2xl'], fontWeight: '700' }]}>내 장소</Text>
                <View style={{ width: 50 }} />
            </View>

            {/* 검색 */}
            <View style={styles.searchContainer}>
                <TextInput
                    style={[styles.searchInput, { fontSize: fs.base }]}
                    placeholder="주소 또는 메모 검색..."
                    value={searchInput}
                    onChangeText={setSearchInput}
                    onSubmitEditing={handleSearchSubmit}
                    returnKeyType="search"
                />
                {searchInput.length > 0 && (
                    <TouchableOpacity onPress={() => { setSearchInput(''); setSearchText(''); }} style={styles.clearButton}>
                        <Text style={styles.clearButtonText}>X</Text>
                    </TouchableOpacity>
                )}
            </View>

            {/* 필터 칩 (건수 포함) */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: SPACING.xl3, marginBottom: SPACING.base, gap: SPACING.sm }}>
                <TouchableOpacity
                    onPress={() => setSelectedStatus(null)}
                    style={{ paddingHorizontal: SPACING.base, paddingVertical: SPACING.xs, borderRadius: RADIUS.chip, backgroundColor: selectedStatus === null ? COLORS.ink : COLORS.surface }}
                >
                    <Text style={{ fontSize: fs.sm, color: selectedStatus === null ? COLORS.white : COLORS.inkSub, fontWeight: '600' }}>전체 {totalCount}</Text>
                </TouchableOpacity>
                {PLACE_STATUSES.map(s => (
                    <TouchableOpacity
                        key={s}
                        onPress={() => setSelectedStatus(selectedStatus === s ? null : s)}
                        style={{ paddingHorizontal: SPACING.base, paddingVertical: SPACING.xs, borderRadius: RADIUS.chip, backgroundColor: selectedStatus === s ? COLORS.ink : COLORS.surface }}
                    >
                        <Text style={{ fontSize: fs.sm, color: selectedStatus === s ? COLORS.white : COLORS.inkSub, fontWeight: '600' }}>{s} {statusCounts[s]}</Text>
                    </TouchableOpacity>
                ))}
            </View>

            {/* 목록 */}
            {isGrouped ? (
                <FlatList
                    data={sections || []}
                    keyExtractor={section => section.status}
                    contentContainerStyle={{ paddingBottom: 24 }}
                    renderItem={({ item: section }) => (
                        <View style={{ marginBottom: SPACING.base }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.xl3, marginBottom: SPACING.sm }}>
                                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: PLACE_STATUS_COLORS[section.status], marginRight: SPACING.sm }} />
                                <Text style={{ fontSize: fs.xl, fontWeight: '700', color: COLORS.inkSub }}>{section.status} {section.items.length}곳</Text>
                            </View>
                            {section.items.map(renderPlaceCard)}
                        </View>
                    )}
                    ListEmptyComponent={!isLoading ? (
                        <EmptyState title={'관리 중인 장소가\n아직 없어요'} description={'지도에서 장소를 저장하면\n여기에서 모아볼 수 있어요.'} />
                    ) : null}
                />
            ) : (
                <FlatList
                    data={places}
                    keyExtractor={(item) => item.id}
                    removeClippedSubviews={true}
                    maxToRenderPerBatch={10}
                    windowSize={5}
                    renderItem={({ item }) => renderPlaceCard(item)}
                    onEndReached={handleLoadMore}
                    onEndReachedThreshold={0.3}
                    ListFooterComponent={isLoading ? <ActivityIndicator style={{ margin: 16 }} /> : null}
                    ListEmptyComponent={!isLoading ? (
                        <EmptyState title={'검색 결과가\n없어요'} description={'다른 검색어나 상태 필터로\n다시 찾아보세요.'} />
                    ) : null}
                />
            )}
        </View>
    );
};

// ===== 화면 16: 알림 · 공지 (통합) =====

type NotifTab = 'todo' | 'news';

const NotificationsScreen = ({ onBack, onOpenProperty, initialTab = 'todo' }: {
    onBack: () => void;
    onOpenProperty?: (propertyId: string) => void;
    initialTab?: NotifTab;
}) => {
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const [tab, setTab] = useState<NotifTab>(initialTab);
    const [todoItems, setTodoItems] = useState<Array<{ property_id: string; building_name: string | null; road_address: string | null; sales_status: SalesStatus; next_contact_date: string }>>([]);
    const [newsItems, setNewsItems] = useState<AppNotification[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const [propsRes, json] = await Promise.all([
                    supabase.from('properties')
                        .select('property_id, building_name, road_address, sales_status, next_contact_date')
                        .in('sales_status', ['보류', '대기중'])
                        .not('next_contact_date', 'is', null)
                        .order('next_contact_date', { ascending: true }),
                    AsyncStorage.getItem(NOTIFICATIONS_KEY),
                ]);
                setTodoItems((propsRes.data || []) as typeof todoItems);
                setNewsItems(json ? JSON.parse(json) : []);
                await markAllNotificationsRead();
            } catch (_) {}
            setIsLoading(false);
        })();
    }, []);

    const now = new Date();

    return (
        <View style={[styles.subScreenContainer, { backgroundColor: COLORS.surface }]}>
            <View style={[styles.subScreenHeader, { backgroundColor: COLORS.white, borderBottomColor: COLORS.lineSoft }]}>
                <TouchableOpacity onPress={onBack} style={styles.backButton} accessibilityLabel="뒤로 가기" accessibilityRole="button">
                    <Text style={[styles.backButtonText, { fontSize: fs.lg, color: COLORS.primary }]}>{'< 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={[styles.subScreenTitle, { fontSize: fs['2xl'], color: COLORS.ink }]}>알림</Text>
                <TouchableOpacity onPress={markAllNotificationsRead} accessibilityLabel="모두 읽음" accessibilityRole="button">
                    <Text style={{ color: COLORS.textMuted, fontSize: fs.sm, fontWeight: '600' }}>모두 읽음</Text>
                </TouchableOpacity>
            </View>

            {/* 탭 */}
            <View style={{ flexDirection: 'row', backgroundColor: COLORS.white, borderBottomWidth: 1, borderBottomColor: COLORS.lineSoft }}>
                {([
                    { key: 'todo' as NotifTab, label: `할 일 ${todoItems.length}` },
                    { key: 'news' as NotifTab, label: `새 소식 ${newsItems.length}` },
                ]).map(t => {
                    const active = tab === t.key;
                    return (
                        <TouchableOpacity
                            key={t.key}
                            onPress={() => setTab(t.key)}
                            style={{ flex: 1, alignItems: 'center', paddingVertical: SPACING.base, borderBottomWidth: active ? 3 : 0, borderBottomColor: COLORS.ink }}
                        >
                            <Text style={{ fontSize: fs.lg, fontWeight: active ? '700' : '500', color: active ? COLORS.ink : COLORS.textMuted }}>{t.label}</Text>
                        </TouchableOpacity>
                    );
                })}
            </View>

            {isLoading ? (
                <View style={styles.loadingContainer}><ActivityIndicator color={COLORS.primary} /></View>
            ) : tab === 'todo' ? (
                <FlatList
                    data={todoItems}
                    keyExtractor={(item) => item.property_id}
                    contentContainerStyle={{ padding: SPACING.xl3, paddingBottom: 100 }}
                    renderItem={({ item }) => {
                        const contactDate = new Date(item.next_contact_date);
                        const isOverdue = contactDate < now;
                        const isToday = !isOverdue && contactDate.toDateString() === now.toDateString();
                        const barColor = isOverdue ? COLORS.dangerStrong : isToday ? COLORS.warnAccent : null;
                        const labelColor = isOverdue ? COLORS.danger : isToday ? COLORS.warn : COLORS.primary;
                        const label = item.sales_status === '보류' ? '재방문' : '연락';
                        const name = item.building_name || item.road_address || item.property_id;
                        return (
                            <TouchableOpacity
                                onPress={() => onOpenProperty && onOpenProperty(item.property_id)}
                                style={{ flexDirection: 'row', backgroundColor: COLORS.white, borderRadius: RADIUS.card, marginBottom: SPACING.base, overflow: 'hidden' }}
                                accessibilityLabel={`${name} 상세 보기`}
                                accessibilityRole="button"
                            >
                                {barColor && <View style={{ width: 6, backgroundColor: barColor }} />}
                                <View style={{ flex: 1, padding: SPACING.xl2 }}>
                                    <Text style={{ fontSize: fs.sm, fontWeight: '700', color: labelColor, marginBottom: 4 }}>
                                        {isOverdue ? '기한 초과' : isToday ? '오늘' : `${label} 예정`}
                                    </Text>
                                    <Text style={{ fontSize: fs.xl, fontWeight: '700', color: COLORS.ink }} numberOfLines={1}>{name}</Text>
                                    <Text style={{ fontSize: fs.base, color: COLORS.textMuted, marginTop: 4 }}>
                                        {label} 예정일 {contactDate.toLocaleDateString('ko-KR')}
                                    </Text>
                                </View>
                            </TouchableOpacity>
                        );
                    }}
                    ListEmptyComponent={
                        <EmptyState title={'오늘 할 일이\n없어요'} description={'재방문·연락 예정이 등록되면\n여기에 표시돼요.'} />
                    }
                />
            ) : (
                <FlatList
                    data={newsItems}
                    keyExtractor={(item) => item.id}
                    contentContainerStyle={{ padding: SPACING.xl3, paddingBottom: 100 }}
                    renderItem={({ item }) => (
                        <View style={{ backgroundColor: COLORS.white, borderRadius: RADIUS.card, padding: SPACING.xl2, marginBottom: SPACING.base }}>
                            <Text style={{ fontSize: fs.sm, color: COLORS.textMuted, marginBottom: 4 }}>
                                {new Date(item.timestamp).toLocaleDateString('ko-KR')} {new Date(item.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                            </Text>
                            <Text style={{ fontSize: fs.lg, fontWeight: '700', color: COLORS.ink }}>{item.message}</Text>
                        </View>
                    )}
                    ListEmptyComponent={
                        <EmptyState title={'새 소식이\n없어요'} description={'즐겨찾기, 등기 열람, 공지 등\n새 소식이 오면 여기에 표시돼요.'} />
                    }
                />
            )}
        </View>
    );
};

// ===== ImprovementsScreen =====

interface ImprovementRecord {
    id: string;
    title: string;
    content: string;
    category: string;
    version: string | null;
    created_at: string;
}

const IMPROVEMENT_CATEGORY_COLORS: Record<string, string> = {
    '버그수정': '#E53935',
    '기능개선': '#1976D2',
    '신규기능': '#2E7D32',
    '공지':     '#F57C00',
};

const ImprovementsScreen = ({ onBack }: { onBack: () => void }) => {
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const [items, setItems] = useState<ImprovementRecord[]>([]);
    const [page, setPage] = useState(0);
    const [hasMore, setHasMore] = useState(true);
    const [isLoading, setIsLoading] = useState(false);
    const [selectedItem, setSelectedItem] = useState<ImprovementRecord | null>(null);

    const loadPage = async (p: number) => {
        if (isLoading) return;
        setIsLoading(true);
        try {
            const { data } = await supabase
                .from('improvements')
                .select('*')
                .order('created_at', { ascending: false })
                .range(p * 5, p * 5 + 4);
            const rows = (data || []) as ImprovementRecord[];
            setItems(prev => p === 0 ? rows : [...prev, ...rows]);
            setHasMore(rows.length === 5);
        } catch (_) {}
        setIsLoading(false);
    };

    useEffect(() => { loadPage(0); }, []);

    const loadMore = () => {
        if (!hasMore || isLoading) return;
        const next = page + 1;
        setPage(next);
        loadPage(next);
    };

    if (selectedItem) {
        return (
            <View style={{ flex: 1, backgroundColor: '#FAFAFA' }}>
                <View style={[styles.header, { backgroundColor: '#09090B' }]}>
                    <TouchableOpacity style={styles.headerIconWrap} onPress={() => setSelectedItem(null)}>
                        <Text style={{ color: '#FAFAFA', fontSize: 16 }}>←</Text>
                    </TouchableOpacity>
                    <Text style={[styles.title, { fontSize: fs.lg }]} numberOfLines={1}>{selectedItem.title}</Text>
                </View>
                <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
                        <View style={{ backgroundColor: IMPROVEMENT_CATEGORY_COLORS[selectedItem.category] || '#777', borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3, marginRight: 8 }}>
                            <Text style={{ color: '#fff', fontSize: fs.xs, fontWeight: '700' }}>{selectedItem.category}</Text>
                        </View>
                        {selectedItem.version && (
                            <Text style={{ fontSize: fs.xs, color: '#888', marginRight: 8 }}>v{selectedItem.version}</Text>
                        )}
                        <Text style={{ fontSize: fs.xs, color: '#999' }}>
                            {new Date(selectedItem.created_at).toLocaleDateString('ko-KR')}
                        </Text>
                    </View>
                    <Text style={{ fontSize: fs.base, color: '#222', lineHeight: 24 }}>{selectedItem.content}</Text>
                </ScrollView>
            </View>
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: '#FAFAFA' }}>
            <View style={[styles.header, { backgroundColor: '#09090B' }]}>
                <TouchableOpacity style={styles.headerIconWrap} onPress={onBack}>
                    <Text style={{ color: '#FAFAFA', fontSize: 16 }}>←</Text>
                </TouchableOpacity>
                <Text style={[styles.title, { fontSize: fs.lg }]}>개선사항 / 공지</Text>
            </View>
            <FlatList
                data={items}
                keyExtractor={item => item.id}
                contentContainerStyle={{ padding: 12 }}
                onEndReached={loadMore}
                onEndReachedThreshold={0.3}
                ListEmptyComponent={
                    isLoading ? <ActivityIndicator style={{ marginTop: 40 }} /> :
                    <Text style={{ textAlign: 'center', color: '#aaa', marginTop: 40, fontSize: fs.base }}>등록된 내용이 없습니다.</Text>
                }
                ListFooterComponent={isLoading && items.length > 0 ? <ActivityIndicator style={{ marginVertical: 12 }} /> : null}
                renderItem={({ item }) => (
                    <TouchableOpacity
                        style={{ backgroundColor: '#f9f9f9', borderRadius: 10, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#eee' }}
                        onPress={() => setSelectedItem(item)}
                    >
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                            <View style={{ backgroundColor: IMPROVEMENT_CATEGORY_COLORS[item.category] || '#777', borderRadius: 4, paddingHorizontal: 7, paddingVertical: 2, marginRight: 8 }}>
                                <Text style={{ color: '#fff', fontSize: fs.xs, fontWeight: '700' }}>{item.category}</Text>
                            </View>
                            {item.version && (
                                <Text style={{ fontSize: fs.xs, color: '#888', marginRight: 6 }}>v{item.version}</Text>
                            )}
                            <Text style={{ fontSize: fs.xs, color: '#bbb', marginLeft: 'auto' }}>
                                {new Date(item.created_at).toLocaleDateString('ko-KR')}
                            </Text>
                        </View>
                        <Text style={{ fontSize: fs.base, fontWeight: '600', color: '#222', marginBottom: 4 }}>{item.title}</Text>
                        <Text style={{ fontSize: fs.sm, color: '#666' }} numberOfLines={1}>{item.content}</Text>
                    </TouchableOpacity>
                )}
            />
        </View>
    );
};

// ===== MoreScreen =====

const MoreScreen = ({ onMoveToMap, onMoveToMapWithLocation, onOpenProperty, variant = 'profile' }: {
    onMoveToMap: () => void;
    onMoveToMapWithLocation: (lat: number, lng: number, address: string) => void;
    onOpenProperty: (propertyId: string) => void;
    // 'sales' = 영업 탭(오늘 할 일이 루트), 'profile' = 내정보 탭(메뉴가 루트)
    variant?: 'sales' | 'profile';
}) => {
    const { elderlyMode, setElderlyMode, tilkoBalance, setTilkoBalance } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    type MoreView = 'menu' | 'moabogi' | 'recent' | 'favorites' | 'registry' | 'improvements' | 'stats' | 'notifications' | 'reminders' | 'activity' | 'buildings' | 'places';
    const rootView: MoreView = variant === 'sales' ? 'moabogi' : 'menu';
    const [currentView, setCurrentView] = useState<MoreView>(rootView);
    const [balanceLoading, setBalanceLoading] = useState(false);
    const [balanceUpdatedAt, setBalanceUpdatedAt] = useState<string | null>(null);
    const [registryCount, setRegistryCount] = useState<number | null>(null);
    const [favoritesCount, setFavoritesCount] = useState<number | null>(null);
    const [unreadCount, setUnreadCount] = useState(0);

    const handleRefreshBalance = useCallback(async () => {
        setBalanceLoading(true);
        try {
            const { data } = await supabase
                .from('tilko_balance')
                .select('balance, updated_at')
                .eq('id', 1)
                .single();
            if (data && typeof data.balance === 'number') {
                setTilkoBalance(data.balance);
                setBalanceUpdatedAt(data.updated_at ?? null);
            }
        } catch { /* ignore */ } finally {
            setBalanceLoading(false);
        }
    }, [setTilkoBalance]);

    // 화면 10: 내정보 카드 건수 (등기 이력 / 즐겨찾기 / 알림)
    useEffect(() => {
        if (variant !== 'profile') return;
        (async () => {
            try {
                const [regRes, favJson, unread] = await Promise.all([
                    supabase.from('registry_views').select('id', { count: 'exact', head: true }),
                    AsyncStorage.getItem(FAVORITE_PLACES_KEY),
                    getUnreadNotificationCount(),
                ]);
                setRegistryCount(regRes.count ?? 0);
                const favs: unknown[] = favJson ? JSON.parse(favJson) : [];
                setFavoritesCount(favs.length);
                setUnreadCount(unread);
            } catch (_) {}
        })();
    }, [variant]);
    if (currentView === 'moabogi') return (
        <View style={{ flex: 1, backgroundColor: COLORS.surface }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: COLORS.lineSoft, backgroundColor: COLORS.white }}>
                {variant !== 'sales' && (
                    <TouchableOpacity onPress={() => setCurrentView(rootView)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={{ marginRight: 12 }}>
                        <Text style={{ fontSize: 22, color: COLORS.primary, fontWeight: '700' }}>{'←'}</Text>
                    </TouchableOpacity>
                )}
                <Text style={{ ...TYPOGRAPHY.subHeader, fontSize: fs.lg, color: COLORS.ink }}>오늘 할 일</Text>
            </View>
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 130 }}>
                <MoabogiCards
                    onShowPlaces={() => setCurrentView('places')}
                    onShowNotifications={() => setCurrentView('notifications')}
                    onShowReminders={() => setCurrentView('reminders')}
                    onShowActivity={() => setCurrentView('activity')}
                    onShowStats={() => setCurrentView('stats')}
                    onOpenProperty={onOpenProperty}
                />
            </ScrollView>
        </View>
    );
    if (currentView === 'recent') return <RecentPlacesScreen onBack={() => setCurrentView(rootView)} onMoveToMap={onMoveToMap} />;
    if (currentView === 'favorites') return <FavoritePlacesScreen onBack={() => setCurrentView(rootView)} onMoveToMap={onMoveToMap} />;
    if (currentView === 'registry') return <RegistryHistoryScreen onBack={() => setCurrentView(rootView)} />;
    if (currentView === 'improvements') return <ImprovementsScreen onBack={() => setCurrentView(rootView)} />;
    if (currentView === 'stats') return <SalesStatsScreen onBack={() => setCurrentView(rootView)} />;
    if (currentView === 'notifications') return (
        <NotificationsScreen onBack={() => setCurrentView(rootView)} onOpenProperty={onOpenProperty} initialTab="news" />
    );
    if (currentView === 'activity') return <SalesActivityScreen onBack={() => setCurrentView(rootView)} />;
    if (currentView === 'buildings') return <BuildingListScreen onMoveToMap={onMoveToMap} />;
    if (currentView === 'places') return <PlaceManagementListScreen onBack={() => setCurrentView(rootView)} onMoveToMap={onMoveToMapWithLocation} />;
    if (currentView === 'reminders') return (
        <NotificationsScreen onBack={() => setCurrentView(rootView)} onOpenProperty={onOpenProperty} initialTab="todo" />
    );
    return (
        <ScrollView style={{ flex: 1, backgroundColor: COLORS.surface }} contentContainerStyle={{ padding: SPACING.xl3, paddingBottom: 108, gap: SPACING.base }}>
            <Text style={{ fontSize: elderlyMode ? 30 : 26, fontWeight: '700', color: COLORS.ink }}>내정보</Text>

            {/* 포인트 카드 */}
            <View style={{ backgroundColor: COLORS.ink, borderRadius: RADIUS.sheet - 2, padding: SPACING.xl4 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <View>
                        <Text style={{ fontSize: fs.base, color: COLORS.textOnDarkMuted }}>틸코 포인트</Text>
                        {balanceLoading ? (
                            <ActivityIndicator size="small" color={COLORS.white} style={{ marginTop: SPACING.sm }} />
                        ) : (
                            <Text style={{ fontSize: elderlyMode ? 38 : 34, fontWeight: '900', color: COLORS.white, marginTop: 4 }}>
                                {tilkoBalance !== null ? `${tilkoBalance.toLocaleString()}P` : '미조회'}
                            </Text>
                        )}
                    </View>
                    <TouchableOpacity
                        onPress={handleRefreshBalance}
                        disabled={balanceLoading}
                        style={{ backgroundColor: '#2B2F37', borderRadius: RADIUS.input, paddingHorizontal: SPACING.xl2, paddingVertical: SPACING.base }}
                        accessibilityLabel="잔액 새로고침"
                        accessibilityRole="button"
                    >
                        <Text style={{ fontSize: fs.base, fontWeight: '700', color: COLORS.white }}>잔액 조회</Text>
                    </TouchableOpacity>
                </View>
                <Text style={{ fontSize: fs.sm, color: COLORS.textOnDarkMuted, marginTop: SPACING.base }}>
                    {tilkoBalance !== null && tilkoBalance < 5 ? '잔액이 부족합니다 · ' : ''}등기 조회 시 자동 차감 및 갱신됩니다
                    {balanceUpdatedAt && !balanceLoading ? ` · ${new Date(balanceUpdatedAt).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} 갱신` : ''}
                </Text>
            </View>

            {/* 등기 열람 이력 / 즐겨찾는 장소 */}
            <View style={{ backgroundColor: COLORS.white, borderRadius: RADIUS.sheet - 2 }}>
                <TouchableOpacity
                    onPress={() => setCurrentView('registry')}
                    style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.xl2, paddingVertical: SPACING.xl2 }}
                    accessibilityLabel="등기 열람 이력 화면으로 이동"
                    accessibilityRole="button"
                >
                    <Text style={{ flex: 1, fontSize: fs.xl, fontWeight: '500', color: COLORS.ink }}>등기 열람 이력</Text>
                    <Text style={{ fontSize: fs.base, color: COLORS.textMuted, marginRight: SPACING.sm }}>
                        {registryCount !== null ? `${registryCount}건` : ''}
                    </Text>
                    <Text style={{ fontSize: 20, color: COLORS.chevron }}>{'›'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                    onPress={() => setCurrentView('favorites')}
                    style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.xl2, paddingVertical: SPACING.xl2, borderTopWidth: 1, borderTopColor: COLORS.lineSoft2 }}
                    accessibilityLabel="즐겨 찾는 장소 화면으로 이동"
                    accessibilityRole="button"
                >
                    <Text style={{ flex: 1, fontSize: fs.xl, fontWeight: '500', color: COLORS.ink }}>즐겨찾는 장소</Text>
                    <Text style={{ fontSize: fs.base, color: COLORS.textMuted, marginRight: SPACING.sm }}>
                        {favoritesCount !== null ? `${favoritesCount}곳` : ''}
                    </Text>
                    <Text style={{ fontSize: 20, color: COLORS.chevron }}>{'›'}</Text>
                </TouchableOpacity>
            </View>

            {/* 글자 크게 보기 */}
            <View style={{ backgroundColor: COLORS.white, borderRadius: RADIUS.card, padding: SPACING.xl2, flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: fs.lg, fontWeight: '700', color: COLORS.ink }}>글자 크게 보기</Text>
                    <Text style={{ fontSize: fs.sm, color: COLORS.textMuted, marginTop: 4 }}>글자와 버튼을 크게 표시합니다</Text>
                </View>
                <TouchableOpacity
                    onPress={() => setElderlyMode(!elderlyMode)}
                    style={{ width: 62, height: 36, borderRadius: 18, backgroundColor: elderlyMode ? COLORS.primary : COLORS.line, padding: 3, justifyContent: 'center' }}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: elderlyMode }}
                    accessibilityLabel="글자 크게 보기"
                >
                    <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: COLORS.white, alignSelf: elderlyMode ? 'flex-end' : 'flex-start' }} />
                </TouchableOpacity>
            </View>

            {/* 알림 / 공지 */}
            <View style={{ backgroundColor: COLORS.white, borderRadius: RADIUS.sheet - 2 }}>
                <TouchableOpacity
                    onPress={() => setCurrentView('notifications')}
                    style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.xl2, paddingVertical: SPACING.xl2 }}
                    accessibilityLabel="알림 화면으로 이동"
                    accessibilityRole="button"
                >
                    <Text style={{ flex: 1, fontSize: fs.xl, fontWeight: '500', color: COLORS.ink }}>알림</Text>
                    {unreadCount > 0 && (
                        <View style={{ backgroundColor: COLORS.dangerStrong, borderRadius: 10, minWidth: 20, height: 20, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5, marginRight: SPACING.sm }}>
                            <Text style={{ color: COLORS.white, fontSize: 11, fontWeight: '700' }}>{unreadCount}</Text>
                        </View>
                    )}
                    <Text style={{ fontSize: 20, color: COLORS.chevron }}>{'›'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                    onPress={() => setCurrentView('improvements')}
                    style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.xl2, paddingVertical: SPACING.xl2, borderTopWidth: 1, borderTopColor: COLORS.lineSoft2 }}
                    accessibilityLabel="새로운 기능 및 공지 화면으로 이동"
                    accessibilityRole="button"
                >
                    <Text style={{ flex: 1, fontSize: fs.xl, fontWeight: '500', color: COLORS.ink }}>새로운 기능 · 공지</Text>
                    <Text style={{ fontSize: 20, color: COLORS.chevron }}>{'›'}</Text>
                </TouchableOpacity>
            </View>

            <TouchableOpacity
                onPress={() => setCurrentView('recent')}
                style={{ paddingVertical: SPACING.base, alignItems: 'center' }}
                accessibilityLabel="최근 본 장소 화면으로 이동"
                accessibilityRole="button"
            >
                <Text style={{ fontSize: fs.base, color: COLORS.primary, fontWeight: '700' }}>최근 본 장소 보기</Text>
            </TouchableOpacity>
        </ScrollView>
    );
};

// ===== BuildingListScreen =====

// 화면 12/13 공용: 카테고리별 칩 색상
const BUILDING_CATEGORY_STYLE: Record<string, { bg: string; text: string }> = {
    '공장': { bg: COLORS.primaryTint, text: COLORS.primary },
    '창고': { bg: COLORS.successTint2, text: COLORS.success },
    '물류': { bg: '#F3EEFC', text: '#7C3AED' },
};
const AREA_THRESHOLD_OPTIONS = [500, 1000, 3000];

const BuildingListScreen = ({ onMoveToMap }: { onMoveToMap: () => void }) => {
    const { region, buildings, isLoading, isLoadingMore, fetchBuildings, lastFetchedRegion, page, hasMore, setRegion, setSelectedMarker, saveRecentPlace, buildingFilter, setBuildingFilter, elderlyMode, parcelAreas, setParcelArea, listSort, setListSort, minAreaM2, setMinAreaM2 } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
    const [areaSheetVisible, setAreaSheetVisible] = useState(false);
    const [registryViewed, setRegistryViewed] = useState<Array<{ lat: number; lng: number; viewed_at: string }>>([]);

    useEffect(() => {
        (async () => {
            try {
                const jsonValue = await AsyncStorage.getItem(FAVORITE_PLACES_KEY);
                const places: Building[] = jsonValue ? JSON.parse(jsonValue) : [];
                setFavoriteIds(new Set(places.map(p => p.id)));
            } catch (_) {}
        })();
        supabase.from('registry_views').select('lat, lng, viewed_at').order('viewed_at', { ascending: false }).then(({ data }) => {
            setRegistryViewed((data || []) as Array<{ lat: number; lng: number; viewed_at: string }>);
        });
    }, []);

    const findViewedAt = (item: Building): string | null => {
        const delta = 0.001;
        const match = registryViewed.find(r => Math.abs(r.lat - item.latitude) <= delta && Math.abs(r.lng - item.longitude) <= delta);
        return match?.viewed_at ?? null;
    };

    const toggleFavorite = async (item: Building) => {
        try {
            const jsonValue = await AsyncStorage.getItem(FAVORITE_PLACES_KEY);
            let places: Building[] = jsonValue ? JSON.parse(jsonValue) : [];
            const newIds = new Set(favoriteIds);
            if (favoriteIds.has(item.id)) {
                places = places.filter(p => p.id !== item.id);
                newIds.delete(item.id);
            } else {
                places.unshift({ ...item, timestamp: Date.now() });
                newIds.add(item.id);
            }
            await AsyncStorage.setItem(FAVORITE_PLACES_KEY, JSON.stringify(places));
            setFavoriteIds(newIds);
        } catch (e) {
            console.error('Failed to toggle favorite', e);
        }
    };

    useEffect(() => {
        const shouldFetch = !lastFetchedRegion ||
            Math.abs(lastFetchedRegion.latitude - region.latitude) > 0.001 ||
            Math.abs(lastFetchedRegion.longitude - region.longitude) > 0.001;
        if (shouldFetch) fetchBuildings(region, 1);
    }, []);

    // 카테고리별 건수 (전체 fetch 결과 기준)
    const categoryCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        FILTER_CATEGORIES.forEach(c => { counts[c] = buildings.filter(b => b.category?.includes(c)).length; });
        return counts;
    }, [buildings]);
    const activeCategory = buildingFilter.selectedCategories.length === 1 ? buildingFilter.selectedCategories[0] : null;
    const selectCategory = (cat: string | null) => {
        setBuildingFilter({ ...buildingFilter, selectedCategories: cat === null ? FILTER_CATEGORIES : [cat] });
    };

    // 카테고리 필터 + 면적 하한 필터 (면적 하한은 조회된 항목에만 적용)
    const filteredBuildings = useMemo(() => {
        return buildings.filter(b => {
            if (buildingFilter.selectedCategories.length < FILTER_CATEGORIES.length) {
                if (!b.category) return false;
                if (!buildingFilter.selectedCategories.some(cat => b.category?.includes(cat))) return false;
            }
            if (minAreaM2 !== null) {
                const key = `${b.latitude.toFixed(6)},${b.longitude.toFixed(6)}`;
                const area = parcelAreas[key]?.landAreaM2;
                if (area === undefined || area < minAreaM2) return false;
            }
            return true;
        });
    }, [buildings, buildingFilter, minAreaM2, parcelAreas]);

    // 정렬: 가까운 순(기본) / 부지 넓은 순(미확인 항목은 하단)
    const sortedBuildings = useMemo(() => {
        if (listSort !== 'area') return filteredBuildings;
        return [...filteredBuildings].sort((a, b) => {
            const keyA = `${a.latitude.toFixed(6)},${a.longitude.toFixed(6)}`;
            const keyB = `${b.latitude.toFixed(6)},${b.longitude.toFixed(6)}`;
            const areaA = parcelAreas[keyA]?.landAreaM2;
            const areaB = parcelAreas[keyB]?.landAreaM2;
            if (areaA === undefined && areaB === undefined) return a.distance - b.distance;
            if (areaA === undefined) return 1;
            if (areaB === undefined) return -1;
            return areaB - areaA;
        });
    }, [filteredBuildings, listSort, parcelAreas]);

    // 화면에 보이는 항목만 지적도 면적 조회 (캐시 우선)
    const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: Array<{ item: Building }> }) => {
        viewableItems.forEach(({ item }) => {
            const key = `${item.latitude.toFixed(6)},${item.longitude.toFixed(6)}`;
            if (parcelAreas[key]) return;
            fetchParcelArea(item.latitude, item.longitude).then(result => {
                if (result) setParcelArea(key, result.landAreaM2);
            });
        });
    }).current;

    if (isLoading && buildings.length === 0) {
        return (
            <View style={styles.listContainer}>
                {Array.from({ length: 6 }).map((_, i) => <SkeletonItem key={i} />)}
            </View>
        );
    }

    return (
        <View style={[styles.listContainer, { backgroundColor: COLORS.surface }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.xl3, paddingTop: SPACING.base }}>
                <Text style={{ fontSize: fs['2xl'], fontWeight: '700', color: COLORS.ink }}>주변 건물</Text>
                <TouchableOpacity
                    onPress={onMoveToMap}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, backgroundColor: COLORS.surface, borderRadius: RADIUS.input, paddingHorizontal: SPACING.base, paddingVertical: SPACING.sm }}
                    accessibilityLabel="지도에서 보기"
                    accessibilityRole="button"
                >
                    <View style={{ width: 14, height: 14, borderWidth: 1.5, borderColor: COLORS.inkSub, borderRadius: 3 }} />
                    <Text style={{ fontSize: fs.sm, fontWeight: '700', color: COLORS.inkSub }}>지도</Text>
                </TouchableOpacity>
            </View>

            {/* 카테고리 칩 (건수 포함) */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, paddingHorizontal: SPACING.xl3, paddingTop: SPACING.base, paddingBottom: SPACING.base }}>
                <TouchableOpacity
                    onPress={() => selectCategory(null)}
                    style={{ paddingHorizontal: SPACING.base, paddingVertical: SPACING.xs, borderRadius: RADIUS.chip, backgroundColor: activeCategory === null ? COLORS.ink : COLORS.white }}
                >
                    <Text style={{ fontSize: fs.sm, fontWeight: '600', color: activeCategory === null ? COLORS.white : COLORS.inkSub }}>전체 {buildings.length}</Text>
                </TouchableOpacity>
                {FILTER_CATEGORIES.map(cat => (
                    <TouchableOpacity
                        key={cat}
                        onPress={() => selectCategory(activeCategory === cat ? null : cat)}
                        style={{ paddingHorizontal: SPACING.base, paddingVertical: SPACING.xs, borderRadius: RADIUS.chip, backgroundColor: activeCategory === cat ? COLORS.ink : COLORS.white }}
                    >
                        <Text style={{ fontSize: fs.sm, fontWeight: '600', color: activeCategory === cat ? COLORS.white : COLORS.inkSub }}>{cat} {categoryCounts[cat] || 0}</Text>
                    </TouchableOpacity>
                ))}
            </View>

            {/* 정렬 · 면적 필터 행 */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingHorizontal: SPACING.xl3, paddingBottom: SPACING.base }}>
                <TouchableOpacity
                    onPress={() => setListSort('area')}
                    style={{ height: 42, borderRadius: RADIUS.input, paddingHorizontal: SPACING.base, alignItems: 'center', justifyContent: 'center', backgroundColor: listSort === 'area' ? COLORS.primaryTint : COLORS.surface }}
                >
                    <Text style={{ fontSize: fs.sm, fontWeight: listSort === 'area' ? '700' : '500', color: listSort === 'area' ? COLORS.primary : COLORS.inkSub }}>부지 넓은 순</Text>
                </TouchableOpacity>
                <TouchableOpacity
                    onPress={() => setListSort('distance')}
                    style={{ height: 42, borderRadius: RADIUS.input, paddingHorizontal: SPACING.base, alignItems: 'center', justifyContent: 'center', backgroundColor: listSort === 'distance' ? COLORS.primaryTint : COLORS.surface }}
                >
                    <Text style={{ fontSize: fs.sm, fontWeight: listSort === 'distance' ? '700' : '500', color: listSort === 'distance' ? COLORS.primary : COLORS.inkSub }}>가까운 순</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setAreaSheetVisible(true)} style={{ marginLeft: 'auto' }}>
                    <Text style={{ fontSize: fs.sm, color: COLORS.textMuted }}>
                        {minAreaM2 !== null ? `${minAreaM2.toLocaleString()}㎡ 이상만` : '면적 전체'}
                    </Text>
                </TouchableOpacity>
            </View>

            <FlatList
                data={sortedBuildings}
                keyExtractor={(item) => item.id}
                removeClippedSubviews={true}
                maxToRenderPerBatch={10}
                windowSize={5}
                onViewableItemsChanged={onViewableItemsChanged}
                viewabilityConfig={{ itemVisiblePercentThreshold: 20 }}
                renderItem={({ item }) => {
                    const key = `${item.latitude.toFixed(6)},${item.longitude.toFixed(6)}`;
                    const area = parcelAreas[key]?.landAreaM2;
                    const viewedAt = findViewedAt(item);
                    const catStyle = item.category ? Object.entries(BUILDING_CATEGORY_STYLE).find(([k]) => item.category?.includes(k))?.[1] : null;
                    return (
                        <View style={{ backgroundColor: COLORS.white, borderRadius: RADIUS.sheet - 2, padding: SPACING.xl3, marginHorizontal: SPACING.xl3, marginBottom: SPACING.base }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                {item.category ? (
                                    <View style={{ backgroundColor: catStyle?.bg || COLORS.surface, borderRadius: RADIUS.chip, paddingHorizontal: SPACING.base, paddingVertical: 3, marginRight: SPACING.sm }}>
                                        <Text style={{ fontSize: fs.sm, fontWeight: '700', color: catStyle?.text || COLORS.inkSub }}>{item.category}</Text>
                                    </View>
                                ) : null}
                                <Text style={{ fontSize: fs.sm, color: COLORS.textMuted }}>{formatDistance(item.distance)}</Text>
                                <View style={{ flex: 1 }} />
                                <TouchableOpacity
                                    onPress={() => toggleFavorite(item)}
                                    style={{ width: 52, height: 52, borderRadius: RADIUS.input, backgroundColor: favoriteIds.has(item.id) ? COLORS.warnTint : COLORS.surface, alignItems: 'center', justifyContent: 'center' }}
                                    accessibilityLabel={favoriteIds.has(item.id) ? `${item.name} 즐겨찾기 해제` : `${item.name} 즐겨찾기 추가`}
                                    accessibilityRole="button"
                                >
                                    <Text style={{ fontSize: 22, color: favoriteIds.has(item.id) ? COLORS.warnAccent : COLORS.line }}>{'★'}</Text>
                                </TouchableOpacity>
                            </View>
                            <Text style={{ fontSize: fs.xl, fontWeight: '700', color: COLORS.ink, marginTop: SPACING.base }} numberOfLines={1}>{item.name}</Text>
                            <Text style={{ fontSize: fs.sm, color: COLORS.textMuted, marginTop: 2 }} numberOfLines={1}>{item.address}</Text>

                            <View style={{ marginTop: SPACING.base }}>
                                {area !== undefined ? (
                                    <Text style={{ fontSize: fs.lg + 1, fontWeight: '700', color: COLORS.ink }}>
                                        {area.toLocaleString()}㎡ <Text style={{ fontSize: fs.sm, fontWeight: '400', color: COLORS.textMuted }}>{sqmToPyeong(area).toLocaleString()}평 · 지적도</Text>
                                    </Text>
                                ) : (
                                    <Text style={{ fontSize: fs.sm, color: COLORS.textMuted }}>면적 확인 중</Text>
                                )}
                            </View>

                            {viewedAt && (
                                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: SPACING.sm }}>
                                    <Text style={{ fontSize: 14, color: COLORS.success, marginRight: 4 }}>{'✓'}</Text>
                                    <Text style={{ fontSize: fs.sm, fontWeight: '700', color: COLORS.success }}>{formatShortDate(viewedAt)} 등기 조회함</Text>
                                </View>
                            )}

                            <TouchableOpacity
                                style={{ height: 52, borderRadius: RADIUS.input, backgroundColor: COLORS.surface, alignItems: 'center', justifyContent: 'center', marginTop: SPACING.base }}
                                onPress={async () => {
                                    await saveRecentPlace(item);
                                    setSelectedMarker(item);
                                    setRegion({ latitude: item.latitude, longitude: item.longitude, latitudeDelta: 0.002, longitudeDelta: 0.002 });
                                    onMoveToMap();
                                }}
                                accessibilityLabel={`${item.name} 지도에서 보기`}
                                accessibilityRole="button"
                            >
                                <Text style={{ fontSize: fs.base, fontWeight: '700', color: COLORS.inkSub }}>지도에서 보기</Text>
                            </TouchableOpacity>
                        </View>
                    );
                }}
                contentContainerStyle={{ paddingBottom: 100 }}
                refreshing={isLoading}
                onRefresh={() => fetchBuildings(region, 1)}
                onEndReached={() => { if (!isLoadingMore && !isLoading && hasMore) fetchBuildings(region, page + 1); }}
                onEndReachedThreshold={0.5}
                ListFooterComponent={isLoadingMore ? <ActivityIndicator style={{ padding: 16 }} color={COLORS.textMuted} /> : null}
                ListEmptyComponent={
                    <View style={styles.emptyContainer}>
                        <Text style={[styles.emptyText, { fontSize: fs.base, lineHeight: fs.base * 1.6 }]}>주변 1km 이내에 공장·창고·물류 건물이 없습니다.{'\n'}산업단지 주변으로 이동 후 새로고침 해주세요.</Text>
                    </View>
                }
            />

            {/* 면적 하한 선택 시트 */}
            <Modal visible={areaSheetVisible} transparent animationType="fade" onRequestClose={() => setAreaSheetVisible(false)}>
                <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(16,24,40,0.45)', justifyContent: 'flex-end' }} activeOpacity={1} onPress={() => setAreaSheetVisible(false)}>
                    <View style={{ backgroundColor: COLORS.white, borderTopLeftRadius: RADIUS.sheet, borderTopRightRadius: RADIUS.sheet, padding: SPACING.xl3, paddingBottom: SPACING.xl6 }}>
                        <Text style={{ fontSize: fs.xl, fontWeight: '700', color: COLORS.ink, marginBottom: SPACING.base }}>면적 하한 필터</Text>
                        {[{ label: '전체', value: null as number | null }, ...AREA_THRESHOLD_OPTIONS.map(v => ({ label: `${v.toLocaleString()}㎡ 이상`, value: v }))].map(opt => (
                            <TouchableOpacity
                                key={opt.label}
                                onPress={() => { setMinAreaM2(opt.value); setAreaSheetVisible(false); }}
                                style={{ height: 56, justifyContent: 'center', borderTopWidth: 1, borderTopColor: COLORS.lineSoft2 }}
                            >
                                <Text style={{ fontSize: fs.lg, fontWeight: minAreaM2 === opt.value ? '700' : '500', color: minAreaM2 === opt.value ? COLORS.primary : COLORS.ink }}>{opt.label}</Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                </TouchableOpacity>
            </Modal>
        </View>
    );
};

// ===== SalesStatsScreen (영업 성과 통계) =====

const SalesStatsScreen = ({ onBack }: { onBack: () => void }) => {
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    type StatPeriod = 'week' | 'month' | 'all';
    const [period, setPeriod] = useState<StatPeriod>('month');
    const [statusCounts, setStatusCounts] = useState<Record<SalesStatus, number>>({
        '미접촉': 0, '접촉': 0, '영업성공': 0, '영업실패': 0, '대기중': 0, '보류': 0,
    });
    const [totalProps, setTotalProps] = useState(0);
    const [activityKm, setActivityKm] = useState(0);
    const [activityVisits, setActivityVisits] = useState(0);
    const [isLoading, setIsLoading] = useState(true);

    const getPeriodStart = (p: StatPeriod): string => {
        const now = new Date();
        if (p === 'week') {
            const d = new Date(now);
            d.setDate(d.getDate() - 7);
            return d.toISOString();
        } else if (p === 'month') {
            return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        }
        return '2000-01-01T00:00:00';
    };

    useEffect(() => {
        (async () => {
            setIsLoading(true);
            try {
                const periodStart = getPeriodStart(period);
                const [propsRes, activityRes] = await Promise.all([
                    supabase.from('properties').select('sales_status'),
                    supabase.from('activity_logs')
                        .select('distance_from_prev_km')
                        .gte('visited_at', periodStart),
                ]);
                const counts: Record<SalesStatus, number> = {
                    '미접촉': 0, '접촉': 0, '영업성공': 0, '영업실패': 0, '대기중': 0, '보류': 0,
                };
                let total = 0;
                for (const row of propsRes.data || []) {
                    const s = row.sales_status as SalesStatus;
                    if (s in counts) { counts[s]++; total++; }
                }
                setStatusCounts(counts);
                setTotalProps(total);
                const logs = activityRes.data || [];
                setActivityKm(logs.reduce((s: number, l: { distance_from_prev_km: number }) => s + (l.distance_from_prev_km || 0), 0));
                setActivityVisits(logs.length);
            } catch (_) {}
            setIsLoading(false);
        })();
    }, [period]);

    const PERIOD_OPTIONS: { key: StatPeriod; label: string }[] = [
        { key: 'week', label: '최근 7일' },
        { key: 'month', label: '이번 달' },
        { key: 'all', label: '전체' },
    ];

    return (
        <View style={styles.subScreenContainer}>
            <View style={styles.subScreenHeader}>
                <TouchableOpacity onPress={onBack} style={styles.backButton}>
                    <Text style={[styles.backButtonText, { fontSize: fs.lg }]}>{'< 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={[styles.subScreenTitle, { fontSize: fs['2xl'] }]}>영업 통계</Text>
                <View style={{ width: 60 }} />
            </View>

            {/* 기간 선택 */}
            <View style={{ flexDirection: 'row', paddingHorizontal: SPACING.xl3, paddingVertical: SPACING.base, gap: SPACING.sm, backgroundColor: COLORS.white, borderBottomWidth: 1, borderBottomColor: COLORS.lineSoft }}>
                {PERIOD_OPTIONS.map(opt => (
                    <TouchableOpacity
                        key={opt.key}
                        onPress={() => setPeriod(opt.key)}
                        style={{ flex: 1, height: 44, borderRadius: RADIUS.input, alignItems: 'center', justifyContent: 'center', backgroundColor: period === opt.key ? COLORS.ink : COLORS.surface }}
                    >
                        <Text style={{ fontSize: fs.sm, color: period === opt.key ? COLORS.white : COLORS.inkSub, fontWeight: '600' }}>{opt.label}</Text>
                    </TouchableOpacity>
                ))}
            </View>

            {isLoading ? (
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                    <ActivityIndicator size="large" color={COLORS.primary} />
                </View>
            ) : (
                <ScrollView contentContainerStyle={{ padding: SPACING.xl3 }}>
                    {/* 핵심 지표: 성사 건수 */}
                    <View style={{ backgroundColor: COLORS.white, borderRadius: RADIUS.card, padding: SPACING.xl3, marginBottom: SPACING.base }}>
                        <Text style={{ fontSize: fs.base, color: COLORS.textMuted }}>
                            {PERIOD_OPTIONS.find(p => p.key === period)?.label} 성사
                        </Text>
                        <Text style={{ fontSize: elderlyMode ? 48 : 44, fontWeight: '900', color: COLORS.success, marginTop: SPACING.xs }}>
                            {statusCounts['영업성공']}건
                        </Text>
                    </View>

                    {/* 진행 단계 */}
                    <View style={{ backgroundColor: COLORS.white, borderRadius: RADIUS.card, padding: SPACING.xl3, marginBottom: SPACING.base }}>
                        <Text style={{ fontSize: fs.sm, fontWeight: '700', color: COLORS.inkSub, marginBottom: SPACING.base }}>진행 단계</Text>
                        {totalProps === 0 ? (
                            <Text style={{ fontSize: fs.sm, color: COLORS.textMuted, textAlign: 'center', paddingVertical: SPACING.xl2 }}>등록된 매물이 없습니다.</Text>
                        ) : (
                            SALES_STATUSES.map(s => {
                                const count = statusCounts[s] || 0;
                                const pct = totalProps > 0 ? count / totalProps : 0;
                                return (
                                    <View key={s} style={{ marginBottom: SPACING.base }}>
                                        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.xs }}>
                                            <Text style={{ fontSize: fs.base, color: COLORS.ink, flex: 1 }}>{s}</Text>
                                            <Text style={{ fontSize: fs.base, color: COLORS.inkSub, fontWeight: '700' }}>{count}건</Text>
                                        </View>
                                        <View style={{ height: 12, backgroundColor: COLORS.surface, borderRadius: 6, overflow: 'hidden' }}>
                                            <View style={{ height: '100%', width: `${Math.round(pct * 100)}%`, backgroundColor: SALES_STATUS_COLORS[s], borderRadius: 6 }} />
                                        </View>
                                    </View>
                                );
                            })
                        )}
                    </View>

                    {/* 이동 기록 */}
                    <View style={{ backgroundColor: COLORS.white, borderRadius: RADIUS.card, padding: SPACING.xl3 }}>
                        <Text style={{ fontSize: fs.sm, fontWeight: '700', color: COLORS.inkSub, marginBottom: SPACING.base }}>
                            이동 기록 <Text style={{ fontWeight: '400', color: COLORS.textMuted }}>({PERIOD_OPTIONS.find(p => p.key === period)?.label})</Text>
                        </Text>
                        <View style={{ flexDirection: 'row', gap: SPACING.base }}>
                            <View style={{ flex: 1, backgroundColor: COLORS.surface, borderRadius: RADIUS.button, padding: SPACING.xl2, alignItems: 'center' }}>
                                <Text style={{ fontSize: fs.sm, color: COLORS.textMuted, marginBottom: 4 }}>총 이동거리</Text>
                                <Text style={{ fontSize: fs.xl + 10, fontWeight: '700', color: COLORS.ink }}>{activityKm.toFixed(1)}</Text>
                                <Text style={{ fontSize: fs.sm, color: COLORS.textMuted }}>km</Text>
                            </View>
                            <View style={{ flex: 1, backgroundColor: COLORS.surface, borderRadius: RADIUS.button, padding: SPACING.xl2, alignItems: 'center' }}>
                                <Text style={{ fontSize: fs.sm, color: COLORS.textMuted, marginBottom: 4 }}>GPS 방문 기록</Text>
                                <Text style={{ fontSize: fs.xl + 10, fontWeight: '700', color: COLORS.ink }}>{activityVisits}</Text>
                                <Text style={{ fontSize: fs.sm, color: COLORS.textMuted }}>건</Text>
                            </View>
                        </View>
                    </View>
                </ScrollView>
            )}
        </View>
    );
};

// ===== RegionSelectorModal =====

type RegionStep = 'province' | 'city' | 'town';

interface RegionSelectorModalProps {
    visible: boolean;
    onClose: () => void;
    onSelect: (lat: number, lng: number, label: string, zoom: { latitudeDelta: number; longitudeDelta: number }) => void;
    currentLabel: string;
}

const RegionSelectorModal = React.memo(({ visible, onClose, onSelect, currentLabel }: RegionSelectorModalProps) => {
    const [step, setStep] = useState<RegionStep>('province');
    const [selectedProvince, setSelectedProvince] = useState<ProvinceData | null>(null);
    const [selectedCity, setSelectedCity] = useState<CityData | null>(null);

    const resetAndClose = useCallback(() => {
        setStep('province');
        setSelectedProvince(null);
        setSelectedCity(null);
        onClose();
    }, [onClose]);

    const handleProvinceSelect = useCallback((province: ProvinceData) => {
        setSelectedProvince(province);
        setStep('city');
    }, []);

    const handleCitySelect = useCallback((city: CityData) => {
        setSelectedCity(city);
        if (city.towns.length === 0) {
            onSelect(city.latitude, city.longitude, `${selectedProvince?.short} ${city.name}`, ZOOM_LEVEL.city);
            resetAndClose();
            return;
        }
        setStep('town');
    }, [selectedProvince, onSelect, resetAndClose]);

    const handleTownSelect = useCallback((town: TownData) => {
        onSelect(town.latitude, town.longitude, `${selectedCity?.name} ${town.name}`, ZOOM_LEVEL.town);
        resetAndClose();
    }, [selectedCity, onSelect, resetAndClose]);

    const handleCityDirectSelect = useCallback(() => {
        if (!selectedCity) return;
        onSelect(selectedCity.latitude, selectedCity.longitude, `${selectedProvince?.short} ${selectedCity.name}`, ZOOM_LEVEL.city);
        resetAndClose();
    }, [selectedCity, selectedProvince, onSelect, resetAndClose]);

    const stepTitle = step === 'province' ? '도/광역시 선택' : step === 'city' ? `${selectedProvince?.name}` : `${selectedCity?.name} 읍면동 선택`;
    const listData: (ProvinceData | CityData | TownData)[] = step === 'province' ? REGIONS : step === 'city' ? (selectedProvince?.cities ?? []) : (selectedCity?.towns ?? []);

    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={resetAndClose}>
            <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
                <View style={{ backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '75%' }}>
                    {/* 헤더 */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#F4F4F5' }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            {step !== 'province' && (
                                <TouchableOpacity onPress={() => setStep(step === 'town' ? 'city' : 'province')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                    <Text style={{ fontSize: 20, color: '#3F3F46' }}>{'←'}</Text>
                                </TouchableOpacity>
                            )}
                            <Text style={{ fontSize: 17, fontWeight: '700', color: '#18181B' }}>{stepTitle}</Text>
                        </View>
                        <TouchableOpacity onPress={resetAndClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                            <Text style={{ fontSize: 22, color: '#71717A' }}>×</Text>
                        </TouchableOpacity>
                    </View>

                    {/* 시군구 단계: 상단에 "시 전체" 선택 버튼 */}
                    {step === 'town' && selectedCity && (
                        <TouchableOpacity
                            onPress={handleCityDirectSelect}
                            style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, backgroundColor: '#F0F9FF', borderBottomWidth: 1, borderBottomColor: '#E0F2FE' }}
                        >
                            <Text style={{ fontSize: 15, color: '#0284C7', fontWeight: '600' }}>📍 {selectedCity.name} 전체 보기</Text>
                        </TouchableOpacity>
                    )}

                    <FlatList
                        data={listData}
                        keyExtractor={(item) => item.name}
                        renderItem={({ item }) => (
                            <TouchableOpacity
                                onPress={() => {
                                    if (step === 'province') handleProvinceSelect(item as ProvinceData);
                                    else if (step === 'city') handleCitySelect(item as CityData);
                                    else handleTownSelect(item as TownData);
                                }}
                                style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: '#F4F4F5' }}
                            >
                                <Text style={{ fontSize: 15, color: '#18181B' }}>
                                    {step === 'province' ? `${(item as ProvinceData).short}  ${item.name}` : item.name}
                                </Text>
                                {(step === 'province' || step === 'city') && (
                                    <Text style={{ fontSize: 13, color: '#A1A1AA' }}>{'>'}</Text>
                                )}
                            </TouchableOpacity>
                        )}
                        style={{ flexGrow: 0 }}
                    />
                    <View style={{ height: 30 }} />
                </View>
            </View>
        </Modal>
    );
});

// ===== 메인 앱 =====

function AppContent() {
    const [currentTab, setCurrentTab] = useState('map');
    const [placeManagementVisible, setPlaceManagementVisible] = useState(false);
    const mapRef = useRef<GoogleMapHandle>(null);
    const kakaoSkyRef = useRef<KakaoSkyViewHandle>(null);
    const { region, setRegion, selectedMarker, setSelectedMarker, mapType, setMapType, propertyMarkers, setPropertyMarkers, saveRecentPlace, buildingFilter, clusteringEnabled, setClusteringEnabled, elderlyMode, setElderlyMode, salesTargetFilter, setSalesTargetFilter, tilkoBalance, setTilkoBalance, parcelAreas, setParcelArea } = useMapStore();

    // 현재 활성화된 지도 ref로 이동 명령 전달 (mapType 구독 이후 선언)
    const animateActiveMap = useCallback((region: Region, duration?: number) => {
        if (mapType === 'satellite') {
            kakaoSkyRef.current?.animateToRegion(region, duration);
        } else {
            mapRef.current?.animateToRegion(region, duration);
        }
    }, [mapType]);
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const ts = elderlyMode ? TOUCH_SIZE.elderly : TOUCH_SIZE.normal;

    // 앱 시작 시 고령자 모드 복원 + 알림 핸들러 설정 + 스케줄 복원
    useEffect(() => {
        AsyncStorage.getItem(ELDERLY_MODE_KEY).then(val => {
            if (val !== null) setElderlyMode(JSON.parse(val));
        }).catch(console.warn);

        // 알림 표시 핸들러 (포그라운드)
        if (Notifications) {
            try {
                Notifications.setNotificationHandler({
                    handleNotification: async () => ({
                        shouldShowAlert: true,
                        shouldPlaySound: true,
                        shouldSetBadge: false,
                        shouldShowBanner: true,
                        shouldShowList: true,
                    }),
                });
            } catch (_) {}

            // 알림 탭 리스너 (백그라운드/종료 후 탭)
            let subscription: { remove: () => void } | null = null;
            try {
                subscription = Notifications.addNotificationResponseReceivedListener((response) => {
                    const propertyId = response.notification.request.content.data?.propertyId as string | undefined;
                    if (propertyId) {
                        setCurrentTab('map');
                        // 해당 매물을 지도에서 선택
                        supabase.from('properties').select('*').eq('property_id', propertyId).single().then(({ data }) => {
                            if (data) {
                                useMapStore.getState().setSelectedMarker({
                                    id: data.property_id,
                                    name: data.building_name || data.road_address || data.property_id,
                                    address: data.road_address || data.parcel_address || '',
                                    latitude: data.lat,
                                    longitude: data.lng,
                                    distance: 0,
                                });
                            }
                        });
                    }
                });
            } catch (_) {}

            // 앱 시작 시 스케줄 복원
            restoreScheduledNotifications();

            return () => { subscription?.remove(); };
        }
    }, []);

    const [isMapLoading, setIsMapLoading] = useState(false);
    const [loadingMessage, setLoadingMessage] = useState('');

    // 대문(스플래시) 화면 상태
    const [splashVisible, setSplashVisible] = useState(true);
    const [splashRendered, setSplashRendered] = useState(true);
    const [splashProgress, setSplashProgress] = useState(0);
    const [splashStage, setSplashStage] = useState('지도를 준비하고 있어요');
    const splashIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // 앱 시작 시 진행률 자동 증가 (SDK 로딩 전까지 0→35%)
    useEffect(() => {
        splashIntervalRef.current = setInterval(() => {
            setSplashProgress(prev => {
                if (prev >= 35) { clearInterval(splashIntervalRef.current!); return 35; }
                return prev + 1.5;
            });
        }, 60);
        return () => { if (splashIntervalRef.current) clearInterval(splashIntervalRef.current); };
    }, []);

    const splashDoneRef = useRef(false);
    const handleMapLoadProgress = useCallback((stage: 'sdkLoaded' | 'mapReady') => {
        if (splashDoneRef.current) return;
        if (stage === 'sdkLoaded') {
            clearInterval(splashIntervalRef.current!);
            setSplashStage('내 위치를 확인하고 있어요');
            // 35→80% 구간 자동 증가
            splashIntervalRef.current = setInterval(() => {
                setSplashProgress(prev => {
                    if (prev >= 80) { clearInterval(splashIntervalRef.current!); return 80; }
                    return prev + 1.2;
                });
            }, 60);
        } else if (stage === 'mapReady') {
            clearInterval(splashIntervalRef.current!);
            setSplashStage('건물 정보를 불러오고 있어요');
            setSplashProgress(100);
            splashDoneRef.current = true;
            setTimeout(() => setSplashVisible(false), 500);
        }
    }, []);

    // 하단 토스트 (예: 영업 기록 저장 완료)
    const [toastMessage, setToastMessage] = useState<string | null>(null);
    const showToast = useCallback((message: string) => setToastMessage(message), []);
    useEffect(() => {
        if (!toastMessage) return;
        const t = setTimeout(() => setToastMessage(null), 1800);
        return () => clearTimeout(t);
    }, [toastMessage]);

    const [registryModalVisible, setRegistryModalVisible] = useState(false);
    const [registryConfirmVisible, setRegistryConfirmVisible] = useState(false);
    const [registryConfirmIsRefresh, setRegistryConfirmIsRefresh] = useState(false);
    const [selectedProperty, setSelectedProperty] = useState<Property | null>(null);
    const [propertyModalVisible, setPropertyModalVisible] = useState(false);
    const [registryRecord, setRegistryRecord] = useState<{ id: string; lat?: number; lng?: number; jibun_address?: string; xml_data?: string; viewed_at?: string } | null>(null);
    const [allRegistryViews, setAllRegistryViews] = useState<Array<{ id: string; lat?: number; lng?: number; jibun_address?: string; xml_data?: string; viewed_at?: string }>>([]);
    const [isFavorite, setIsFavorite] = useState(false);

    // 지역 선택
    const [regionSelectorVisible, setRegionSelectorVisible] = useState(false);
    const [selectedRegionLabel, setSelectedRegionLabel] = useState('경상도');

    // 앱 시작 시 마지막 선택 지역 복원
    useEffect(() => {
        AsyncStorage.getItem(SELECTED_REGION_KEY).then(val => {
            if (val) setSelectedRegionLabel(val);
        }).catch(() => {});
    }, []);

    // 앱 시작 시 영업 대상 유형 필터 복원
    useEffect(() => {
        AsyncStorage.getItem(SALES_TARGET_KEY).then(val => {
            if (val && (val === 'all' || val === 'industrial' || val === 'residential')) {
                setSalesTargetFilter(val as SalesTargetFilter);
            }
        }).catch(() => {});
    }, []);

    // 앱 시작 시 Tilko 잔액 DB에서 불러오기 (백그라운드)
    useEffect(() => {
        fetchTilkoBalanceFromDB().then(bal => {
            if (bal !== null) setTilkoBalance(bal);
        });
    }, []);

    const handleRegionSelect = useCallback((lat: number, lng: number, label: string, zoom: { latitudeDelta: number; longitudeDelta: number }) => {
        const newRegion = { latitude: lat, longitude: lng, ...zoom };
        setRegion(newRegion);
        animateActiveMap(newRegion, 600);
        setSelectedRegionLabel(label);
        AsyncStorage.setItem(SELECTED_REGION_KEY, label).catch(() => {});
    }, [setRegion]);

    // 로드뷰 상태
    const [streetViewVisible, setStreetViewVisible] = useState(false);
    const [isTranslatingAddr, setIsTranslatingAddr] = useState(false);

    // 플로팅 지도 검색
    const [mapSearchText, setMapSearchText] = useState('');
    const [mapSearchResults, setMapSearchResults] = useState<Building[]>([]);
    const [mapSearchLoading, setMapSearchLoading] = useState(false);
    const [mapSearchAttempted, setMapSearchAttempted] = useState(false);

    // 사용자 위치 + heading
    const [userLocation, setUserLocation] = useState<{ latitude: number; longitude: number } | null>(null);
    const [userHeading, setUserHeading] = useState<number | null>(null);
    const lastRecordedPosRef = useRef<{ lat: number; lng: number } | null>(null);

    // 오프라인 감지 + 큐
    const isOnline = useOnlineStatus();
    const [pendingQueueCount, setPendingQueueCount] = useState(0);

    // 오프라인→온라인 복구 시 큐 동기화
    useEffect(() => {
        if (isOnline) {
            syncOfflineQueue().then(synced => {
                if (synced > 0) Alert.alert('동기화 완료', `오프라인 중 ${synced}건이 동기화되었습니다.`);
            });
        }
        AsyncStorage.getItem(OFFLINE_QUEUE_KEY).then(json => {
            if (json) setPendingQueueCount((JSON.parse(json) as OfflineQueueItem[]).length);
        });
    }, [isOnline]);

    // registry_views 전체 캐시 로드 (앱 시작 시 1회)
    const loadAllRegistryViews = useCallback(async () => {
        try {
            const { data } = await supabase
                .from('registry_views')
                .select('id, lat, lng, jibun_address, xml_data, viewed_at')
                .order('viewed_at', { ascending: false });
            setAllRegistryViews(data || []);
        } catch {
            // 로드 실패 시 빈 배열 유지
        }
    }, []);

    useEffect(() => {
        loadAllRegistryViews();
    }, [loadAllRegistryViews]);

    // 클러스터링: 줌 레벨 임계치
    useEffect(() => {
        setClusteringEnabled(region.latitudeDelta > 0.008);
    }, [region.latitudeDelta]);

    // 필터링된 Supabase 매물 (면적/고잠재력)
    const filteredPropertyMarkers = useMemo(() => {
        return propertyMarkers.filter(p => {
            // 영업 대상 유형 필터 (전체/공단/민간주택)
            if (salesTargetFilter !== 'all') {
                const inferred = inferTargetType(p);
                if (inferred !== salesTargetFilter) return false;
            }
            // 면적 / 고잠재력 필터
            if (buildingFilter.minArea > 0 && (p.area === null || p.area < buildingFilter.minArea)) return false;
            if (buildingFilter.onlyHighPotential) {
                if (!p.area || p.area < SOLAR_MIN_AREA_MEDIUM) return false;
                const purposeOk = ['공장', '창고', '물류'].some(k => (p.purpose || '').includes(k));
                if (!purposeOk) return false;
            }
            return true;
        });
    }, [propertyMarkers, buildingFilter, salesTargetFilter]);

    // 클러스터 계산
    const propertyClusters = useMemo(() => {
        if (!clusteringEnabled) return null;
        return clusterProperties(filteredPropertyMarkers, region.latitudeDelta);
    }, [filteredPropertyMarkers, clusteringEnabled, region.latitudeDelta]);

    // Supabase 매물 쿼리 (위치 기반) - toFixed(2)로 더 넓은 범위에서 캐시 활용
    const regionKey = `${region.latitude.toFixed(2)},${region.longitude.toFixed(2)}`;
    const { data: properties, refetch: refetchProperties } = useQuery({
        queryKey: ['properties', regionKey],
        queryFn: () => fetchPropertiesFromDB(region.latitude, region.longitude),
        staleTime: 2 * 60 * 1000, // 2분간 stale 방지
    });

    useEffect(() => {
        if (properties) setPropertyMarkers(properties);
    }, [properties]);

    // 화면 19: 위치 권한 사전 설명 화면 (스플래시 직후 1회만 노출)
    const [showLocationIntro, setShowLocationIntro] = useState(false);
    const [locationIntroChecked, setLocationIntroChecked] = useState(false);
    useEffect(() => {
        AsyncStorage.getItem(LOCATION_INTRO_SEEN_KEY).then(val => {
            if (!val) setShowLocationIntro(true);
            setLocationIntroChecked(true);
        }).catch(() => setLocationIntroChecked(true));
    }, []);

    const requestAndCenterOnLocation = useCallback(async () => {
        try {
            const { status } = await Location.requestForegroundPermissionsAsync();
            if (status !== 'granted') return;

            // 1단계: 캐시된 마지막 위치로 즉시 이동 (빠름)
            const last = await Location.getLastKnownPositionAsync({});
            if (last) {
                const coords = { latitude: last.coords.latitude, longitude: last.coords.longitude };
                setUserLocation(coords);
                setRegion({ ...coords, latitudeDelta: 0.002, longitudeDelta: 0.002 });
                setTimeout(() => animateActiveMap({ ...coords, latitudeDelta: 0.002, longitudeDelta: 0.002 }), 300);
            }

            // 2단계: 정확한 현재 위치로 업데이트
            const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
            const coords = { latitude: location.coords.latitude, longitude: location.coords.longitude };
            setUserLocation(coords);
            setRegion({ ...coords, latitudeDelta: 0.002, longitudeDelta: 0.002 });
            setTimeout(() => animateActiveMap({ ...coords, latitudeDelta: 0.002, longitudeDelta: 0.002 }), 300);
        } catch (error) {
            console.log("Location error:", error);
        }
    }, [animateActiveMap]);

    const handleAllowLocationFromIntro = useCallback(async () => {
        await AsyncStorage.setItem(LOCATION_INTRO_SEEN_KEY, '1').catch(() => {});
        setShowLocationIntro(false);
        requestAndCenterOnLocation();
    }, [requestAndCenterOnLocation]);

    const handleSkipLocationIntro = useCallback(async () => {
        await AsyncStorage.setItem(LOCATION_INTRO_SEEN_KEY, '1').catch(() => {});
        setShowLocationIntro(false);
    }, []);

    // 앱 시작 시 위치 권한 요청 및 현재 위치 설정 (안내 화면을 이미 지나온 뒤에만 자동 진행)
    useEffect(() => {
        if (!locationIntroChecked || showLocationIntro) return;
        requestAndCenterOnLocation();
    }, [locationIntroChecked, showLocationIntro]);

    useEffect(() => {
        if (currentTab === 'map') {
            setTimeout(() => animateActiveMap(region, 500), 100);
        }
    }, [currentTab, region]);

    // GPS 와처: 위치 추적 + 영업 동선 기록
    useEffect(() => {
        let sub: Location.LocationSubscription | null = null;
        (async () => {
            try {
                const { status } = await Location.requestForegroundPermissionsAsync();
                if (status !== 'granted') return;
                sub = await Location.watchPositionAsync(
                    { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 10 },
                    (loc) => {
                        const { latitude: lat, longitude: lng } = loc.coords;
                        setUserLocation({ latitude: lat, longitude: lng });
                        if (!lastRecordedPosRef.current ||
                            haversineDistance(lastRecordedPosRef.current.lat, lastRecordedPosRef.current.lng, lat, lng) >= 150) {
                            lastRecordedPosRef.current = { lat, lng };
                            recordGPSVisit(lat, lng);
                        }
                    }
                );
            } catch (_) {}
        })();
        return () => { sub?.remove(); };
    }, []);

    // 나침반 와처: 정지 상태에서도 방향 실시간 갱신
    const compassRotation = useRef(new Animated.Value(0)).current;
    const compassCurrentRef = useRef(0);
    // 로우패스 필터용: 센서 노이즈 제거
    const smoothedHeadingRef = useRef<number | null>(null);
    useEffect(() => {
        let headingSub: Location.LocationSubscription | null = null;
        (async () => {
            try {
                const { status } = await Location.requestForegroundPermissionsAsync();
                if (status !== 'granted') return;
                headingSub = await Location.watchHeadingAsync((hdg) => {
                    const h = hdg.trueHeading >= 0 ? hdg.trueHeading : hdg.magHeading;
                    if (h < 0) return;

                    // 로우패스 필터: 센서 노이즈를 smoothing (alpha=0.2, 낮을수록 부드러움)
                    let smoothed: number;
                    if (smoothedHeadingRef.current === null) {
                        smoothed = h;
                    } else {
                        let diff = h - smoothedHeadingRef.current;
                        if (diff > 180) diff -= 360;
                        if (diff < -180) diff += 360;
                        // 데드존: 2° 미만 변화는 무시 (미세 떨림 방지)
                        if (Math.abs(diff) < 2) return;
                        smoothed = smoothedHeadingRef.current + 0.2 * diff;
                        smoothed = ((smoothed % 360) + 360) % 360;
                    }
                    smoothedHeadingRef.current = smoothed;
                    setUserHeading(smoothed);

                    // 플로팅 나침반: 부드러운 최단경로 타이밍 회전
                    const target = -smoothed;
                    let rotDiff = target - compassCurrentRef.current;
                    if (rotDiff > 180) rotDiff -= 360;
                    if (rotDiff < -180) rotDiff += 360;
                    const next = compassCurrentRef.current + rotDiff;
                    compassCurrentRef.current = next;
                    Animated.timing(compassRotation, {
                        toValue: next,
                        duration: 350,
                        easing: Easing.out(Easing.quad),
                        useNativeDriver: true,
                    }).start();
                });
            } catch (_) {}
        })();
        return () => { headingSub?.remove(); };
    }, []);

    // 로컬 캐시에서 lat/lng 범위로 등기 기록 조회 (DB 호출 없음)
    const checkAndSetRegistryRecord = useCallback((lat: number, lng: number) => {
        const delta = 0.001;
        const match = allRegistryViews.find(r =>
            r.lat != null && r.lng != null &&
            Math.abs(r.lat - lat) <= delta &&
            Math.abs(r.lng - lng) <= delta
        );
        setRegistryRecord(match ?? null);
    }, [allRegistryViews]);

    const checkIsFavorite = async (id: string) => {
        try {
            const jsonValue = await AsyncStorage.getItem(FAVORITE_PLACES_KEY);
            const places: Building[] = jsonValue ? JSON.parse(jsonValue) : [];
            setIsFavorite(places.some(p => p.id === id));
        } catch (_) {
            setIsFavorite(false);
        }
    };

    const handleToggleFavorite = async () => {
        if (!selectedMarker) return;
        try {
            const jsonValue = await AsyncStorage.getItem(FAVORITE_PLACES_KEY);
            let places: Building[] = jsonValue ? JSON.parse(jsonValue) : [];
            if (isFavorite) {
                places = places.filter(p => p.id !== selectedMarker.id);
                setIsFavorite(false);
            } else {
                places.unshift({ ...selectedMarker, timestamp: Date.now() });
                setIsFavorite(true);
                await addNotification('favorite', `즐겨찾기 추가: ${selectedMarker.name || selectedMarker.address}`);
            }
            await AsyncStorage.setItem(FAVORITE_PLACES_KEY, JSON.stringify(places));
        } catch (e) {
            console.error('Failed to toggle favorite', e);
        }
    };

    useEffect(() => {
        if (selectedMarker) {
            checkAndSetRegistryRecord(selectedMarker.latitude, selectedMarker.longitude);
            checkIsFavorite(selectedMarker.id);
        } else {
            setRegistryRecord(null);
            setIsFavorite(false);
        }
    }, [selectedMarker, checkAndSetRegistryRecord]);

    // 화면 02: 지적도 기준 부지 면적 (캐시 우선, 없으면 조회)
    const [parcelAreaLoading, setParcelAreaLoading] = useState(false);
    const parcelAreaKey = selectedMarker ? `${selectedMarker.latitude.toFixed(6)},${selectedMarker.longitude.toFixed(6)}` : null;
    const parcelArea = parcelAreaKey ? parcelAreas[parcelAreaKey] : null;
    useEffect(() => {
        if (!selectedMarker || !parcelAreaKey || parcelAreas[parcelAreaKey]) return;
        let cancelled = false;
        setParcelAreaLoading(true);
        fetchParcelArea(selectedMarker.latitude, selectedMarker.longitude).then(result => {
            if (cancelled) return;
            if (result) setParcelArea(parcelAreaKey, result.landAreaM2);
        }).finally(() => { if (!cancelled) setParcelAreaLoading(false); });
        return () => { cancelled = true; };
    }, [parcelAreaKey]);

    // 화면 01: 바텀시트 1단(peek)에 표시할 "내 장소" 총 건수
    const [myPlacesCount, setMyPlacesCount] = useState<number | null>(null);
    useEffect(() => {
        supabase.from('places').select('id', { count: 'exact', head: true }).then(({ count }) => setMyPlacesCount(count ?? 0));
    }, []);

    // 화면 02: 최근 기록 (장소관리 상태) — 좌표 근방(100m) 매칭
    const [nearbyPlaceRecord, setNearbyPlaceRecord] = useState<PlaceRecord | null>(null);
    useEffect(() => {
        if (!selectedMarker) { setNearbyPlaceRecord(null); return; }
        let cancelled = false;
        const delta = 0.001;
        supabase.from('places').select('*')
            .gte('lat', selectedMarker.latitude - delta).lte('lat', selectedMarker.latitude + delta)
            .gte('lng', selectedMarker.longitude - delta).lte('lng', selectedMarker.longitude + delta)
            .limit(1)
            .then(({ data }) => { if (!cancelled) setNearbyPlaceRecord((data && data[0]) || null); });
        return () => { cancelled = true; };
    }, [selectedMarker]);

    // 마커 변경 시 장소관리 모달 닫기
    useEffect(() => {
        setPlaceManagementVisible(false);
    }, [selectedMarker]);

    const handleGpsPress = useCallback(() => {
        Alert.alert(
            "현재 위치로 이동",
            "현재 위치로 지도를 이동하시겠습니까?",
            [
                { text: "취소", style: "cancel" },
                {
                    text: "확인",
                    onPress: async () => {
                        try {
                            const { status } = await Location.requestForegroundPermissionsAsync();
                            if (status !== 'granted') return;
                            setLoadingMessage("현재 위치를 찾는 중입니다...");
                            setIsMapLoading(true);
                            const currentLocation = await Location.getCurrentPositionAsync({});
                            const newRegion = {
                                latitude: currentLocation.coords.latitude,
                                longitude: currentLocation.coords.longitude,
                                latitudeDelta: 0.002,
                                longitudeDelta: 0.002,
                            };
                            setUserLocation({ latitude: currentLocation.coords.latitude, longitude: currentLocation.coords.longitude });
                            setTimeout(() => {
                                setRegion(newRegion);
                                setSelectedMarker(null);
                                animateActiveMap(newRegion, 1000);
                                setIsMapLoading(false);
                            }, 1000);
                        } catch (error) {
                            setIsMapLoading(false);
                            Alert.alert("오류", "위치 정보를 가져올 수 없습니다.");
                        }
                    },
                },
            ]
        );
    }, [animateActiveMap]);

    // 이미 조회한 등기를 유료로 다시(최신) 조회 — 화면 03 확인 시트의 "다시 열람" 확정 액션
    const performRegistryRefresh = async () => {
        if (!selectedMarker) return;
        setLoadingMessage("등기부등본 갱신 중...");
        setIsMapLoading(true);
        try {
            const pnuResult = await fetchPNU(selectedMarker.latitude, selectedMarker.longitude);
            const uniqueNoList = await fetchUniqueNoByAddress(pnuResult.jibunAddr);
            const normalItems = uniqueNoList.filter(i => i.uniqueNo && !i.isSpecial);
            const validItem = normalItems.find(i => i.realtyType === '집합건물')
                || normalItems.find(i => i.realtyType === '건물')
                || normalItems[0]
                || uniqueNoList.find(i => i.uniqueNo)
                || uniqueNoList[0];
            if (!validItem?.uniqueNo) throw new Error('유효한 부동산 고유번호를 찾을 수 없습니다.');
            const info = await fetchRegistryInfo(validItem.uniqueNo);
            if (info.pointBalance !== null) {
                useMapStore.getState().setTilkoBalance(info.pointBalance);
                updateTilkoBalanceInDB(info.pointBalance, 'post_registry').catch(() => {});
            }
            await saveRegistryCache(selectedMarker.latitude, selectedMarker.longitude, {
                pnu: pnuResult.pnu,
                jibunAddr: pnuResult.jibunAddr,
                uniqueNo: validItem.uniqueNo,
                owner: info.owner,
                address: info.address,
                cachedAt: Date.now(),
            });
            if (registryRecord?.id) {
                await supabase.from('registry_views').update({
                    owner_name: info.owner !== '정보 없음' ? info.owner : null,
                    owner_address: info.address !== '정보 없음' ? info.address : null,
                    xml_data: info.xmlData || null,
                    viewed_at: new Date().toISOString(),
                }).eq('id', registryRecord.id);
            } else {
                await saveIROSView({
                    lat: selectedMarker.latitude,
                    lng: selectedMarker.longitude,
                    road_address: selectedMarker.address || '',
                    jibun_address: pnuResult.jibunAddr,
                    owner_name: info.owner !== '정보 없음' ? info.owner : undefined,
                    owner_address: info.address !== '정보 없음' ? info.address : undefined,
                    xml_data: info.xmlData || undefined,
                });
            }
            // 캐시 갱신 후 로컬 재조회
            await loadAllRegistryViews();
            checkAndSetRegistryRecord(selectedMarker.latitude, selectedMarker.longitude);
            setRegistryModalVisible(true);
        } catch (e: any) {
            const msg: string = e.message || '갱신 중 오류가 발생했습니다.';
            Alert.alert(
                msg.startsWith('[잔액부족]') ? '💳 잔액 부족' : '오류',
                msg.replace('[잔액부족] ', ''),
            );
        } finally {
            setIsMapLoading(false);
            setLoadingMessage('');
        }
    };

    // 화면 02 주 액션(등본조회) — 이미 조회했거나 24시간 내 캐시가 있으면 확인 시트를 건너뛰고 바로 표시
    const handleRegistryPrimaryPress = async () => {
        if (!selectedMarker) return;
        if (registryRecord) {
            setRegistryModalVisible(true);
            return;
        }
        const cached = await getRegistryCache(selectedMarker.latitude, selectedMarker.longitude);
        if (cached) {
            setRegistryModalVisible(true);
            return;
        }
        setRegistryConfirmIsRefresh(false);
        setRegistryConfirmVisible(true);
    };

    // 이미 조회한 주소를 유료로 다시 열람 ("· 다시 열람 1P" 링크)
    const handleRegistryRefreshLinkPress = () => {
        setRegistryConfirmIsRefresh(true);
        setRegistryConfirmVisible(true);
    };

    const handleRegistryConfirm = () => {
        setRegistryConfirmVisible(false);
        if (registryConfirmIsRefresh) {
            performRegistryRefresh();
        } else {
            setRegistryModalVisible(true);
        }
    };

    const changeMapType = useCallback((type: MapType) => {
        if (mapType === type) return;
        const msg = type === 'cadastral' ? "지적도를 호출중입니다..."
            : type === 'satellite' ? "위성지도를 호출중입니다..."
            : "일반지도를 호출중입니다...";
        setLoadingMessage(msg);
        setIsMapLoading(true);
        setTimeout(() => { setMapType(type); setIsMapLoading(false); }, 1500);
    }, [mapType]);

    const handleMapPress = useCallback(async (coordinate: { latitude: number; longitude: number }) => {
        try {
            const address = await reverseGeocodeKorean(coordinate.latitude, coordinate.longitude);
            const building: Building = {
                id: `marker-${Date.now()}`,
                name: address !== "주소 정보 없음" ? address : "선택된 위치",
                address,
                distance: 0,
                latitude: coordinate.latitude,
                longitude: coordinate.longitude,
            };
            setSelectedMarker(building);
            saveRecentPlace(building);
        } catch (error) {
            console.log("Reverse geocoding error", error);
        }
    }, []);

    const handleMapSearch = useCallback(async () => {
        const q = mapSearchText.trim();
        if (!q) return;
        setMapSearchLoading(true);
        setMapSearchAttempted(true);
        try {
            const url = `https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=8&page=1&query=${encodeURIComponent(q)}&type=place&format=json&errorformat=json&key=${VWORLD_API_KEY}`;
            const res = await fetch(url);
            const json = await res.json();
            if (json.response?.status === 'OK' && json.response?.result?.items) {
                setMapSearchResults(json.response.result.items.map((item: VWorldPlaceItem) => ({
                    id: item.id,
                    name: item.title,
                    address: item.address?.road || item.address?.parcel || '',
                    distance: 0,
                    latitude: parseFloat(item.point.y),
                    longitude: parseFloat(item.point.x),
                })));
            } else {
                setMapSearchResults([]);
            }
        } catch { setMapSearchResults([]); }
        setMapSearchLoading(false);
    }, [mapSearchText]);

    const handleSelectMapSearchResult = useCallback((item: Building) => {
        setSelectedMarker(item);
        const newRegion = { latitude: item.latitude, longitude: item.longitude, latitudeDelta: 0.003, longitudeDelta: 0.003 };
        setRegion(newRegion);
        animateActiveMap(newRegion, 500);
        saveRecentPlace(item);
        setMapSearchText('');
        setMapSearchResults([]);
        setMapSearchAttempted(false);
    }, [animateActiveMap, saveRecentPlace, setRegion, setSelectedMarker]);

    const handlePropertyMarkerPress = useCallback((prop: Property) => {
        setSelectedProperty(prop);
        setPropertyModalVisible(true);
    }, []);

    const handleMarkerPress = useCallback((markerId: string, markerType: string) => {
        if (markerType === 'property') {
            const propId = markerId.replace('prop-', '');
            const prop = propertyMarkers.find(p => String(p.property_id) === propId);
            if (prop) handlePropertyMarkerPress(prop);
        } else if (markerType === 'cluster') {
            const clusterId = markerId.replace('cluster-', '');
            const cluster = propertyClusters?.find(c => c.id === clusterId);
            if (cluster) {
                animateActiveMap({
                    latitude: cluster.coordinate.latitude,
                    longitude: cluster.coordinate.longitude,
                    latitudeDelta: region.latitudeDelta / 3,
                    longitudeDelta: region.longitudeDelta / 3,
                }, 400);
            }
        }
    }, [propertyMarkers, propertyClusters, region]);

    // 항공뷰용 마커 (subtitle 포함)
    const skyMarkersForMap = useMemo(() => {
        const items: import('./KakaoSkyView').SkyMarkerItem[] = [];
        if (clusteringEnabled && propertyClusters) {
            propertyClusters.forEach(cluster => {
                if (cluster.count === 1) {
                    const prop = cluster.items[0];
                    items.push({
                        id: `prop-${prop.property_id}`,
                        latitude: prop.lat,
                        longitude: prop.lng,
                        type: 'property',
                        color: SALES_STATUS_COLORS[prop.sales_status] || '#9E9E9E',
                        title: prop.building_name || prop.road_address || '매물',
                        subtitle: prop.road_address || '',
                    });
                } else {
                    items.push({
                        id: `cluster-${cluster.id}`,
                        latitude: cluster.coordinate.latitude,
                        longitude: cluster.coordinate.longitude,
                        type: 'cluster',
                        count: cluster.count,
                        color: SALES_STATUS_COLORS[cluster.dominantStatus] || '#9E9E9E',
                    });
                }
            });
        } else {
            filteredPropertyMarkers.forEach(prop => {
                items.push({
                    id: `prop-${prop.property_id}`,
                    latitude: prop.lat,
                    longitude: prop.lng,
                    type: 'property',
                    color: SALES_STATUS_COLORS[prop.sales_status] || '#9E9E9E',
                    title: prop.building_name || prop.road_address || '매물',
                    subtitle: prop.road_address || '',
                });
            });
        }
        return items;
    }, [filteredPropertyMarkers, propertyClusters, clusteringEnabled]);

    const allMarkersForMap = useMemo(() => {
        const items: import('./GoogleMapView').MapMarkerItem[] = [];
        if (clusteringEnabled && propertyClusters) {
            propertyClusters.forEach(cluster => {
                if (cluster.count === 1) {
                    const prop = cluster.items[0];
                    items.push({
                        id: `prop-${prop.property_id}`,
                        latitude: prop.lat,
                        longitude: prop.lng,
                        type: 'property',
                        color: SALES_STATUS_COLORS[prop.sales_status] || '#9E9E9E',
                        title: prop.building_name || prop.road_address || '매물',
                    });
                } else {
                    items.push({
                        id: `cluster-${cluster.id}`,
                        latitude: cluster.coordinate.latitude,
                        longitude: cluster.coordinate.longitude,
                        type: 'cluster',
                        count: cluster.count,
                        color: SALES_STATUS_COLORS[cluster.dominantStatus] || '#9E9E9E',
                    });
                }
            });
        } else {
            filteredPropertyMarkers.forEach(prop => {
                items.push({
                    id: `prop-${prop.property_id}`,
                    latitude: prop.lat,
                    longitude: prop.lng,
                    type: 'property',
                    color: SALES_STATUS_COLORS[prop.sales_status] || '#9E9E9E',
                    title: prop.building_name || prop.road_address || '매물',
                });
            });
        }
        return items;
    }, [filteredPropertyMarkers, propertyClusters, clusteringEnabled]);

    const renderContent = () => {
        switch (currentTab) {
            case 'placeSearch':
                return (
                    <PlaceSearchScreen
                        onBack={() => setCurrentTab('map')}
                        onMoveToMap={() => setCurrentTab('map')}
                        onSelectRegion={() => setCurrentTab('regionSelect')}
                    />
                );
            case 'regionSelect':
                return (
                    <RegionSelectScreen
                        onBack={() => setCurrentTab('placeSearch')}
                        onComplete={(province, city, lat, lng, zoom) => {
                            const latDelta = zoom ?? 0.08;
                            const newRegion = { latitude: lat, longitude: lng, latitudeDelta: latDelta, longitudeDelta: latDelta };
                            setRegion(newRegion);
                            animateActiveMap(newRegion, 600);
                            const shortName = DEFAULT_PROVINCES.find(p => p.name === province)?.short || province;
                            setSelectedRegionLabel(`${shortName} ${city}`);
                            AsyncStorage.setItem(SELECTED_REGION_KEY, `${shortName} ${city}`).catch(() => {});
                            setCurrentTab('map');
                        }}
                    />
                );
            case 'buildings':
                return (
                    <View style={styles.subScreenContainer}>
                        <View style={styles.subScreenHeader}>
                            <TouchableOpacity onPress={() => setCurrentTab('map')} style={styles.backButton} accessibilityLabel="뒤로 가기" accessibilityRole="button">
                                <Text style={[styles.backButtonText, { fontSize: fs.lg }]}>{'< 뒤로'}</Text>
                            </TouchableOpacity>
                            <Text style={[styles.subScreenTitle, { fontSize: fs['2xl'] }]}>주변 건물</Text>
                            <View style={{ width: 50 }} />
                        </View>
                        <BuildingListScreen onMoveToMap={() => setCurrentTab('map')} />
                    </View>
                );
            case 'places':
                return (
                    <PlaceManagementListScreen
                        onBack={() => setCurrentTab('map')}
                        onMoveToMap={(lat, lng, address) => {
                            setRegion({ latitude: lat, longitude: lng, latitudeDelta: 0.002, longitudeDelta: 0.002 });
                            setSelectedMarker({ id: `place-${Date.now()}`, name: address || '장소관리 장소', address: address || '', latitude: lat, longitude: lng, distance: 0 });
                            setCurrentTab('map');
                        }}
                    />
                );
            case 'map':
                return (
                    <View style={styles.mapContainer}>
                        {mapType === 'satellite' ? (
                            <KakaoSkyView
                                ref={kakaoSkyRef}
                                style={styles.map}
                                vworldApiKey={VWORLD_API_KEY}
                                initialRegion={region}
                                onRegionChangeComplete={(r) => setRegion(r)}
                                onPress={handleMapPress}
                                onMarkerPress={handleMarkerPress}
                                selectedMarker={selectedMarker ? {
                                    latitude: selectedMarker.latitude,
                                    longitude: selectedMarker.longitude,
                                    title: selectedMarker.name,
                                    subtitle: selectedMarker.address,
                                } : null}
                                markers={skyMarkersForMap}
                                userLocation={userLocation}
                                heading={userHeading}
                                onLoadProgress={handleMapLoadProgress}
                            />
                        ) : (
                            <GoogleMapView
                                ref={mapRef}
                                style={styles.map}
                                vworldApiKey={VWORLD_API_KEY}
                                initialRegion={region}
                                onRegionChangeComplete={(r) => setRegion(r)}
                                onPress={handleMapPress}
                                onMarkerPress={handleMarkerPress}
                                mapType={mapType}
                                selectedMarker={selectedMarker}
                                markers={allMarkersForMap}
                                userLocation={userLocation}
                                heading={userHeading}
                                onLoadProgress={handleMapLoadProgress}
                            />
                        )}

                        <RegionSelectorModal
                            visible={regionSelectorVisible}
                            onClose={() => setRegionSelectorVisible(false)}
                            onSelect={handleRegionSelect}
                            currentLabel={selectedRegionLabel}
                        />

                        {/* 검색바 (지도 상단 고정) */}
                        <View style={styles.mapSearchBar}>
                            {/* 돋보기 아이콘 (이모지·아이콘 라이브러리 없이 도형으로 구성) */}
                            <View style={{ width: 18, height: 18, marginRight: SPACING.base }}>
                                <View style={{ position: 'absolute', top: 0, left: 0, width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: COLORS.textMuted }} />
                                <View style={{ position: 'absolute', bottom: 0, right: 0, width: 2, height: 7, borderRadius: 1, backgroundColor: COLORS.textMuted, transform: [{ rotate: '45deg' }] }} />
                            </View>
                            <TextInput
                                style={{ flex: 1, fontSize: fs.base, color: COLORS.ink, padding: 0 }}
                                placeholder="주소 · 건물명으로 찾기"
                                placeholderTextColor={COLORS.textMuted}
                                value={mapSearchText}
                                onChangeText={(t) => { setMapSearchText(t); setMapSearchAttempted(false); }}
                                onSubmitEditing={handleMapSearch}
                                returnKeyType="search"
                                accessibilityLabel="주소 · 건물명으로 찾기"
                            />
                            {mapSearchLoading && <ActivityIndicator size="small" color={COLORS.primary} style={{ marginLeft: SPACING.sm }} />}
                            {!mapSearchLoading && mapSearchText.length > 0 && (
                                <TouchableOpacity
                                    onPress={() => { setMapSearchText(''); setMapSearchResults([]); setMapSearchAttempted(false); }}
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                    accessibilityLabel="검색어 지우기"
                                    accessibilityRole="button"
                                >
                                    <Text style={{ fontSize: 16, color: COLORS.chevron, fontWeight: '700' }}>{'×'}</Text>
                                </TouchableOpacity>
                            )}
                            <TouchableOpacity
                                onPress={() => setCurrentTab('placeSearch')}
                                style={{ marginLeft: SPACING.base, paddingLeft: SPACING.base, borderLeftWidth: 1, borderLeftColor: COLORS.line }}
                                accessibilityLabel="주소검색 · 지역으로 찾기"
                                accessibilityRole="button"
                            >
                                <Text style={{ fontSize: fs.sm, color: COLORS.primary, fontWeight: '700' }}>주소</Text>
                            </TouchableOpacity>
                        </View>

                        {/* 검색 결과 드롭다운 */}
                        {mapSearchText.length > 0 && !mapSearchLoading && mapSearchResults.length > 0 && (
                            <View style={styles.mapSearchResults}>
                                <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 4 * 56 }}>
                                    {mapSearchResults.map((item, idx) => (
                                        <TouchableOpacity
                                            key={item.id}
                                            onPress={() => handleSelectMapSearchResult(item)}
                                            style={{ paddingHorizontal: SPACING.xl2, paddingVertical: SPACING.lg, borderTopWidth: idx === 0 ? 0 : 1, borderTopColor: COLORS.lineSoft2 }}
                                            accessibilityLabel={`${item.name} 선택`}
                                            accessibilityRole="button"
                                        >
                                            <Text style={{ fontSize: fs.base, fontWeight: '700', color: COLORS.ink }} numberOfLines={1}>{item.name}</Text>
                                            <Text style={{ fontSize: fs.sm, color: COLORS.textMuted, marginTop: 2 }} numberOfLines={1}>{item.address}</Text>
                                        </TouchableOpacity>
                                    ))}
                                </ScrollView>
                            </View>
                        )}
                        {mapSearchAttempted && mapSearchText.trim().length > 0 && !mapSearchLoading && mapSearchResults.length === 0 && (
                            <View style={styles.mapSearchResults}>
                                <Text style={{ padding: SPACING.xl2, fontSize: fs.base, color: COLORS.textMuted }}>검색 결과가 없습니다.</Text>
                            </View>
                        )}

                        {/* 지도 타입 pill */}
                        <View style={styles.mapTypeWrapper}>
                            {([
                                { id: 'standard' as MapType, label: '일반', a11y: '일반 지도로 전환' },
                                { id: 'cadastral' as MapType, label: '지적도', a11y: '지적도로 전환' },
                                { id: 'satellite' as MapType, label: '항공', a11y: '항공뷰로 전환' },
                            ]).map(item => {
                                const active = mapType === item.id;
                                return (
                                    <TouchableOpacity
                                        key={item.id}
                                        style={[
                                            styles.tabButton,
                                            elderlyMode && { paddingVertical: 13, paddingHorizontal: 20 },
                                            active && styles.activeTabButton,
                                        ]}
                                        onPress={() => changeMapType(item.id)}
                                        accessibilityLabel={item.a11y}
                                        accessibilityRole="button"
                                        accessibilityState={{ selected: active }}
                                    >
                                        <Text style={[styles.tabButtonText, { fontSize: fs.md }, active && styles.activeTabButtonText]}>{item.label}</Text>
                                    </TouchableOpacity>
                                );
                            })}
                        </View>


                        {/* 등기 잔액 뱃지 */}
                        {tilkoBalance !== null && (
                            <TouchableOpacity
                                onPress={() => fetchTilkoBalanceFromDB().then(bal => { if (bal !== null) setTilkoBalance(bal); })}
                                style={{
                                    position: 'absolute', bottom: elderlyMode ? 168 : 160, right: 12, zIndex: 20,
                                    backgroundColor: tilkoBalance < 5 ? '#DC2626' : '#18181B',
                                    borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5,
                                    flexDirection: 'row', alignItems: 'center', gap: 4,
                                    elevation: 5, shadowColor: '#000', shadowOpacity: 0.2, shadowOffset: { width: 0, height: 2 }, shadowRadius: 4,
                                }}
                                accessibilityLabel={`틸코 잔액 ${tilkoBalance}포인트. 탭하여 새로고침`}
                            >
                                <Text style={{ fontSize: 10, color: '#A1A1AA' }}>잔액</Text>
                                <Text style={{ fontSize: 13, fontWeight: '700', color: tilkoBalance < 5 ? '#FEF2F2' : '#FAFAFA' }}>
                                    {tilkoBalance.toLocaleString()}P
                                </Text>
                                {tilkoBalance < 5 && (
                                    <Text style={{ fontSize: 10, color: '#FCA5A5' }}>⚠</Text>
                                )}
                            </TouchableOpacity>
                        )}

                        {/* 나침반 (GPS 반대편 좌측) */}
                        {(() => {
                            const innerSize = elderlyMode ? 30 : 26;
                            const fN = elderlyMode ? 11 : 9;   // 북 글자
                            const fDir = elderlyMode ? 9 : 8; // 남동서 글자
                            const dotSize = elderlyMode ? 6 : 5;
                            return (
                                <View style={[styles.gpsButton, { left: 16, right: undefined, bottom: elderlyMode ? 312 : 300 }]}>
                                    <Animated.View style={{
                                        width: innerSize, height: innerSize,
                                        alignItems: 'center', justifyContent: 'center',
                                        transform: [{ rotate: compassRotation.interpolate({ inputRange: [-7200, 7200], outputRange: ['-7200deg', '7200deg'] }) }],
                                    }}>
                                        {/* 원(나침반 테두리) */}
                                        <View style={{ position: 'absolute', width: innerSize, height: innerSize, borderRadius: innerSize / 2, borderWidth: 1.5, borderColor: COLORS.line }} />
                                        {/* 북 */}
                                        <Text style={{ position: 'absolute', top: -fN, alignSelf: 'center', color: COLORS.dangerStrong, fontSize: fN, fontWeight: '900' }}>북</Text>
                                        {/* 남 */}
                                        <Text style={{ position: 'absolute', bottom: -fDir, alignSelf: 'center', color: COLORS.textMuted, fontSize: fDir, fontWeight: '700' }}>남</Text>
                                        {/* 북쪽 삼각 바늘 */}
                                        <View style={{
                                            position: 'absolute',
                                            top: 2,
                                            alignSelf: 'center',
                                            width: 0, height: 0,
                                            borderLeftWidth: 3,
                                            borderRightWidth: 3,
                                            borderBottomWidth: innerSize / 2 - 3,
                                            borderLeftColor: 'transparent',
                                            borderRightColor: 'transparent',
                                            borderBottomColor: COLORS.dangerStrong,
                                        }} />
                                        {/* 중심 점 */}
                                        <View style={{ width: dotSize, height: dotSize, borderRadius: dotSize / 2, backgroundColor: COLORS.inkSub }} />
                                    </Animated.View>
                                    <Text style={styles.gpsButtonText}>북쪽</Text>
                                </View>
                            );
                        })()}

                        {/* 현재 위치 버튼 */}
                        <TouchableOpacity
                            style={[styles.gpsButton, elderlyMode && { bottom: 312 }]}
                            onPress={handleGpsPress}
                            accessibilityLabel="현재 위치로 이동"
                            accessibilityRole="button"
                        >
                            <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' }}>
                                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.primary }} />
                            </View>
                            <Text style={[styles.gpsButtonText, elderlyMode && { fontSize: 13 }]}>내위치</Text>
                        </TouchableOpacity>

                        {/* 화면 01: 바텀시트 1단 (지역 요약, 마커 미선택 상태) */}
                        {!selectedMarker && (
                            <View style={styles.mapPeekSheet}>
                                <View style={styles.bottomPanelHandle} />
                                <Text style={{ fontSize: fs.base, color: COLORS.textMuted }}>이 지역</Text>
                                <Text style={{ fontSize: fs.xl + 6, fontWeight: '700', color: COLORS.ink, marginTop: 4, marginBottom: SPACING.base }}>
                                    {selectedRegionLabel}
                                </Text>
                                <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
                                    <TouchableOpacity
                                        onPress={() => setCurrentTab('buildings')}
                                        style={{ flex: 1, height: 56, borderRadius: RADIUS.button, backgroundColor: COLORS.primaryTint, alignItems: 'center', justifyContent: 'center' }}
                                        accessibilityLabel="주변 건물 보기"
                                        accessibilityRole="button"
                                    >
                                        <Text style={{ fontSize: fs.base, fontWeight: '700', color: COLORS.primary }}>
                                            주변 건물{filteredPropertyMarkers.length > 0 ? ` ${filteredPropertyMarkers.length}` : ''}
                                        </Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                        onPress={() => setCurrentTab('places')}
                                        style={{ flex: 1, height: 56, borderRadius: RADIUS.button, backgroundColor: COLORS.surface, alignItems: 'center', justifyContent: 'center' }}
                                        accessibilityLabel="내 장소 보기"
                                        accessibilityRole="button"
                                    >
                                        <Text style={{ fontSize: fs.base, fontWeight: '700', color: COLORS.inkSub }}>
                                            내 장소{myPlacesCount !== null ? ` ${myPlacesCount}` : ''}
                                        </Text>
                                    </TouchableOpacity>
                                </View>
                            </View>
                        )}

                        <LoadingOverlay visible={isMapLoading} message={loadingMessage} />

                        {/* 화면 14: 실제 사진 (Google 스트리트뷰) */}
                        {selectedMarker && (
                            <StreetViewModal
                                visible={streetViewVisible}
                                onClose={() => setStreetViewVisible(false)}
                                latitude={selectedMarker.latitude}
                                longitude={selectedMarker.longitude}
                                title={selectedMarker.address}
                                buildingName={selectedMarker.name}
                            />
                        )}

                        {/* 화면 02: 장소 선택 시트 */}
                        {selectedMarker && !propertyModalVisible && (
                            <View style={[styles.bottomPanel, { borderRadius: RADIUS.sheet, padding: 0, paddingTop: SPACING.lg, maxHeight: 520 }]}>
                                <View style={styles.bottomPanelHandle} />
                                <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: SPACING.xl3, paddingBottom: SPACING.xl3 }}>
                                    {/* 제목/주소 + 즐겨찾기 + 닫기 */}
                                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: SPACING.base }}>
                                        <View style={{ flex: 1, paddingRight: SPACING.base }}>
                                            <Text style={{ fontSize: fs.xl + 6, fontWeight: '700', color: COLORS.ink, lineHeight: 32 }} numberOfLines={2} accessibilityRole="text">
                                                {selectedMarker.name || selectedMarker.address}
                                            </Text>
                                            {selectedMarker.name && selectedMarker.name !== selectedMarker.address && (
                                                <Text style={{ fontSize: fs.base, color: COLORS.textMuted, marginTop: 4, lineHeight: 24 }} numberOfLines={2}>
                                                    {selectedMarker.address}
                                                </Text>
                                            )}
                                            {!/[가-힣]/.test(selectedMarker.address) && (
                                                <TouchableOpacity
                                                    onPress={async () => {
                                                        setIsTranslatingAddr(true);
                                                        const koAddr = await reverseGeocodeKorean(selectedMarker.latitude, selectedMarker.longitude);
                                                        if (koAddr && koAddr !== '주소 정보 없음') {
                                                            setSelectedMarker({ ...selectedMarker, address: koAddr, name: koAddr });
                                                        }
                                                        setIsTranslatingAddr(false);
                                                    }}
                                                    disabled={isTranslatingAddr}
                                                    style={{ marginTop: 6, flexDirection: 'row', alignItems: 'center', gap: 4 }}
                                                >
                                                    {isTranslatingAddr
                                                        ? <ActivityIndicator size="small" color={COLORS.primary} />
                                                        : <Text style={{ fontSize: fs.sm, color: COLORS.primary, fontWeight: '600' }}>한글 주소 보기</Text>
                                                    }
                                                </TouchableOpacity>
                                            )}
                                        </View>
                                        <TouchableOpacity
                                            onPress={handleToggleFavorite}
                                            style={{ width: 56, height: 56, borderRadius: RADIUS.button + 2, backgroundColor: COLORS.warnTint, alignItems: 'center', justifyContent: 'center' }}
                                            accessibilityLabel={isFavorite ? '즐겨찾기 해제' : '즐겨찾기 추가'}
                                            accessibilityRole="button"
                                        >
                                            <Text style={{ fontSize: 26, color: isFavorite ? COLORS.warnAccent : COLORS.line }}>{'★'}</Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity
                                            onPress={() => setSelectedMarker(null)}
                                            style={{ marginLeft: 6, width: 32, height: 56, alignItems: 'center', justifyContent: 'center' }}
                                            accessibilityLabel="선택 해제"
                                            accessibilityRole="button"
                                        >
                                            <Text style={{ fontSize: 20, color: COLORS.chevron, fontWeight: '700' }}>{'×'}</Text>
                                        </TouchableOpacity>
                                    </View>

                                    {/* 메타 칩 */}
                                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, marginBottom: SPACING.base }}>
                                        {!!selectedMarker.category && (
                                            <View style={{ backgroundColor: COLORS.primaryTint, borderRadius: RADIUS.chip, paddingHorizontal: SPACING.lg, paddingVertical: SPACING.xs }}>
                                                <Text style={{ fontSize: fs.sm, color: COLORS.primary, fontWeight: '700' }}>{selectedMarker.category}</Text>
                                            </View>
                                        )}
                                        {userLocation && (
                                            <View style={{ backgroundColor: COLORS.surface, borderRadius: RADIUS.chip, paddingHorizontal: SPACING.lg, paddingVertical: SPACING.xs }}>
                                                <Text style={{ fontSize: fs.sm, color: COLORS.inkSub, fontWeight: '700' }}>
                                                    내 위치에서 {formatDistance(haversineDistance(userLocation.latitude, userLocation.longitude, selectedMarker.latitude, selectedMarker.longitude))}
                                                </Text>
                                            </View>
                                        )}
                                    </View>

                                    {/* 면적 카드 (지적도 기준) */}
                                    <View style={{ backgroundColor: COLORS.surface, borderRadius: RADIUS.card, padding: SPACING.xl2, marginBottom: SPACING.base }}>
                                        <Text style={{ fontSize: fs.sm, color: COLORS.textMuted, fontWeight: '500', marginBottom: SPACING.base }}>지적도 기준 면적</Text>
                                        {parcelAreaLoading ? (
                                            <View style={{ paddingVertical: 4 }}><ActivityIndicator size="small" color={COLORS.primary} /></View>
                                        ) : parcelArea ? (
                                            <View style={{ flexDirection: 'row' }}>
                                                <View style={{ flex: 1 }}>
                                                    <Text style={{ fontSize: fs.sm, color: COLORS.textMuted }}>공장 부지</Text>
                                                    <Text style={{ fontSize: fs.xl, fontWeight: '700', color: COLORS.ink, marginTop: 4 }}>{parcelArea.landAreaM2.toLocaleString()}㎡</Text>
                                                    <Text style={{ fontSize: fs.sm, color: COLORS.textMuted, marginTop: 2 }}>{sqmToPyeong(parcelArea.landAreaM2).toLocaleString()}평</Text>
                                                </View>
                                                <View style={{ width: 1, backgroundColor: COLORS.line, marginHorizontal: SPACING.base }} />
                                                <View style={{ flex: 1 }}>
                                                    <Text style={{ fontSize: fs.sm, color: COLORS.textMuted }}>건물 바닥</Text>
                                                    <Text style={{ fontSize: fs.base, color: COLORS.textMuted, marginTop: 4 }}>정보 없음</Text>
                                                </View>
                                            </View>
                                        ) : (
                                            <Text style={{ fontSize: fs.base, color: COLORS.textMuted }}>면적 정보 없음</Text>
                                        )}
                                    </View>

                                    {/* 주 액션: 등기 열람 */}
                                    <TouchableOpacity
                                        onPress={handleRegistryPrimaryPress}
                                        style={{ height: 56, borderRadius: RADIUS.button, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', ...ELEVATION.primaryBtn }}
                                        accessibilityLabel={registryRecord ? '등기 내용 보기' : '등기 열람하기'}
                                        accessibilityRole="button"
                                    >
                                        <Text style={{ fontSize: fs.xl, fontWeight: '700', color: COLORS.white }}>
                                            {registryRecord ? '등기 내용 보기' : '등기 열람하기'}
                                        </Text>
                                        {!registryRecord && (
                                            <View style={{ marginLeft: 8, backgroundColor: 'rgba(255,255,255,0.22)', borderRadius: RADIUS.chip - 2, paddingHorizontal: 8, paddingVertical: 2 }}>
                                                <Text style={{ fontSize: fs.sm, color: COLORS.white, fontWeight: '700' }}>1P</Text>
                                            </View>
                                        )}
                                    </TouchableOpacity>
                                    {registryRecord?.viewed_at && (
                                        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: SPACING.sm, flexWrap: 'wrap' }}>
                                            <Text style={{ fontSize: 16, color: COLORS.success, marginRight: 6 }}>{'✓'}</Text>
                                            <Text style={{ fontSize: fs.sm, fontWeight: '700', color: COLORS.success }}>{formatShortDate(registryRecord.viewed_at)} 등기 조회함</Text>
                                            <Text style={{ fontSize: fs.sm, color: COLORS.textMuted }}> · </Text>
                                            <TouchableOpacity onPress={handleRegistryRefreshLinkPress} accessibilityLabel="다시 열람 1포인트" accessibilityRole="button">
                                                <Text style={{ fontSize: fs.sm, color: COLORS.textMuted, textDecorationLine: 'underline' }}>다시 열람 1P</Text>
                                            </TouchableOpacity>
                                        </View>
                                    )}

                                    {/* 보조 액션 2개 */}
                                    <View style={{ flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.xl2 }}>
                                        <TouchableOpacity
                                            onPress={() => setStreetViewVisible(true)}
                                            style={{ flex: 1, height: 56, borderRadius: RADIUS.button, borderWidth: 1.5, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' }}
                                            accessibilityLabel="실제 사진"
                                            accessibilityRole="button"
                                        >
                                            <Text style={{ fontSize: fs.base, fontWeight: '700', color: COLORS.inkSub }}>실제 사진</Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity
                                            onPress={() => setPlaceManagementVisible(true)}
                                            style={{ flex: 1, height: 56, borderRadius: RADIUS.button, borderWidth: 1.5, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' }}
                                            accessibilityLabel="영업 기록"
                                            accessibilityRole="button"
                                        >
                                            <Text style={{ fontSize: fs.base, fontWeight: '700', color: COLORS.inkSub }}>영업 기록</Text>
                                        </TouchableOpacity>
                                    </View>

                                    {/* 최근 기록 */}
                                    {nearbyPlaceRecord && (
                                        <View style={{ marginTop: SPACING.xl2, paddingTop: SPACING.base, borderTopWidth: 1, borderTopColor: COLORS.lineSoft2 }}>
                                            <Text style={{ fontSize: fs.sm, fontWeight: '700', color: COLORS.inkSub, marginBottom: SPACING.sm }}>최근 기록</Text>
                                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: PLACE_STATUS_COLORS[nearbyPlaceRecord.status], marginRight: SPACING.sm }} />
                                                <Text style={{ fontSize: fs.base, color: COLORS.ink, flex: 1 }} numberOfLines={1}>
                                                    {nearbyPlaceRecord.status}{nearbyPlaceRecord.memo ? ` · ${nearbyPlaceRecord.memo}` : ''}
                                                </Text>
                                                {nearbyPlaceRecord.status_date && (
                                                    <Text style={{ fontSize: fs.sm, color: COLORS.textMuted }}>{formatShortDate(nearbyPlaceRecord.status_date)}</Text>
                                                )}
                                            </View>
                                        </View>
                                    )}
                                </ScrollView>
                            </View>
                        )}

                        {/* 화면 07/08: 영업 기록 2단계 */}
                        {selectedMarker && (
                            <SalesRecordFlow
                                visible={placeManagementVisible}
                                onClose={() => setPlaceManagementVisible(false)}
                                onSaved={() => showToast('기록했어요')}
                                latitude={selectedMarker.latitude}
                                longitude={selectedMarker.longitude}
                                address={selectedMarker.address}
                            />
                        )}
                    </View>
                );
            case 'sales':
                return (
                    <MoreScreen
                        variant="sales"
                        onMoveToMap={() => setCurrentTab('map')}
                        onMoveToMapWithLocation={(lat, lng, address) => {
                            setRegion({ latitude: lat, longitude: lng, latitudeDelta: 0.002, longitudeDelta: 0.002 });
                            setSelectedMarker({ id: `place-${Date.now()}`, name: address || '장소관리 장소', address: address || '', latitude: lat, longitude: lng, distance: 0 });
                            setCurrentTab('map');
                        }}
                        onOpenProperty={(propertyId) => {
                            supabase.from('properties').select('*').eq('property_id', propertyId).single().then(({ data }) => {
                                if (data) { setSelectedProperty(data as Property); setPropertyModalVisible(true); }
                            });
                        }}
                    />
                );
            case 'profile':
                return (
                    <MoreScreen
                        variant="profile"
                        onMoveToMap={() => setCurrentTab('map')}
                        onMoveToMapWithLocation={(lat, lng, address) => {
                            setRegion({ latitude: lat, longitude: lng, latitudeDelta: 0.002, longitudeDelta: 0.002 });
                            setSelectedMarker({ id: `place-${Date.now()}`, name: address || '장소관리 장소', address: address || '', latitude: lat, longitude: lng, distance: 0 });
                            setCurrentTab('map');
                        }}
                        onOpenProperty={(propertyId) => {
                            supabase.from('properties').select('*').eq('property_id', propertyId).single().then(({ data }) => {
                                if (data) { setSelectedProperty(data as Property); setPropertyModalVisible(true); }
                            });
                        }}
                    />
                );
            default:
                return null;
        }
    };

    return (
    <>
        <StatusBar barStyle="light-content" backgroundColor="#09090B" translucent={false} />
        <SafeAreaView style={styles.container}>
            {/* 네트워크 상태 말풍선 (모든 탭에서 표시) */}
            <NetworkBubble isOnline={isOnline} />

            {renderContent()}

            {/* 하단 토스트 */}
            {toastMessage && (
                <View style={{ position: 'absolute', left: 0, right: 0, bottom: TOUCH_TARGETS.tabBar + 16, alignItems: 'center', zIndex: 999 }} pointerEvents="none">
                    <View style={{ backgroundColor: COLORS.ink, borderRadius: RADIUS.pill, paddingHorizontal: SPACING.xl3, paddingVertical: SPACING.base, ...ELEVATION.floating }}>
                        <Text style={{ color: COLORS.white, fontSize: fs.base, fontWeight: '700' }}>{toastMessage}</Text>
                    </View>
                </View>
            )}

            {/* 하단 탭바 (지도 · 영업 · 내정보) - regionSelect/placeSearch 시 숨김 */}
            {!['regionSelect', 'placeSearch', 'buildings', 'places'].includes(currentTab) && <View style={[styles.floatingMenu, elderlyMode && { height: 108 }]}>
                {([
                    { id: 'map',     label: '지도',   a11y: '지도 탭' },
                    { id: 'sales',   label: '영업',   a11y: '영업 탭' },
                    { id: 'profile', label: '내정보', a11y: '내정보 탭' },
                ] as { id: string; label: string; a11y: string }[]).map(tab => {
                    const active = currentTab === tab.id;
                    return (
                        <TouchableOpacity
                            key={tab.id}
                            style={styles.menuItem}
                            onPress={() => { setCurrentTab(tab.id); }}
                            accessibilityLabel={tab.a11y}
                            accessibilityRole="tab"
                            accessibilityState={{ selected: active }}
                        >
                            <Text style={[
                                styles.menuText,
                                elderlyMode && { fontSize: 16 },
                                active && styles.activeMenuText,
                            ]}>{tab.label}</Text>
                        </TouchableOpacity>
                    );
                })}
            </View>}

            {/* 화면 03: 등기 열람 확인 시트 */}
            <RegistryConfirmSheet
                visible={registryConfirmVisible}
                onClose={() => setRegistryConfirmVisible(false)}
                onConfirm={handleRegistryConfirm}
                address={selectedMarker?.address || selectedMarker?.name || ''}
                balance={tilkoBalance}
                isRefresh={registryConfirmIsRefresh}
            />

            {/* 등기정보 Modal (Tilko API) */}
            <RegistryInfoModal
                visible={registryModalVisible}
                onClose={() => setRegistryModalVisible(false)}
                marker={selectedMarker}
            />

            {/* 매물 상세 Modal (Supabase 영업관리) */}
            <PropertyDetailModal
                visible={propertyModalVisible}
                onClose={() => setPropertyModalVisible(false)}
                property={selectedProperty}
            />

        </SafeAreaView>

        {/* 대문(스플래시) 화면 - SafeAreaView 위에 오버레이 */}
        {splashRendered && (
            <SplashScreen
                visible={splashVisible}
                progress={splashProgress}
                stage={splashStage}
                onHidden={() => setSplashRendered(false)}
            />
        )}

        {/* 화면 19: 위치 권한 사전 설명 (스플래시 직후 1회만) */}
        {!splashRendered && showLocationIntro && (
            <LocationPermissionIntroScreen
                onAllow={handleAllowLocationFromIntro}
                onSkip={handleSkipLocationIntro}
            />
        )}
    </>
    );
}

// ===== 화면 19: 대문 — 위치 권한 요청 =====

const LocationPermissionIntroScreen = ({ onAllow, onSkip }: { onAllow: () => void; onSkip: () => void }) => {
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    return (
        <View style={{ ...StyleSheet.absoluteFillObject, zIndex: 9998, backgroundColor: COLORS.white }}>
            <View style={{ height: 300, backgroundColor: '#F4F8FE', alignItems: 'center', justifyContent: 'center' }}>
                <View style={{ width: 88, height: 88, borderRadius: 30, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' }}>
                    <View style={{ alignItems: 'center' }}>
                        <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 3, borderColor: COLORS.white }} />
                        <View style={{ width: 8, height: 8, backgroundColor: COLORS.white, transform: [{ rotate: '45deg' }], marginTop: -7 }} />
                    </View>
                </View>
                <Text style={{ fontSize: 28, fontWeight: '900', color: COLORS.ink, letterSpacing: -1, marginTop: 16 }}>맵인포</Text>
            </View>

            <View style={{ paddingHorizontal: 28, paddingTop: 30, flex: 1 }}>
                <Text style={{ fontSize: fs.xl + 9, fontWeight: '700', color: COLORS.ink, lineHeight: 36 }}>
                    {'현재 위치 근처의\n건물을 바로 보여드릴게요'}
                </Text>
                <Text style={{ fontSize: fs.base, color: COLORS.textMuted, lineHeight: 28, marginTop: SPACING.base }}>
                    위치 정보는 지도를 여는 동안에만 사용되며,{'\n'}영업 동선 기록에도 활용됩니다.
                </Text>

                <View style={{ backgroundColor: COLORS.surface, borderRadius: RADIUS.sheet - 6, padding: SPACING.xl3, marginTop: SPACING.xl4 }}>
                    {[
                        '내 주변 공장·창고·물류 건물을 자동으로 찾아드려요',
                        '방문 동선이 자동으로 기록돼요',
                    ].map((text, idx) => (
                        <View key={idx} style={{ flexDirection: 'row', alignItems: 'flex-start', marginTop: idx === 0 ? 0 : 16 }}>
                            <Text style={{ fontSize: 22, color: COLORS.success, marginRight: SPACING.base }}>{'✓'}</Text>
                            <Text style={{ flex: 1, fontSize: fs.base, color: COLORS.inkSub, lineHeight: 24 }}>{text}</Text>
                        </View>
                    ))}
                </View>
            </View>

            <View style={{ paddingHorizontal: 28, paddingBottom: 36, gap: SPACING.base }}>
                <TouchableOpacity
                    onPress={onAllow}
                    style={{ height: 64, borderRadius: RADIUS.button, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' }}
                    accessibilityLabel="위치 사용 허용"
                    accessibilityRole="button"
                >
                    <Text style={{ fontSize: fs.xl + 3, fontWeight: '700', color: COLORS.white }}>위치 사용 허용</Text>
                </TouchableOpacity>
                <TouchableOpacity
                    onPress={onSkip}
                    style={{ height: 64, borderRadius: RADIUS.button, backgroundColor: COLORS.surface, alignItems: 'center', justifyContent: 'center' }}
                    accessibilityLabel="나중에 하기"
                    accessibilityRole="button"
                >
                    <Text style={{ fontSize: fs.lg, fontWeight: '700', color: COLORS.textMuted }}>나중에 하기</Text>
                </TouchableOpacity>
            </View>
        </View>
    );
};

// ===== 대문(스플래시) 화면 =====

interface SplashProps {
    progress: number;       // 0~100
    stage: string;          // 단계 메시지
    visible: boolean;
    onHidden: () => void;
}

const SplashScreen = ({ progress, stage, visible, onHidden }: SplashProps) => {
    const fadeAnim = useRef(new Animated.Value(1)).current;
    const hidden = useRef(false);

    useEffect(() => {
        if (!visible && !hidden.current) {
            hidden.current = true;
            Animated.timing(fadeAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => onHidden());
        }
    }, [visible]);

    const clampedProgress = Math.min(Math.max(progress, 0), 100);

    return (
        <Animated.View style={[splashStyles.container, { opacity: fadeAnim }]}>
            <StatusBar barStyle="dark-content" backgroundColor="transparent" translucent />

            {/* 상단 틴트 영역 */}
            <View style={splashStyles.topTint} />

            {/* 로고 블록 */}
            <View style={splashStyles.logoArea}>
                <View style={splashStyles.logoMark}>
                    <View style={{ alignItems: 'center' }}>
                        <View style={splashStyles.pinHead} />
                        <View style={splashStyles.pinTip} />
                    </View>
                </View>
                <Text style={splashStyles.appTitle}>맵인포</Text>
                <Text style={splashStyles.appSubtitle}>{'태양광 영업을 위한\n스마트 지도 서비스'}</Text>
            </View>

            {/* 진행 영역 */}
            <View style={splashStyles.loadingArea}>
                <View style={splashStyles.progressTrack}>
                    <Animated.View style={[splashStyles.progressFill, { width: `${clampedProgress}%` }]} />
                </View>
                <Text style={splashStyles.stageText}>{stage}</Text>
            </View>

            {/* 하단 버전 */}
            <Text style={splashStyles.versionText}>v{APP_VERSION}</Text>
        </Animated.View>
    );
};

const splashStyles = StyleSheet.create({
    container: { ...StyleSheet.absoluteFillObject, zIndex: 9999, backgroundColor: COLORS.white },
    topTint: { position: 'absolute', top: 0, left: 0, right: 0, height: 360, backgroundColor: '#F4F8FE' },
    logoArea: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACING.xl3 },
    logoMark: { width: 104, height: 104, borderRadius: 34, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center', shadowColor: COLORS.primary, shadowOpacity: 0.32, shadowRadius: 28, shadowOffset: { width: 0, height: 12 }, elevation: 10 },
    pinHead: { width: 26, height: 26, borderRadius: 13, borderWidth: 3, borderColor: COLORS.white },
    pinTip: { width: 10, height: 10, backgroundColor: COLORS.white, transform: [{ rotate: '45deg' }], marginTop: -8 },
    appTitle: { fontSize: 34, fontWeight: '900', color: COLORS.ink, letterSpacing: -1.2, marginTop: 28 },
    appSubtitle: { fontSize: 17, color: COLORS.textMuted, lineHeight: 26, textAlign: 'center', marginTop: 12 },
    loadingArea: { position: 'absolute', left: 40, right: 40, bottom: 120 },
    stageText: { fontSize: 15, color: COLORS.textMuted, textAlign: 'center', marginTop: 12 },
    progressTrack: { width: '100%', height: 6, backgroundColor: COLORS.lineSoft, borderRadius: 3, overflow: 'hidden' },
    progressFill: { height: '100%', backgroundColor: COLORS.primary, borderRadius: 3 },
    versionText: { position: 'absolute', bottom: 48, left: 0, right: 0, textAlign: 'center', fontSize: 14, color: COLORS.textMuted },
});
export default function App() {
    return (
        <QueryClientProvider client={queryClient}>
            <AppContent />
        </QueryClientProvider>
    );
}

// ===== 스타일 =====

// TDS tokens: bg=#FFFFFF surface=#F9FAFB border=#E8ECF0 primary=#0050FF text=#191F28
const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#FFFFFF', paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 },
    header: { height: 54, backgroundColor: '#FFFFFF', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', zIndex: 10, borderBottomWidth: 1, borderBottomColor: '#E8ECF0' },
    headerIconWrap: { position: 'absolute', left: 20, justifyContent: 'center', alignItems: 'center' },
    headerIcon: { fontSize: 22 },
    title: { color: '#191F28', fontSize: 17, fontWeight: '700', letterSpacing: -0.5 },
    mapContainer: { flex: 1, width: '100%', height: '100%' },
    map: { flex: 1, width: '100%', height: '100%' },
    floatingMenu: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: COLORS.white, borderTopWidth: 1, borderTopColor: COLORS.lineSoft, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'flex-start', height: TOUCH_TARGETS.tabBar, paddingTop: SPACING.base, zIndex: 10 },
    menuItem: { flex: 1, alignItems: 'center', justifyContent: 'flex-start', height: '100%', paddingVertical: 8 },
    menuText: { fontSize: TYPOGRAPHY.tabLabel.fontSize, color: COLORS.textMuted, fontWeight: TYPOGRAPHY.tabLabel.fontWeight },
    activeMenuText: { color: COLORS.primary, fontWeight: TYPOGRAPHY.tabLabelActive.fontWeight },
    mapSearchBar: { position: 'absolute', top: 56, left: 16, right: 16, height: 60, backgroundColor: COLORS.white, borderRadius: RADIUS.button, flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.xl2, zIndex: 40, ...ELEVATION.floating },
    mapSearchResults: { position: 'absolute', top: 120, left: 16, right: 16, backgroundColor: COLORS.white, borderRadius: RADIUS.button, zIndex: 40, overflow: 'hidden', ...ELEVATION.floating },
    gpsButton: { position: 'absolute', bottom: 300, right: 16, width: 60, height: 60, borderRadius: RADIUS.sheet - 4, backgroundColor: COLORS.white, justifyContent: 'center', alignItems: 'center', gap: 2, zIndex: 11, ...ELEVATION.floating },
    gpsButtonText: { fontSize: 11, color: COLORS.primary, fontWeight: '700' },
    mapTypeWrapper: { position: 'absolute', top: 132, left: 16, flexDirection: 'row', gap: SPACING.sm, zIndex: 39 },
    tabButton: { paddingVertical: 10, paddingHorizontal: 18, borderRadius: RADIUS.pill, backgroundColor: COLORS.white, ...ELEVATION.card },
    activeTabButton: { backgroundColor: COLORS.ink },
    tabButtonText: { fontSize: 15, color: COLORS.inkSub, fontWeight: '500' },
    activeTabButtonText: { color: COLORS.white, fontWeight: '700' },
    bottomPanel: { position: 'absolute', bottom: 125, left: 16, right: 16, backgroundColor: '#FFFFFF', borderRadius: 24, padding: 20, shadowColor: '#000', shadowOffset: { width: 0, height: -2 }, shadowOpacity: 0.06, shadowRadius: 16, elevation: 20, zIndex: 20 },
    bottomPanelHandle: { width: 36, height: 4, backgroundColor: '#D8DDE4', borderRadius: 2, alignSelf: 'center', marginBottom: 16 },
    mapPeekSheet: { position: 'absolute', left: 0, right: 0, bottom: TOUCH_TARGETS.tabBar, backgroundColor: COLORS.white, borderTopLeftRadius: RADIUS.sheet, borderTopRightRadius: RADIUS.sheet, paddingTop: SPACING.lg, paddingHorizontal: SPACING.xl3, paddingBottom: SPACING.xl3, zIndex: 20, ...ELEVATION.sheet },
    loadingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center', zIndex: 100 },
    loadingBox: { backgroundColor: '#FFFFFF', borderRadius: 24, padding: 28, width: Dimensions.get('window').width * 0.75, alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.1, shadowOffset: { width: 0, height: 4 }, shadowRadius: 16, elevation: 10 },
    loadingText: { fontSize: 15, color: '#191F28', fontWeight: '700', textAlign: 'center', marginBottom: 16 },
    progressBarContainer: { width: '100%', height: 4, backgroundColor: '#E8ECF0', borderRadius: 2, overflow: 'hidden' },
    progressBar: { height: '100%', backgroundColor: '#0050FF', borderRadius: 2 },
    progressText: { fontSize: 12, color: '#8B95A1', marginTop: 8 },
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
    modalContent: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 36 },
    modalTitle: { fontSize: 18, fontWeight: '800', color: '#191F28', marginBottom: 20, textAlign: 'center', letterSpacing: -0.5 },
    modalLabel: { fontSize: 13, color: '#8B95A1', fontWeight: '600', marginBottom: 6 },
    modalInput: { borderWidth: 1.5, borderColor: '#E8ECF0', borderRadius: 14, padding: 14, fontSize: 15, marginBottom: 12, backgroundColor: '#F9FAFB', color: '#191F28' },
    modalSearchButton: { backgroundColor: '#0050FF', paddingVertical: 15, borderRadius: 16, alignItems: 'center' },
    modalSearchButtonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
    modalResultBox: { backgroundColor: '#F9FAFB', borderRadius: 16, padding: 18, marginBottom: 16, borderWidth: 1, borderColor: '#E8ECF0' },
    modalResultLabel: { fontSize: 12, color: '#8B95A1', fontWeight: '600', marginBottom: 4 },
    modalResultValue: { fontSize: 15, color: '#191F28', fontWeight: '700', marginBottom: 12 },
    modalErrorText: { fontSize: 13, color: '#FF3B30', textAlign: 'center', fontWeight: '600' },
    modalCloseButton: { paddingVertical: 15, backgroundColor: '#F2F4F6', borderRadius: 16, alignItems: 'center', marginTop: 10 },
    modalCloseButtonText: { fontSize: 15, color: '#191F28', fontWeight: '700' },
    propModalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
    propModalTitle: { fontSize: 18, fontWeight: '800', color: '#191F28', flex: 1, marginRight: 10, letterSpacing: -0.5 },
    statusBadge: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 10 },
    statusBadgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
    propSection: { backgroundColor: '#F9FAFB', borderRadius: 18, padding: 18, marginBottom: 14, borderWidth: 1, borderColor: '#E8ECF0' },
    propSectionTitle: { fontSize: 14, fontWeight: '700', color: '#191F28', marginBottom: 12, letterSpacing: -0.3 },
    propRow: { flexDirection: 'row', marginBottom: 10, alignItems: 'flex-start' },
    propLabel: { fontSize: 12, color: '#8B95A1', width: 80, flexShrink: 0, paddingTop: 2, fontWeight: '500' },
    propValue: { fontSize: 14, color: '#191F28', flex: 1, lineHeight: 22, fontWeight: '600' },
    statusGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
    statusChip: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 12, borderWidth: 1.5 },
    statusChipText: { fontSize: 13, fontWeight: '700' },
    memoInput: { borderWidth: 1.5, borderColor: '#E8ECF0', borderRadius: 14, padding: 14, fontSize: 14, minHeight: 88, backgroundColor: '#F9FAFB', color: '#191F28' },
    propModalButtons: { flexDirection: 'row', gap: 10, paddingTop: 16, borderTopWidth: 1, borderTopColor: '#E8ECF0', marginTop: 4 },
    historyToolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 10, backgroundColor: '#F9FAFB', borderBottomWidth: 1, borderBottomColor: '#E8ECF0' },
    exportButton: { paddingHorizontal: 14, paddingVertical: 7, backgroundColor: '#0050FF', borderRadius: 10 },
    exportButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
    propCancelButton: { flex: 1, paddingVertical: 14, backgroundColor: '#F2F4F6', borderRadius: 16, alignItems: 'center' },
    propCancelButtonText: { fontSize: 15, color: '#191F28', fontWeight: '700' },
    propSaveButton: { flex: 2, paddingVertical: 14, backgroundColor: '#0050FF', borderRadius: 16, alignItems: 'center' },
    propSaveButtonText: { fontSize: 15, color: '#FFFFFF', fontWeight: '700' },
    listContainer: { flex: 1, backgroundColor: '#FFFFFF' },
    listItemContainer: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#F2F4F6' },
    listItem: { flex: 1, paddingHorizontal: 20, paddingVertical: 16 },
    itemName: { fontSize: 15, fontWeight: '700', color: '#191F28', flex: 1, letterSpacing: -0.3 },
    itemAddress: { fontSize: 13, color: '#8B95A1', marginTop: 3 },
    itemDate: { fontSize: 11, color: '#B0B8C1', marginTop: 3 },
    moveButton: { flex: 1, paddingVertical: 10, backgroundColor: '#0050FF', borderRadius: 12, alignItems: 'center' },
    moveButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
    favoriteButton: { flex: 1, paddingVertical: 10, backgroundColor: '#F2F4F6', borderRadius: 12, alignItems: 'center' },
    favoriteButtonText: { color: '#191F28', fontSize: 13, fontWeight: '600' },
    subScreenContainer: { flex: 1, backgroundColor: '#FFFFFF' },
    subScreenHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#E8ECF0' },
    subScreenTitle: { fontSize: 18, fontWeight: '800', color: '#191F28', letterSpacing: -0.5 },
    backButton: { padding: 4 },
    backButtonText: { fontSize: 15, color: '#0050FF', fontWeight: '700' },
    searchContainer: { flexDirection: 'row', paddingHorizontal: 20, paddingVertical: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: '#E8ECF0' },
    searchInput: { flex: 1, borderWidth: 1.5, borderColor: '#E8ECF0', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11, fontSize: 14, backgroundColor: '#F9FAFB', color: '#191F28' },
    searchButton: { backgroundColor: '#0050FF', paddingHorizontal: 18, borderRadius: 14, justifyContent: 'center' },
    searchButtonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },
    clearButton: { padding: 8, justifyContent: 'center' },
    clearButtonText: { color: '#8B95A1', fontSize: 13 },
    viewLocationButton: { paddingHorizontal: 14, paddingVertical: 10, marginRight: 8, backgroundColor: '#0050FF', borderRadius: 12, minWidth: 66, alignItems: 'center' },
    viewLocationButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700', textAlign: 'center', lineHeight: 17 },
    daumSearchButton: { marginHorizontal: 20, marginTop: 14, marginBottom: 4, paddingVertical: 15, backgroundColor: '#0050FF', borderRadius: 16, alignItems: 'center' },
    daumSearchButtonText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
    daumModalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#E8ECF0', backgroundColor: '#FFFFFF' },
    daumModalTitle: { fontSize: 17, fontWeight: '800', color: '#191F28', letterSpacing: -0.5 },
    daumModalClose: { paddingVertical: 7, paddingHorizontal: 14, backgroundColor: '#F2F4F6', borderRadius: 10 },
    daumModalCloseText: { color: '#191F28', fontSize: 13, fontWeight: '700' },
    locationButton: { paddingHorizontal: 12, paddingVertical: 10, marginRight: 10, backgroundColor: '#0050FF', borderRadius: 12, minWidth: 62, alignItems: 'center' },
    locationButtonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700', textAlign: 'center', lineHeight: 17 },
    pendingCard: { marginHorizontal: 20, marginTop: 14, backgroundColor: '#FFFFFF', borderRadius: 20, padding: 20, borderWidth: 1, borderColor: '#E8ECF0', shadowColor: '#000', shadowOpacity: 0.06, shadowOffset: { width: 0, height: 2 }, shadowRadius: 10, elevation: 3 },
    pendingCardBadge: { alignSelf: 'flex-start', backgroundColor: '#EEF2FF', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, marginBottom: 10 },
    pendingCardBadgeText: { color: '#0050FF', fontSize: 11, fontWeight: '700' },
    pendingCardName: { fontSize: 15, fontWeight: '700', color: '#191F28', marginBottom: 4, letterSpacing: -0.3 },
    pendingCardAddress: { fontSize: 13, color: '#8B95A1', marginBottom: 4 },
    pendingCardCoord: { fontSize: 11, color: '#B0B8C1', marginBottom: 14, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
    pendingCardButtons: { flexDirection: 'row', gap: 10 },
    pendingCancelButton: { flex: 1, paddingVertical: 13, backgroundColor: '#F2F4F6', borderRadius: 14, alignItems: 'center' },
    pendingCancelButtonText: { fontSize: 14, color: '#191F28', fontWeight: '700' },
    pendingConfirmButton: { flex: 2, paddingVertical: 13, backgroundColor: '#0050FF', borderRadius: 14, alignItems: 'center' },
    pendingConfirmButtonText: { fontSize: 14, color: '#FFFFFF', fontWeight: '700' },
    deleteButton: { paddingHorizontal: 16, paddingVertical: 9, backgroundColor: '#FF3B30', borderRadius: 12, justifyContent: 'center', alignItems: 'center', marginLeft: 8 },
    deleteButtonText: { fontSize: 12, color: '#FFFFFF', fontWeight: '700' },
    emptyContainer: { padding: 48, alignItems: 'center' },
    emptyText: { fontSize: 14, color: '#8B95A1', textAlign: 'center', lineHeight: 24 },
    loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    menuContainer: { flex: 1, padding: 20, gap: 12, backgroundColor: '#FFFFFF' },
    menuButton: { paddingHorizontal: 20, paddingVertical: 18, backgroundColor: '#FFFFFF', borderRadius: 18, borderWidth: 1, borderColor: '#E8ECF0', shadowColor: '#000', shadowOpacity: 0.04, shadowOffset: { width: 0, height: 1 }, shadowRadius: 4, elevation: 1 },
    menuButtonText: { fontSize: 16, color: '#191F28', fontWeight: '600' },
    registryOwnerBadge: { backgroundColor: '#EEF2FF', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
    registryOwnerBadgeText: { fontSize: 11, color: '#0050FF', fontWeight: '700' },
    registryUnknownBadge: { backgroundColor: '#F2F4F6', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
    registryUnknownBadgeText: { fontSize: 11, color: '#8B95A1' },
    registryOwnerAddr: { fontSize: 12, color: '#8B95A1', marginBottom: 2 },
    skeletonBox: { backgroundColor: '#E8ECF0', borderRadius: 8 },
    loaderFooter: { padding: 20, alignItems: 'center' },
});

