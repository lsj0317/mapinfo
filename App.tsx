import './global.css';
import 'react-native-url-polyfill/auto';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
    StyleSheet, Text, View, SafeAreaView, TouchableOpacity,
    Platform, StatusBar, Alert, FlatList, Animated,
    ActivityIndicator, Dimensions, TextInput, Modal, ScrollView,
    Share, Image, Linking, AppState, AppStateStatus, Vibration,
} from 'react-native';
import GoogleMapView, { GoogleMapHandle, type MapRegion as Region } from './GoogleMapView';
import KakaoSkyView, { type KakaoSkyViewHandle } from './KakaoSkyView';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { VWORLD_API_KEY, TILKO_API_KEY, IROS_USER_ID, IROS_USER_PASSWORD, EMONEY_NO1, EMONEY_NO2, EMONEY_PWD, KAKAO_API_KEY, GOOGLE_MAPS_API_KEY } from '@env';
import forge from 'node-forge';
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
const ONBOARDING_DONE_KEY = 'onboarding_done';
const FONT_SIZE_LEVEL_KEY = 'font_size_level';
const SIMPLE_MODE_KEY = 'simple_mode';

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
const SOLAR_MIN_AREA_SMALL = 200;   // 소형 (필터 1단계)
const SOLAR_MIN_AREA_MEDIUM = 500;  // 중형 (필터 2단계)
const SOLAR_MIN_AREA_LARGE = 1000;  // 대형 (필터 3단계)

// ===== 고령자 모드 글꼴/사이즈 설정 =====

type FontSizeLevel = 'normal' | 'large' | 'extraLarge';

const FONT_SCALE_LEVELS: Record<FontSizeLevel, Record<string, number>> = {
    normal: {
        xs: 14, sm: 15, md: 16, base: 17, lg: 19, xl: 21, '2xl': 23, '3xl': 25, '4xl': 30,
    },
    large: {
        xs: 17, sm: 18, md: 19, base: 21, lg: 23, xl: 25, '2xl': 27, '3xl': 30, '4xl': 35,
    },
    extraLarge: {
        xs: 20, sm: 21, md: 23, base: 25, lg: 27, xl: 30, '2xl': 33, '3xl': 36, '4xl': 42,
    },
};

// 하위호환: elderlyMode true → extraLarge
const FONT_SCALE = {
    normal: FONT_SCALE_LEVELS.normal,
    elderly: FONT_SCALE_LEVELS.extraLarge,
};

const TOUCH_SIZE = {
    normal: { minHeight: 48, padding: 12 },
    elderly: { minHeight: 72, padding: 18 },
};

const COLORS_HIGH_CONTRAST = {
    primary: '#0D47A1',
    primaryBg: '#1565C0',
    text: '#000000',
    textSecondary: '#333333',
    textMuted: '#555555',
    border: '#999999',
    error: '#C62828',
    success: '#1B5E20',
    warning: '#E65100',
};

// ===== Phase 1: 색상 대비 강화 (WCAG AA 4.5:1 이상) =====
const COLORS_ACCESSIBLE = {
    mutedText: '#737373',       // 기존 #A1A1AA → 4.5:1 이상
    secondaryText: '#525252',   // 기존 #71717A → 5.5:1 이상
    hintText: '#636363',        // 기존 #A1A1AA → 5:1 이상
    inactiveIcon: '#6B6B6B',    // 기존 #A1A1AA → 4.7:1 이상
    border: '#BFBFBF',          // 기존 #E4E4E7 → 더 뚜렷한 구분선
    panelCloseText: '#525252',  // 기존 #999 → 명확한 닫기 버튼
};

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
        record?: {
            total: string;
            current: string;
        };
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

interface TilkoSearchItem {
    pin?: string;
    wk_pin?: string;
    real_cls_cd?: string;
    real_indi_cont?: string;
    pin_mid_spe_yn?: string;
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

const SALES_TARGET_LABELS: Record<SalesTargetFilter, string> = {
    all: '전체',
    industrial: '공단',
    residential: '민간주택',
};

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

// ===== Tilko 잔액 DB 저장/조회 =====
async function saveTilkoBalanceToDB(balance: number): Promise<void> {
    try {
        // upsert: id=1 고정 row에 잔액 저장
        await supabase.from('tilko_balance').upsert([{
            id: 1,
            balance,
            updated_at: new Date().toISOString(),
        }]);
    } catch (e) {
        console.warn('잔액 DB 저장 실패:', e);
    }
}

async function fetchTilkoBalanceFromDB(): Promise<number | null> {
    try {
        const { data, error } = await supabase
            .from('tilko_balance')
            .select('balance')
            .eq('id', 1)
            .single();
        if (error || !data) return null;
        return typeof data.balance === 'number' ? data.balance : null;
    } catch {
        return null;
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

    fontSizeLevel: FontSizeLevel;
    setFontSizeLevel: (level: FontSizeLevel) => void;

    simpleMode: boolean;
    setSimpleMode: (mode: boolean) => void;

    salesTargetFilter: SalesTargetFilter;
    setSalesTargetFilter: (filter: SalesTargetFilter) => void;

    tilkoBalance: number | null;      // Tilko API 포인트 잔액 (null=미조회)
    setTilkoBalance: (balance: number | null) => void;
    balanceError: boolean;             // 잔액 조회 실패 여부
    setBalanceError: (error: boolean) => void;

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
        latitudeDelta: 0.001,
        longitudeDelta: 0.001,
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

    elderlyMode: true,
    setElderlyMode: (mode) => {
        set({ elderlyMode: mode });
        AsyncStorage.setItem(ELDERLY_MODE_KEY, JSON.stringify(mode)).catch(console.warn);
    },

    fontSizeLevel: 'extraLarge' as FontSizeLevel,
    setFontSizeLevel: (level) => {
        set({ fontSizeLevel: level, elderlyMode: level === 'extraLarge' });
        AsyncStorage.setItem(FONT_SIZE_LEVEL_KEY, level).catch(console.warn);
        AsyncStorage.setItem(ELDERLY_MODE_KEY, JSON.stringify(level === 'extraLarge')).catch(console.warn);
    },

    simpleMode: true,
    setSimpleMode: (mode) => {
        set({ simpleMode: mode });
        AsyncStorage.setItem(SIMPLE_MODE_KEY, JSON.stringify(mode)).catch(console.warn);
    },

    salesTargetFilter: 'all',
    setSalesTargetFilter: (filter) => {
        set({ salesTargetFilter: filter });
        AsyncStorage.setItem(SALES_TARGET_KEY, filter).catch(() => {});
    },

    tilkoBalance: null,
    setTilkoBalance: (balance) => set({ tilkoBalance: balance }),
    balanceError: false,
    setBalanceError: (error) => set({ balanceError: error }),

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
 * Tilko API 포인트 잔액 조회
 * GetPublicKey 응답의 PointBalance 필드 사용 (별도 엔드포인트 없음)
 * @returns 잔액(포인트) or null(오류/미인증)
 */

/**
 * Tilko/IROS API 응답에서 잔액 부족 여부를 감지한다.
 * 잔액 부족이면 "[잔액부족]" 접두사가 붙은 메시지를 반환, 아니면 null.
 */
function detectBalanceError(json: Record<string, unknown>): string | null {
    const msg = String(json.Message ?? json.message ?? '');
    const errLog = String(json.ErrorLog ?? json.TargetMessage ?? json.errorLog ?? '');
    const combined = (msg + ' ' + errLog).toLowerCase();

    const isInsufficient = combined.includes('부족') || combined.includes('잔액')
        || combined.includes('insufficient') || combined.includes('balance')
        || combined.includes('credit') || combined.includes('크레딧');

    if (!isInsufficient) return null;

    const isElectronic = combined.includes('전자화폐') || combined.includes('emoney')
        || combined.includes('이머니') || combined.includes('전자민원');

    if (isElectronic) {
        return '[잔액부족] 조회 비용이 부족합니다.\n충전 후 다시 시도해 주세요.';
    }
    return '[잔액부족] 조회 비용이 부족합니다.\n충전 후 다시 시도해 주세요.';
}

async function createTilkoEncryption() {
    const pubKeyRes = await fetch(`https://api.tilko.net/api/Auth/GetPublicKey?APIkey=${TILKO_API_KEY}`);
    const pubKeyJson = await pubKeyRes.json();
    const pubKeyRaw = pubKeyJson.PublicKey;
    // PointBalance: 등기 조회 후 잔액 자동 갱신에 활용
    const pointBalance: number | null = typeof pubKeyJson.PointBalance === 'number' ? pubKeyJson.PointBalance : null;
    const aesKey = forge.random.getBytesSync(16);
    const iv = forge.util.createBuffer(new Array(16).fill(0).map(() => String.fromCharCode(0)).join(''));

    const encryptAES = (plainText: string) => {
        const cipher = forge.cipher.createCipher('AES-CBC', aesKey);
        cipher.start({ iv: iv.copy() });
        cipher.update(forge.util.createBuffer(forge.util.encodeUtf8(plainText)));
        cipher.finish();
        return forge.util.encode64(cipher.output.getBytes());
    };

    const pemKey = pubKeyRaw.startsWith('-----') ? pubKeyRaw
        : '-----BEGIN PUBLIC KEY-----\n' + pubKeyRaw + '\n-----END PUBLIC KEY-----';
    const publicKey = forge.pki.publicKeyFromPem(pemKey);
    const encAesKey = forge.util.encode64(publicKey.encrypt(aesKey, 'RSAES-PKCS1-V1_5'));

    return { encryptAES, encAesKey, pointBalance };
}

async function fetchRegistryInfo(pin: string): Promise<{ owner: string; address: string; xmlData: string; pointBalance: number | null }> {
    const { encryptAES, encAesKey, pointBalance } = await createTilkoEncryption();
    const body = {
        Auth: {
            UserId: encryptAES(IROS_USER_ID),
            UserPassword: encryptAES(IROS_USER_PASSWORD),
        },
        Pin: pin,  // 평문 전달 (틸코 기술지원 확인)
        EmoneyNo1: encryptAES(EMONEY_NO1),
        EmoneyNo2: encryptAES(EMONEY_NO2),
        EmoneyPwd: encryptAES(EMONEY_PWD),
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 150000);
    let registryRes: Response;
    try {
        registryRes = await fetch('https://api.tilko.net/api/v2.0/Iros2IdLogin/RealtyRegistry', {
            method: 'POST',
            headers: {
                'API-KEY': TILKO_API_KEY,
                'ENC-KEY': encAesKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeoutId);
    }

    const registryJson = await registryRes.json();
    const regOk = registryJson.Message === 'OK' || registryJson.Message === '성공' || registryJson.Status === 'Success';
    if (!regOk) {
        const balanceMsg = detectBalanceError(registryJson as Record<string, unknown>);
        if (balanceMsg) throw new Error(balanceMsg);
        const errorDetail = registryJson.ErrorLog || registryJson.TargetMessage || '';
        throw new Error(registryJson.Message + (errorDetail ? ` (${errorDetail})` : '') || '등기정보 조회 실패');
    }

    const xmlData = registryJson.XmlData || '';

    // 소유주 + 소유자 주소: 가장 마지막 갑구(type=K) 소유자 항목에서 추출
    // 형식: "소유자  이름  번호\n    주소"
    const ownerBlocks = [...xmlData.matchAll(/<wksbk_nomprs_and_etc><!\[CDATA\[([\s\S]*?)\]\]><\/wksbk_nomprs_and_etc>/g)];
    const lastOwnerBlock = [...ownerBlocks].reverse().find(m => m[1].includes('소유자'));
    const ownerName = lastOwnerBlock ? (lastOwnerBlock[1].match(/소유자\s+([^\s]+)/) || [])[1] : undefined;
    const ownerAddr = lastOwnerBlock ? (lastOwnerBlock[1].match(/소유자\s+[^\n]+\n\s*([^\n]+)/) || [])[1]?.trim() : undefined;

    return {
        owner: ownerName || '정보 없음',
        address: ownerAddr || '정보 없음',
        xmlData,
        pointBalance,
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
    const { encAesKey } = await createTilkoEncryption();
    const searchRes = await fetch('https://api.tilko.net/api/v2.0/Iros2/RetrieveSmplSrchList', {
        method: 'POST',
        headers: {
            'API-KEY': TILKO_API_KEY,
            'ENC-KEY': encAesKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ Address: addr }),
    });
    const searchJson = await searchRes.json();
    const searchOk = searchJson.Message === 'OK' || searchJson.Message === '성공' || searchJson.Status === 'Success';
    if (!searchOk) {
        const balanceMsg = detectBalanceError(searchJson as Record<string, unknown>);
        if (balanceMsg) throw new Error(balanceMsg);
        throw new Error(searchJson.ErrorLog || searchJson.Message || '건물을 찾을 수 없습니다. 다른 주소로 다시 시도해 주세요.');
    }
    const dataList = (searchJson.Result && searchJson.Result.DataList) || searchJson.DataList || [];
    if (dataList.length === 0) throw new Error('해당 주소에 대한 등기 정보를 찾을 수 없습니다.');
    return dataList.map((item: TilkoSearchItem) => ({
        uniqueNo: item.pin || item.wk_pin || '',
        realtyType: item.real_cls_cd || '',
        addrFull: item.real_indi_cont || '',
        isSpecial: item.pin_mid_spe_yn === 'Y',
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
    bubbleText: { color: '#FAFAFA', fontSize: 14, fontWeight: '500' },
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
}: {
    visible: boolean;
    onClose: () => void;
    latitude: number;
    longitude: number;
    title?: string;
}) => {
    const googleKey = GOOGLE_MAPS_API_KEY || '';
    const html = useMemo(
        () => buildStreetViewHTML(latitude, longitude, googleKey),
        [latitude, longitude, googleKey],
    );

    return (
        <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
            <SafeAreaView style={{ flex: 1, backgroundColor: '#000' }}>
                <View style={svStyles.header}>
                    <Text style={svStyles.title} numberOfLines={1}>
                        {title || '실제이미지'}
                    </Text>
                    <TouchableOpacity onPress={onClose} style={svStyles.closeBtn} accessibilityLabel="실제이미지 닫기" accessibilityRole="button">
                        <Text style={svStyles.closeTxt}>✕ 닫기</Text>
                    </TouchableOpacity>
                </View>
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
            </SafeAreaView>
        </Modal>
    );
});

const svStyles = StyleSheet.create({
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: '#09090B',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#27272A',
    },
    title: { color: '#FAFAFA', fontSize: 17, fontWeight: '700', flex: 1, marginRight: 12, letterSpacing: -0.3 },
    closeBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, backgroundColor: '#27272A', borderRadius: 8, minHeight: 48 },
    closeTxt: { color: '#FAFAFA', fontSize: 16, fontWeight: '600' },
    loading: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' },
    noKey: { flex: 1, backgroundColor: '#111', justifyContent: 'center', alignItems: 'center', padding: 32 },
    noKeyText: { color: '#fff', fontSize: 14, lineHeight: 24, textAlign: 'center' },
});

// ===== 스마트 필터 바 =====

const FILTER_CATEGORIES = ['공장', '창고', '물류'];
const FILTER_AREA_OPTIONS = [
    { label: '전체', value: 0 },
    { label: '200㎡+', value: SOLAR_MIN_AREA_SMALL },
    { label: '500㎡+', value: SOLAR_MIN_AREA_MEDIUM },
    { label: '1000㎡+', value: SOLAR_MIN_AREA_LARGE },
];

const FilterBar = React.memo(({
    filter,
    onChange,
    totalCount,
    filteredCount,
}: {
    filter: BuildingFilter;
    onChange: (f: BuildingFilter) => void;
    totalCount: number;
    filteredCount: number;
}) => {
    const [expanded, setExpanded] = useState(false);

    const toggleCategory = (cat: string) => {
        const next = filter.selectedCategories.includes(cat)
            ? filter.selectedCategories.filter(c => c !== cat)
            : [...filter.selectedCategories, cat];
        if (next.length === 0) return; // 최소 1개 유지
        onChange({ ...filter, selectedCategories: next });
    };

    const hasActiveFilter = filter.minArea > 0
        || filter.onlyHighPotential
        || filter.selectedCategories.length < FILTER_CATEGORIES.length;

    return (
        <View style={filterStyles.wrapper}>
            <TouchableOpacity
                style={[filterStyles.header, hasActiveFilter && filterStyles.headerActive]}
                onPress={() => setExpanded(e => !e)}
            >
                <Text style={filterStyles.headerIcon}>{hasActiveFilter ? '·' : '›'}</Text>
                <Text style={[filterStyles.headerText, hasActiveFilter && { color: '#1565C0' }]}>
                    필터{hasActiveFilter ? ' (적용중)' : ''}
                </Text>
                <Text style={filterStyles.countText}>{filteredCount}/{totalCount}건</Text>
                {hasActiveFilter && (
                    <TouchableOpacity
                        onPress={() => onChange(DEFAULT_FILTER)}
                        style={filterStyles.resetBtn}
                        accessibilityLabel="필터 초기화"
                        accessibilityRole="button"
                    >
                        <Text style={filterStyles.resetText}>초기화</Text>
                    </TouchableOpacity>
                )}
            </TouchableOpacity>

            {expanded && (
                <View style={filterStyles.panel}>
                    {/* 카테고리 */}
                    <Text style={filterStyles.sectionLabel}>건물 유형</Text>
                    <View style={filterStyles.chipRow}>
                        {FILTER_CATEGORIES.map(cat => {
                            const active = filter.selectedCategories.includes(cat);
                            return (
                                <TouchableOpacity
                                    key={cat}
                                    style={[filterStyles.chip, active && filterStyles.chipActive]}
                                    onPress={() => toggleCategory(cat)}
                                    accessibilityLabel={`건물 유형 ${cat} ${active ? '선택됨' : ''}`}
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: active }}
                                >
                                    <Text style={[filterStyles.chipText, active && filterStyles.chipTextActive]}>
                                        {cat}
                                    </Text>
                                </TouchableOpacity>
                            );
                        })}
                    </View>

                    {/* 최소 면적 */}
                    <Text style={filterStyles.sectionLabel}>최소 면적 (Supabase 매물)</Text>
                    <View style={filterStyles.chipRow}>
                        {FILTER_AREA_OPTIONS.map(opt => (
                            <TouchableOpacity
                                key={opt.value}
                                style={[filterStyles.chip, filter.minArea === opt.value && filterStyles.chipActive]}
                                onPress={() => onChange({ ...filter, minArea: opt.value })}
                                accessibilityLabel={`최소 면적 ${opt.label} ${filter.minArea === opt.value ? '선택됨' : ''}`}
                                accessibilityRole="button"
                                accessibilityState={{ selected: filter.minArea === opt.value }}
                            >
                                <Text style={[filterStyles.chipText, filter.minArea === opt.value && filterStyles.chipTextActive]}>
                                    {opt.label}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>

                    {/* 고잠재력 토글 */}
                    <TouchableOpacity
                        style={filterStyles.toggleRow}
                        onPress={() => onChange({ ...filter, onlyHighPotential: !filter.onlyHighPotential })}
                        accessibilityLabel={`고잠재력만 보기 ${filter.onlyHighPotential ? '켜짐' : '꺼짐'}`}
                        accessibilityRole="switch"
                        accessibilityState={{ checked: filter.onlyHighPotential }}
                    >
                        <Text style={filterStyles.toggleLabel}>
                            고잠재력만 보기 (500㎡+ 공장/창고)
                        </Text>
                        <View style={[filterStyles.toggle, filter.onlyHighPotential && filterStyles.toggleOn]}>
                            <View style={[filterStyles.toggleThumb, filter.onlyHighPotential && filterStyles.toggleThumbOn]} />
                        </View>
                    </TouchableOpacity>
                </View>
            )}
        </View>
    );
});

const filterStyles = StyleSheet.create({
    wrapper: { backgroundColor: '#FAFAFA', borderBottomWidth: 1, borderBottomColor: '#E4E4E7' },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        paddingVertical: 10,
        gap: 8,
    },
    headerActive: { backgroundColor: '#F4F4F5' },
    headerIcon: { fontSize: 14, color: '#525252' },
    headerText: { fontSize: 13, color: '#52525B', fontWeight: '500', flex: 1 },
    countText: { fontSize: 14, color: '#737373' },
    resetBtn: { paddingHorizontal: 10, paddingVertical: 4, backgroundColor: '#18181B', borderRadius: 6 },
    resetText: { color: '#FAFAFA', fontSize: 13, fontWeight: '600' },
    panel: { paddingHorizontal: 14, paddingBottom: 14 },
    sectionLabel: { fontSize: 14, color: '#525252', fontWeight: '500', marginBottom: 8, marginTop: 10 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 6, borderWidth: 1, borderColor: '#E4E4E7', backgroundColor: '#fff' },
    chipActive: { borderColor: '#18181B', backgroundColor: '#18181B' },
    chipText: { fontSize: 15, color: '#52525B', fontWeight: '500' },
    chipTextActive: { color: '#FAFAFA' },
    toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#E4E4E7' },
    toggleLabel: { fontSize: 15, color: '#18181B', flex: 1 },
    toggle: { width: 44, height: 24, borderRadius: 12, backgroundColor: '#E4E4E7', padding: 2 },
    toggleOn: { backgroundColor: '#18181B' },
    toggleThumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' },
    toggleThumbOn: { transform: [{ translateX: 20 }] },
});

// ===== 클러스터 마커 컴포넌트 =====

const clusterStyles = StyleSheet.create({
    bubble: {
        borderWidth: 2,
        backgroundColor: 'rgba(255,255,255,0.9)',
        justifyContent: 'center',
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3,
        shadowRadius: 3,
        elevation: 5,
    },
    inner: { justifyContent: 'center', alignItems: 'center' },
    count: { color: '#fff', fontWeight: '800' },
});

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
                    accessibilityLabel="현장 사진 추가"
                    accessibilityRole="button"
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
                <ScrollView horizontal showsHorizontalScrollIndicator={true}>
                    {photos.map((url, idx) => (
                        <TouchableOpacity
                            key={idx}
                            onLongPress={() => handleDeletePhoto(url)}
                            style={photoStyles.photoWrap}
                            accessibilityLabel={`현장 사진 ${idx + 1}. 길게 눌러 삭제`}
                            accessibilityRole="imagebutton"
                            accessibilityHint="길게 누르면 사진을 삭제합니다"
                        >
                            <Image source={{ uri: url }} style={photoStyles.photo} accessibilityLabel={`현장 사진 ${idx + 1}`} accessibilityRole="image" />
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
    addBtnText: { color: '#FAFAFA', fontSize: 15, fontWeight: '500' },
    empty: { fontSize: 15, color: '#737373', textAlign: 'center', paddingVertical: 16 },
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
            Alert.alert('날짜를 다시 확인해 주세요', '연도-월-일 순서로 입력해 주세요.\n예: 2025-03-15');
            return;
        }
        if (parsed <= new Date()) {
            Alert.alert('날짜를 다시 확인해 주세요', '오늘 이후의 날짜를 입력해 주세요.');
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
                    <Text style={{ fontSize: 15, color: '#92400E', flex: 1 }}>
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
                    <TouchableOpacity onPress={handleCancel} style={notifStyles.cancelBtn} accessibilityLabel="알림 예약 취소" accessibilityRole="button">
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
                        accessibilityLabel="알림 날짜 입력. 연도 월 일 형식"
                        accessibilityHint="예시: 2025-03-15"
                    />
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                        <TouchableOpacity style={notifStyles.cancelTextBtn} onPress={() => setShowDatePicker(false)} accessibilityLabel="날짜 선택 취소" accessibilityRole="button">
                            <Text style={{ color: '#636363' }}>취소</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[notifStyles.confirmBtn, isSaving && { opacity: 0.6 }]}
                            onPress={handleSchedule}
                            disabled={isSaving}
                            accessibilityLabel="알림 예약 확인"
                            accessibilityRole="button"
                        >
                            {isSaving ? <ActivityIndicator size="small" color="#fff" /> : <Text style={notifStyles.confirmBtnText}>알림 예약</Text>}
                        </TouchableOpacity>
                    </View>
                </View>
            ) : (
                <TouchableOpacity style={notifStyles.addBtn} onPress={() => setShowDatePicker(true)} accessibilityLabel="연락 예정일 알림 설정" accessibilityRole="button">
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
    scheduledSub: { fontSize: 14, color: '#525252', marginTop: 2 },
    cancelBtn: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#18181B', borderRadius: 6 },
    cancelBtnText: { color: '#FAFAFA', fontSize: 14, fontWeight: '500' },
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
    const [showDetailFields, setShowDetailFields] = useState(false);

    useEffect(() => {
        if (property) {
            setEditStatus(property.sales_status);
            setEditMemo(property.sales_memo || '');
        }
    }, [property]);

    const hasUnsavedChanges = property && (
        editStatus !== property.sales_status ||
        (editMemo || '') !== (property.sales_memo || '')
    );

    const handleClose = () => {
        if (hasUnsavedChanges) {
            Alert.alert(
                '저장하지 않은 변경사항',
                '수정한 내용이 저장되지 않았습니다.\n그래도 닫으시겠습니까?',
                [
                    { text: '계속 수정', style: 'cancel' },
                    { text: '저장 안 함', style: 'destructive', onPress: onClose },
                ],
            );
        } else {
            onClose();
        }
    };

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
        <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
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

                    <ScrollView showsVerticalScrollIndicator={true}>
                        {/* 등기부등본 정보 섹션 - 핵심 정보 */}
                        <View style={styles.propSection}>
                            <Text style={styles.propSectionTitle}>건물 정보</Text>

                            <View style={styles.propRow}>
                                <Text style={styles.propLabel}>주소</Text>
                                <Text style={styles.propValue}>{property.road_address || '-'}</Text>
                            </View>
                            <View style={styles.propRow}>
                                <Text style={styles.propLabel}>소유자</Text>
                                <Text style={[styles.propValue, { color: '#1565C0', fontWeight: '700' }]}>
                                    {property.owner_name || '-'}
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

                            {/* 상세 정보 접기/펼치기 */}
                            <TouchableOpacity
                                onPress={() => setShowDetailFields(!showDetailFields)}
                                style={{ paddingVertical: 12, alignItems: 'center', borderTopWidth: 1, borderTopColor: '#E4E4E7', marginTop: 8 }}
                                accessibilityLabel={showDetailFields ? '상세 정보 접기' : '상세 정보 펼치기'}
                                accessibilityRole="button"
                            >
                                <Text style={{ fontSize: fs.base, color: '#3B82F6', fontWeight: '600' }}>
                                    {showDetailFields ? '▲ 상세 정보 접기' : '▼ 상세 정보 더보기'}
                                </Text>
                            </TouchableOpacity>

                            {showDetailFields && (
                                <>
                                    <View style={styles.propRow}>
                                        <Text style={styles.propLabel}>지번주소</Text>
                                        <Text style={styles.propValue}>{property.parcel_address || '-'}</Text>
                                    </View>
                                    <View style={styles.propRow}>
                                        <Text style={styles.propLabel}>소유자 주소</Text>
                                        <Text style={[styles.propValue, { color: '#1565C0' }]}>
                                            {property.owner_address || '-'}
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
                                    {!elderlyMode && (
                                        <>
                                            <View style={styles.propRow}>
                                                <Text style={styles.propLabel}>부동산번호</Text>
                                                <Text style={styles.propValue}>{property.property_id}</Text>
                                            </View>
                                            <View style={styles.propRow}>
                                                <Text style={styles.propLabel}>좌표</Text>
                                                <Text style={styles.propValue}>
                                                    {property.lat.toFixed(6)}, {property.lng.toFixed(6)}
                                                </Text>
                                            </View>
                                        </>
                                    )}
                                </>
                            )}
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
                            onPress={handleClose}
                            accessibilityLabel="닫기"
                            accessibilityRole="button"
                        >
                            <Text style={[styles.propCancelButtonText, { fontSize: fs.lg }]}>✕ 닫기</Text>
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
                        <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 10, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 8, minHeight: 44 }}>
                            <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>✕ </Text>
                            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>닫기</Text>
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
                        <Text style={rxs.closeBtnTxt}>✕ 닫기</Text>
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
    docSubtitle: { fontSize: 14, textAlign: 'center', color: '#525252', marginBottom: 6 },
    divider: { height: 1, backgroundColor: '#333', marginVertical: 8 },
    docRow: { flexDirection: 'row', marginTop: 3 },
    docLabel: { fontSize: 14, color: '#525252', width: 72 },
    docValue: { fontSize: 14, color: '#000', flex: 1 },
    sectionHeader: { backgroundColor: '#37474F', paddingVertical: 7, paddingHorizontal: 12, marginTop: 10, marginHorizontal: 10, borderTopLeftRadius: 4, borderTopRightRadius: 4, alignItems: 'center' },
    sectionHeaderText: { color: '#fff', fontSize: 15, fontWeight: '700', letterSpacing: 1 },
    sectionHeaderSub: { color: '#CFD8DC', fontSize: 13, marginTop: 2 },
    table: { marginHorizontal: 10, borderWidth: 1, borderTopWidth: 0, borderColor: '#666', backgroundColor: '#fff' },
    row: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#999' },
    rowCont: { backgroundColor: '#F9F9F9' },
    cell: { padding: 4, borderRightWidth: 1, borderRightColor: '#999' },
    cellTxt: { fontSize: 13, color: '#222', lineHeight: 14 },
    footer: { margin: 10, marginTop: 14, padding: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: '#ccc', borderRadius: 4, alignItems: 'center' },
    footerTxt: { fontSize: 14, color: '#525252', textAlign: 'center' },
    footerDate: { fontSize: 15, fontWeight: '600', color: '#333', marginTop: 4 },
    footerJuris: { fontSize: 15, color: '#333', marginTop: 2 },
    closeBtn: { backgroundColor: '#37474F', margin: 12, borderRadius: 10, paddingVertical: 16, alignItems: 'center', minHeight: 56 },
    closeBtnTxt: { color: '#fff', fontSize: 18, fontWeight: '700' },
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
        color: '#525252',
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
        fontSize: 14,
        fontWeight: '700',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginBottom: 6,
    },
    label: {
        fontSize: 15,
        color: '#525252',
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
        fontSize: 13,
        color: '#636363',
        marginTop: 4,
        fontStyle: 'italic',
    },
});

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
            if (info.pointBalance !== null) { useMapStore.getState().setTilkoBalance(info.pointBalance); saveTilkoBalanceToDB(info.pointBalance); }
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
            if (info.pointBalance !== null) { useMapStore.getState().setTilkoBalance(info.pointBalance); saveTilkoBalanceToDB(info.pointBalance); }
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
        <Modal visible={visible} transparent animationType="slide" onRequestClose={xmlModalVisible ? () => setXmlModalVisible(false) : handleClose}>
            {xmlModalVisible && xmlData ? (
                <RegistryXmlModal visible={true} onClose={() => setXmlModalVisible(false)} xmlData={xmlData} />
            ) : (
            <View style={styles.modalOverlay}>
                <View style={styles.modalContent}>
                    <Text style={styles.modalTitle}>등기정보 조회 (Tilko API)</Text>

                    {marker && !directMode && (
                        <View style={{ marginBottom: 12 }}>
                            <Text style={styles.modalLabel}>선택된 위치</Text>
                            <Text style={{ fontSize: 13, color: '#525252', marginBottom: 4 }}>{marker.address}</Text>
                            {pnu ? <Text style={{ fontSize: 15, color: '#636363' }}>PNU: {pnu}</Text> : null}
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
                        <View style={{ alignItems: 'center', paddingVertical: 28, backgroundColor: '#F8FAFC', borderRadius: 12, marginBottom: 12 }}>
                            <ActivityIndicator size="large" color="#3498DB" />
                            <Text style={{ marginTop: 14, color: '#333', fontSize: 17, fontWeight: '600', textAlign: 'center', lineHeight: 26 }}>
                                {status || '잠시만 기다려주세요...'}
                            </Text>
                            <Text style={{ marginTop: 6, color: '#737373', fontSize: 14 }}>
                                조회에 시간이 걸릴 수 있습니다
                            </Text>
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
                        <View style={{ marginBottom: 16 }}>
                            {fromCache && (
                                <View style={{ backgroundColor: '#E8F5E9', padding: 12, borderRadius: 10, marginBottom: 12, borderWidth: 1, borderColor: '#A5D6A7' }}>
                                    <Text style={{ fontSize: 15, color: '#2E7D32', textAlign: 'center', fontWeight: '600' }}>
                                        ✅ 저장된 데이터입니다 (API 비용 미발생)
                                    </Text>
                                </View>
                            )}

                            {/* 카드형 요약 UI */}
                            <View style={{ backgroundColor: '#fff', borderRadius: 14, borderWidth: 1.5, borderColor: '#BFBFBF', overflow: 'hidden' }}>
                                {/* 소유주 카드 */}
                                <View style={{ flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#EBEBEB' }}>
                                    <Text style={{ fontSize: 28, marginRight: 14 }}>👤</Text>
                                    <View style={{ flex: 1 }}>
                                        <Text style={{ fontSize: 14, color: '#737373', fontWeight: '600', marginBottom: 2 }}>소유주</Text>
                                        <Text style={{ fontSize: 20, color: '#18181B', fontWeight: '800' }}>{result.owner}</Text>
                                    </View>
                                </View>

                                {/* 주소 카드 */}
                                <View style={{ flexDirection: 'row', alignItems: 'center', padding: 16 }}>
                                    <Text style={{ fontSize: 28, marginRight: 14 }}>📍</Text>
                                    <View style={{ flex: 1 }}>
                                        <Text style={{ fontSize: 14, color: '#737373', fontWeight: '600', marginBottom: 2 }}>주소</Text>
                                        <Text style={{ fontSize: 17, color: '#18181B', fontWeight: '600', lineHeight: 24 }}>{result.address}</Text>
                                    </View>
                                </View>
                            </View>

                            {/* 액션 버튼들 */}
                            <View style={{ marginTop: 14, gap: 10 }}>
                                {xmlData ? (
                                    <TouchableOpacity
                                        style={{ backgroundColor: '#1A237E', borderRadius: 12, paddingVertical: 16, alignItems: 'center', minHeight: 56, flexDirection: 'row', justifyContent: 'center', gap: 8 }}
                                        onPress={() => setXmlModalVisible(true)}
                                    >
                                        <Text style={{ fontSize: 20 }}>📄</Text>
                                        <Text style={{ color: '#fff', fontSize: 17, fontWeight: '700' }}>등기부등본 상세보기</Text>
                                    </TouchableOpacity>
                                ) : null}
                                <TouchableOpacity
                                    style={[{ backgroundColor: '#16A34A', borderRadius: 12, paddingVertical: 16, alignItems: 'center', minHeight: 56, flexDirection: 'row', justifyContent: 'center', gap: 8 }, isRegisteringProperty && { opacity: 0.6 }]}
                                    onPress={handleRegisterAsProperty}
                                    disabled={isRegisteringProperty}
                                >
                                    {isRegisteringProperty
                                        ? <ActivityIndicator size="small" color="#fff" />
                                        : <>
                                            <Text style={{ fontSize: 20 }}>➕</Text>
                                            <Text style={{ color: '#fff', fontSize: 17, fontWeight: '700' }}>매물로 등록 (영업관리)</Text>
                                        </>
                                    }
                                </TouchableOpacity>
                            </View>
                        </View>
                    ) : null}

                    {/* 토지이용계획 패널 */}
                    {result && (
                        <LandUsePanel info={landUseInfo} isLoading={isLoadingLandUse} />
                    )}
                    <TouchableOpacity style={styles.modalCloseButton} onPress={handleClose}>
                        <Text style={styles.modalCloseButtonText}>✕ 닫기</Text>
                    </TouchableOpacity>
                </View>
            </View>
            )}
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

const PlaceSearchScreen = ({ onBack, onMoveToMap }: { onBack: () => void; onMoveToMap: () => void }) => {
    const [searchText, setSearchText] = useState('');
    const [searchResults, setSearchResults] = useState<Building[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [daumModalVisible, setDaumModalVisible] = useState(false);
    const [pendingResult, setPendingResult] = useState<Building | null>(null);
    const { setRegion, setSelectedMarker, elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const ts = elderlyMode ? TOUCH_SIZE.elderly : TOUCH_SIZE.normal;

    // VWorld 장소명 검색
    const handleSearch = async () => {
        if (!searchText.trim()) return;
        setIsLoading(true);
        try {
            let url = `https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=20&page=1&query=${encodeURIComponent(searchText)}&type=place&format=json&errorformat=json&key=${VWORLD_API_KEY}`;
            let response = await fetch(url);
            let json = await response.json();
            if (json.response.status === 'NOT_FOUND' || !json.response.result) {
                url = `https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=20&page=1&query=${encodeURIComponent(searchText)}&type=address&format=json&errorformat=json&key=${VWORLD_API_KEY}`;
                response = await fetch(url);
                json = await response.json();
            }
            if (json.response.status === 'NOT_FOUND' || !json.response.result) {
                setSearchResults([]);
            } else {
                setSearchResults(json.response.result.items.map((item: VWorldPlaceItem) => ({
                    id: item.id,
                    name: item.title || item.address?.road || item.address?.parcel,
                    address: item.address?.road || item.address?.parcel || '',
                    distance: 0,
                    latitude: parseFloat(item.point.y),
                    longitude: parseFloat(item.point.x),
                })));
            }
        } catch {
            Alert.alert('검색 실패', '검색 중 문제가 생겼습니다.\n잠시 후 다시 시도해 주세요.');
        } finally {
            setIsLoading(false);
        }
    };

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
                Alert.alert('주소를 찾을 수 없습니다', '입력한 주소의 위치를 찾지 못했습니다.\n다른 주소로 다시 시도하거나,\n지도에서 직접 찾아주세요.');
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
        <View style={styles.subScreenContainer}>
            {/* 헤더 */}
            <View style={styles.subScreenHeader}>
                <TouchableOpacity onPress={onBack} style={styles.backButton} accessibilityLabel="뒤로 가기" accessibilityRole="button">
                    <Text style={[styles.backButtonText, { fontSize: fs.lg }]}>{'← 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={[styles.subScreenTitle, { fontSize: fs['2xl'] }]}>장소 검색</Text>
                <View style={{ width: 50 }} />
            </View>

            {/* 다음 주소검색 버튼 */}
            <TouchableOpacity
                style={[styles.daumSearchButton, elderlyMode && { paddingVertical: 16, marginHorizontal: 16 }]}
                onPress={() => setDaumModalVisible(true)}
                accessibilityLabel="다음 주소 검색 열기"
                accessibilityRole="button"
            >
                <Text style={[styles.daumSearchButtonText, { fontSize: fs.lg }]}>다음 주소 검색</Text>
            </TouchableOpacity>

            {/* 장소명 검색 */}
            <View style={styles.searchContainer}>
                <TextInput
                    style={[styles.searchInput, { fontSize: fs.base }, elderlyMode && { paddingVertical: 12 }]}
                    placeholder="장소명으로 검색 (공장, 창고 등)"
                    value={searchText}
                    onChangeText={setSearchText}
                    onSubmitEditing={handleSearch}
                    returnKeyType="search"
                    accessibilityLabel="장소명 검색 입력"
                />
                <TouchableOpacity
                    onPress={handleSearch}
                    style={[styles.searchButton, elderlyMode && { paddingHorizontal: 20, paddingVertical: 12 }]}
                    accessibilityLabel="검색 실행"
                    accessibilityRole="button"
                >
                    <Text style={[styles.searchButtonText, { fontSize: fs.base }]}>검색</Text>
                </TouchableOpacity>
            </View>

            {/* 로딩 */}
            {isLoading && (
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color="#71717A" />
                    <Text style={{ marginTop: 10, color: '#636363' }}>검색 중...</Text>
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

            {/* 결과 목록 */}
            {!isLoading && (
                <FlatList
                    data={searchResults}
                    keyExtractor={(item) => item.id}
                    removeClippedSubviews={true}
                    maxToRenderPerBatch={10}
                    windowSize={5}
                    renderItem={({ item }) => (
                        <View style={[styles.listItemContainer, elderlyMode && { minHeight: 96 }]}>
                            <View style={[styles.listItem, elderlyMode && { padding: 18 }]}>
                                <Text style={[styles.itemName, { fontSize: fs.lg }]} numberOfLines={1}>{item.name}</Text>
                                <Text style={[styles.itemAddress, { fontSize: fs.md }]} numberOfLines={2}>{item.address}</Text>
                            </View>
                            <TouchableOpacity
                                style={[styles.locationButton, elderlyMode && { paddingHorizontal: 14, paddingVertical: 14, minWidth: 72 }]}
                                onPress={() => moveToLocation(item)}
                                accessibilityLabel={`${item.name} 지도에서 보기`}
                                accessibilityRole="button"
                            >
                                <Text style={[styles.locationButtonText, { fontSize: fs.sm }]}>{'지도에서\n보기'}</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                    ListEmptyComponent={
                        !pendingResult ? (
                            <View style={styles.emptyContainer}>
                                <Text style={[styles.emptyText, { fontSize: fs.base }]}>
                                    {'위의 다음 주소 검색 또는\n장소명 검색을 이용해 주세요.'}
                                </Text>
                            </View>
                        ) : null
                    }
                    contentContainerStyle={{ paddingBottom: 100 }}
                />
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
                            <Text style={styles.daumModalCloseText}>✕ 닫기</Text>
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
                    <Text style={[styles.backButtonText, { fontSize: fs.lg }]}>{'← 뒤로'}</Text>
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
                    <View style={[styles.listItemContainer, elderlyMode && { minHeight: 96 }]}>
                        <TouchableOpacity style={[styles.listItem, elderlyMode && { padding: 18 }]} onPress={() => {
                            setSelectedMarker(item);
                            setRegion({ latitude: item.latitude, longitude: item.longitude, latitudeDelta: 0.001, longitudeDelta: 0.001 });
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
                ListEmptyComponent={<View style={styles.emptyContainer}><Text style={[styles.emptyText, { fontSize: fs.base }]}>{searchText ? "검색 결과가 없습니다." : "최근 본 장소가 없습니다."}</Text></View>}
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
                    <Text style={[styles.backButtonText, { fontSize: fs.lg }]}>{'← 뒤로'}</Text>
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
                    <View style={[styles.listItemContainer, elderlyMode && { minHeight: 96 }]}>
                        <TouchableOpacity style={[styles.listItem, elderlyMode && { padding: 18 }]} onPress={() => {
                            setSelectedMarker(item);
                            setRegion({ latitude: item.latitude, longitude: item.longitude, latitudeDelta: 0.001, longitudeDelta: 0.001 });
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
                ListEmptyComponent={<View style={styles.emptyContainer}><Text style={[styles.emptyText, { fontSize: fs.base }]}>{searchText ? "검색 결과가 없습니다." : "즐겨 찾는 장소가 없습니다."}</Text></View>}
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

    const infoRows: { label: string; value: string | null; highlight?: boolean }[] = [
        { label: '소유자명 (실명)', value: record.owner_name || '미확인', highlight: true },
        { label: '실거주지', value: record.owner_address || '미확인', highlight: true },
        { label: '도로명주소', value: record.road_address },
        { label: '지번주소', value: record.jibun_address },
        { label: '좌표', value: record.lat && record.lng ? `${record.lat.toFixed(6)}, ${record.lng.toFixed(6)}` : null },
        { label: '열람일시', value: `${new Date(record.viewed_at).toLocaleDateString('ko-KR')} ${new Date(record.viewed_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` },
    ];

    return (
        <View style={styles.subScreenContainer}>
            <View style={styles.subScreenHeader}>
                <TouchableOpacity onPress={onBack} style={styles.backButton}>
                    <Text style={[styles.backButtonText, { fontSize: fs.lg }]}>{'← 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={[styles.subScreenTitle, { fontSize: fs['2xl'] }]}>등기 열람 상세</Text>
                <View style={{ width: 50 }} />
            </View>
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
                {/* 소유자 하이라이트 카드 */}
                <View style={{ backgroundColor: '#EFF6FF', borderRadius: 8, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#BFDBFE' }}>
                    <Text style={{ fontSize: fs.xs, color: '#1D4ED8', fontWeight: '600', marginBottom: 6 }}>소유자 정보 (핵심)</Text>
                    <Text style={{ fontSize: fs.lg, fontWeight: '700', color: '#1D4ED8', marginBottom: 4 }}>
                        {record.owner_name || '미확인'}
                    </Text>
                    <Text style={{ fontSize: fs.sm, color: '#1D4ED8' }}>{record.owner_address || '실거주지 미확인'}</Text>
                </View>

                {/* 나머지 정보 */}
                {infoRows.slice(2).map(({ label, value }) => value ? (
                    <View key={label} style={{ backgroundColor: '#fff', borderRadius: 8, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#E4E4E7' }}>
                        <Text style={{ fontSize: fs.xs, color: '#525252', marginBottom: 4 }}>{label}</Text>
                        <Text style={{ fontSize: fs.base, color: '#18181B', fontWeight: '500' }}>{value}</Text>
                    </View>
                ) : null)}

                {/* 우편 발송 공유 */}
                {record.owner_name && record.owner_address && (
                    <View style={{ backgroundColor: '#FFFBEB', borderRadius: 8, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#FDE68A' }}>
                        <Text style={{ fontSize: fs.xs, color: '#92400E', fontWeight: '600', marginBottom: 8 }}>우편 발송 정보</Text>
                        <Text style={{ fontSize: fs.sm, color: '#92400E', lineHeight: 20, marginBottom: 10 }}>
                            수신: {record.owner_name}{'\n'}주소: {record.owner_address}
                        </Text>
                        <TouchableOpacity
                            style={{ backgroundColor: '#92400E', borderRadius: 6, paddingVertical: 8, alignItems: 'center' }}
                            onPress={async () => {
                                const text = `소유자: ${record.owner_name}\n주소: ${record.owner_address}\n부동산: ${record.road_address || record.jibun_address || ''}`;
                                await Share.share({ title: '소유주 발송 정보', message: text });
                            }}
                        >
                            <Text style={{ color: '#fff', fontSize: fs.sm, fontWeight: '600' }}>발송 정보 공유</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {/* XML 보기 */}
                {record.xml_data ? (
                    <TouchableOpacity
                        style={{ backgroundColor: '#1E3A8A', borderRadius: 8, paddingVertical: 12, alignItems: 'center', marginBottom: 8 }}
                        onPress={() => setXmlModalVisible(true)}
                    >
                        <Text style={{ color: '#fff', fontSize: fs.sm, fontWeight: '600' }}>등기부등본 XML 보기</Text>
                    </TouchableOpacity>
                ) : null}

                {/* 삭제 버튼 (맨 아래) */}
                <TouchableOpacity
                    style={{ marginTop: 16, borderWidth: 1, borderColor: '#EF4444', borderRadius: 8, paddingVertical: 12, alignItems: 'center' }}
                    onPress={handleDelete}
                >
                    <Text style={{ color: '#EF4444', fontSize: fs.sm, fontWeight: '600' }}>이력 삭제</Text>
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

    const handleListDelete = (id: string) => {
        Alert.alert('삭제 확인', '이 열람 이력을 삭제하시겠습니까?', [
            { text: '취소', style: 'cancel' },
            { text: '삭제', style: 'destructive', onPress: () => handleSoftDelete(id) },
        ]);
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

    return (
        <View style={styles.subScreenContainer}>
            <View style={styles.subScreenHeader}>
                <TouchableOpacity onPress={onBack} style={styles.backButton}>
                    <Text style={[styles.backButtonText, { fontSize: fs.lg }]}>{'← 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={[styles.subScreenTitle, { fontSize: fs['2xl'] }]}>등기 열람 이력</Text>
                <TouchableOpacity
                    onPress={handleExportCSV}
                    style={{ paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#18181B', borderRadius: 6, marginRight: 4 }}
                >
                    <Text style={{ color: '#FAFAFA', fontSize: fs.xs, fontWeight: '600' }}>CSV</Text>
                </TouchableOpacity>
            </View>

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

            {!isLoading && (
                <View style={{ paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#F4F4F5', flexDirection: 'row', alignItems: 'center' }}>
                    <Text style={{ fontSize: fs.xs, color: '#525252', flex: 1 }}>
                        총 {filtered.length}건 · 소유자 확인 {filtered.filter(r => r.owner_name).length}건
                    </Text>
                    <TouchableOpacity onPress={loadHistory}>
                        <Text style={{ fontSize: fs.xs, color: '#4A90E2', fontWeight: '600' }}>새로고침</Text>
                    </TouchableOpacity>
                </View>
            )}

            {isLoading ? (
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color="#71717A" />
                </View>
            ) : (
                <FlatList
                    data={filtered}
                    keyExtractor={(item) => item.id}
                    removeClippedSubviews={true}
                    maxToRenderPerBatch={10}
                    windowSize={5}
                    renderItem={({ item }) => (
                        <View style={styles.listItemContainer}>
                            <TouchableOpacity
                                style={[styles.listItem, elderlyMode && { padding: 18 }]}
                                onPress={() => setSelectedRecord(item)}
                            >
                                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                                    <Text style={[styles.itemName, { flex: 1, marginRight: 8, fontSize: fs.base }]} numberOfLines={1}>
                                        {item.road_address || item.jibun_address || '주소 없음'}
                                    </Text>
                                    <View style={{ backgroundColor: item.owner_name ? '#DBEAFE' : '#F4F4F5', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
                                        <Text style={{ fontSize: fs.xs, color: item.owner_name ? '#1D4ED8' : '#A1A1AA', fontWeight: '600' }}>
                                            {item.owner_name || '소유자 미확인'}
                                        </Text>
                                    </View>
                                </View>
                                {item.owner_address ? (
                                    <Text style={[styles.itemAddress, { fontSize: fs.sm }]} numberOfLines={1}>실거주: {item.owner_address}</Text>
                                ) : null}
                                <Text style={[styles.itemDate, { fontSize: fs.xs }]}>
                                    {new Date(item.viewed_at).toLocaleDateString('ko-KR')} {new Date(item.viewed_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                                </Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.deleteButton} onPress={() => handleListDelete(item.id)}>
                                <Text style={styles.deleteButtonText}>삭제</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                    contentContainerStyle={{ paddingBottom: 100 }}
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

// ===== 고령자 모드 설정 화면 =====

const ElderlyModeScreen = ({ onBack }: { onBack: () => void }) => {
    const { elderlyMode, setElderlyMode, fontSizeLevel, setFontSizeLevel, simpleMode, setSimpleMode } = useMapStore();
    const fs = FONT_SCALE_LEVELS[fontSizeLevel] || FONT_SCALE.normal;
    const ts = elderlyMode ? TOUCH_SIZE.elderly : TOUCH_SIZE.normal;

    const handleElderlyModeToggle = () => {
        hapticFeedback();
        if (elderlyMode) {
            // 어르신 모드 끄기 → 기본값으로
            setElderlyMode(false);
            setFontSizeLevel('normal');
            setSimpleMode(false);
        } else {
            // 어르신 모드 켜기 → 큰 글씨 + 간편 모드
            setElderlyMode(true);
            setFontSizeLevel('extraLarge');
            setSimpleMode(true);
        }
    };

    const fontSizeLevels: { key: FontSizeLevel; label: string; desc: string }[] = [
        { key: 'normal', label: '보통', desc: '기본 크기' },
        { key: 'large', label: '크게', desc: '글자를 크게' },
        { key: 'extraLarge', label: '아주 크게', desc: '최대 크기' },
    ];

    return (
        <View style={styles.subScreenContainer}>
            <View style={styles.subScreenHeader}>
                <TouchableOpacity
                    onPress={() => { hapticFeedback(); onBack(); }}
                    style={styles.backButton}
                    accessibilityLabel="뒤로 가기"
                    accessibilityRole="button"
                >
                    <Text style={[styles.backButtonText, { fontSize: fs.lg }]}>{'← 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={[styles.subScreenTitle, { fontSize: fs['3xl'] }]}>화면 설정</Text>
                <View style={{ width: 50 }} />
            </View>
            <ScrollView style={{ flex: 1, padding: 20 }}>
                {/* 어르신 모드 토글 (최상단) */}
                <View style={{
                    backgroundColor: elderlyMode ? '#E3F2FD' : '#F8F9FA',
                    borderRadius: 16,
                    padding: 20,
                    marginBottom: 20,
                    borderWidth: elderlyMode ? 2.5 : 1.5,
                    borderColor: elderlyMode ? '#1565C0' : '#BFBFBF',
                }}>
                    <Text style={{ fontSize: fs['2xl'], fontWeight: '800', color: '#18181B', marginBottom: 6 }}>
                        어르신 모드
                    </Text>
                    <Text style={{ fontSize: fs.base, color: '#525252', lineHeight: fs.base * 1.5, marginBottom: 16 }}>
                        글자가 커지고, 버튼이 커지고,{'\n'}복잡한 기능이 숨겨집니다.
                    </Text>
                    <TouchableOpacity
                        style={{
                            backgroundColor: elderlyMode ? '#1565C0' : '#E0E0E0',
                            borderRadius: 12,
                            paddingVertical: 20,
                            alignItems: 'center',
                            minHeight: 68,
                            justifyContent: 'center',
                        }}
                        onPress={handleElderlyModeToggle}
                        accessibilityLabel={elderlyMode ? '어르신 모드 끄기' : '어르신 모드 켜기'}
                        accessibilityRole="switch"
                        accessibilityState={{ checked: elderlyMode }}
                    >
                        <Text style={{ color: elderlyMode ? '#fff' : '#333', fontSize: fs.xl, fontWeight: '700' }}>
                            {elderlyMode ? '어르신 모드 켜짐 (터치하여 끄기)' : '어르신 모드 꺼짐 (터치하여 켜기)'}
                        </Text>
                    </TouchableOpacity>
                    {elderlyMode && (
                        <Text style={{ fontSize: fs.sm, color: '#1565C0', marginTop: 10, textAlign: 'center' }}>
                            큰 글씨 + 간편 메뉴 + 큰 버튼이 적용됩니다
                        </Text>
                    )}
                </View>

                {/* 글자 크기 3단계 선택 (어르신 모드 꺼져 있을 때만) */}
                {!elderlyMode && (
                <View style={{
                    backgroundColor: '#F8F9FA',
                    borderRadius: 16,
                    padding: 20,
                    marginBottom: 20,
                    borderWidth: 1.5,
                    borderColor: '#BFBFBF',
                }}>
                    <Text style={{ fontSize: fs['2xl'], fontWeight: '800', color: '#18181B', marginBottom: 6 }}>
                        글자 크기
                    </Text>
                    <Text style={{ fontSize: fs.base, color: '#525252', lineHeight: fs.base * 1.5, marginBottom: 18 }}>
                        원하는 글자 크기를 선택하세요
                    </Text>

                    <View style={{ gap: 12 }}>
                        {fontSizeLevels.map(level => {
                            const isSelected = fontSizeLevel === level.key;
                            const previewFs = FONT_SCALE_LEVELS[level.key];
                            return (
                                <TouchableOpacity
                                    key={level.key}
                                    style={{
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        padding: 18,
                                        borderRadius: 14,
                                        borderWidth: isSelected ? 2.5 : 1.5,
                                        borderColor: isSelected ? '#1565C0' : '#BFBFBF',
                                        backgroundColor: isSelected ? '#E3F2FD' : '#fff',
                                        minHeight: 72,
                                    }}
                                    onPress={() => { hapticFeedback(); setFontSizeLevel(level.key); }}
                                    accessibilityLabel={`글자 크기 ${level.label}`}
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: isSelected }}
                                >
                                    <View style={{
                                        width: 28, height: 28, borderRadius: 14,
                                        borderWidth: 2.5,
                                        borderColor: isSelected ? '#1565C0' : '#BFBFBF',
                                        justifyContent: 'center', alignItems: 'center',
                                        marginRight: 16,
                                    }}>
                                        {isSelected && <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: '#1565C0' }} />}
                                    </View>
                                    <View style={{ flex: 1 }}>
                                        <Text style={{ fontSize: previewFs.lg, fontWeight: '700', color: '#18181B' }}>{level.label}</Text>
                                        <Text style={{ fontSize: previewFs.sm, color: '#525252', marginTop: 2 }}>{level.desc}</Text>
                                    </View>
                                    {isSelected && <Text style={{ fontSize: 22, marginLeft: 8 }}>✅</Text>}
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                </View>
                )}

                {/* 간편 모드 토글 (어르신 모드 꺼져 있을 때만) */}
                {!elderlyMode && (
                <View style={{
                    backgroundColor: simpleMode ? '#E8F5E9' : '#F8F9FA',
                    borderRadius: 16,
                    padding: 20,
                    marginBottom: 20,
                    borderWidth: simpleMode ? 2 : 1.5,
                    borderColor: simpleMode ? '#2E7D32' : '#BFBFBF',
                }}>
                    <Text style={{ fontSize: fs['2xl'], fontWeight: '800', color: '#18181B', marginBottom: 6 }}>
                        간편 모드
                    </Text>
                    <Text style={{ fontSize: fs.base, color: '#525252', lineHeight: fs.base * 1.5, marginBottom: 16 }}>
                        자주 쓰는 기능만 표시합니다.
                    </Text>
                    <TouchableOpacity
                        style={{
                            backgroundColor: simpleMode ? '#C62828' : '#2E7D32',
                            borderRadius: 12,
                            paddingVertical: 18,
                            alignItems: 'center',
                            minHeight: 60,
                            justifyContent: 'center',
                        }}
                        onPress={() => { hapticFeedback(); setSimpleMode(!simpleMode); }}
                        accessibilityLabel={simpleMode ? '간편 모드 끄기' : '간편 모드 켜기'}
                        accessibilityRole="button"
                    >
                        <Text style={{ color: '#fff', fontSize: fs.xl, fontWeight: '700' }}>
                            {simpleMode ? '간편 모드 끄기' : '간편 모드 켜기'}
                        </Text>
                    </TouchableOpacity>
                </View>
                )}

                {/* 미리보기 */}
                <View style={{
                    backgroundColor: '#F8F9FA',
                    borderRadius: 16,
                    padding: 20,
                    marginBottom: 20,
                    borderWidth: 1.5,
                    borderColor: '#BFBFBF',
                }}>
                    <Text style={{ fontSize: fs['2xl'], fontWeight: '800', color: '#18181B', marginBottom: 14 }}>
                        👁️ 미리보기
                    </Text>

                    <TouchableOpacity
                        style={{
                            backgroundColor: '#4A90E2', borderRadius: 12,
                            paddingVertical: ts.padding, minHeight: ts.minHeight,
                            alignItems: 'center', justifyContent: 'center', marginBottom: 14,
                        }}
                    >
                        <Text style={{ color: '#fff', fontSize: fs.lg, fontWeight: '700' }}>버튼 예시</Text>
                    </TouchableOpacity>

                    <Text style={{ fontSize: fs.lg, color: '#18181B', fontWeight: '700', marginBottom: 6 }}>
                        건물 이름 (제목)
                    </Text>
                    <Text style={{ fontSize: fs.base, color: '#525252', marginBottom: 4 }}>
                        서울특별시 강남구 역삼동 123-4
                    </Text>
                    <Text style={{ fontSize: fs.sm, color: '#737373' }}>
                        거리: 350m | 공장
                    </Text>
                </View>

                {/* 온보딩 다시 보기 */}
                <TouchableOpacity
                    style={{
                        backgroundColor: '#F4F4F5', borderRadius: 12, padding: 18,
                        alignItems: 'center', borderWidth: 1.5, borderColor: '#BFBFBF',
                        marginBottom: 30, minHeight: 56, justifyContent: 'center',
                    }}
                    onPress={() => {
                        hapticFeedback();
                        AsyncStorage.removeItem(ONBOARDING_DONE_KEY).catch(() => {});
                        Alert.alert('안내', '앱을 다시 시작하면 사용법 안내가 표시됩니다.');
                    }}
                >
                    <Text style={{ fontSize: fs.lg, color: '#333', fontWeight: '600' }}>📖 사용법 안내 다시 보기</Text>
                </TouchableOpacity>
            </ScrollView>
        </View>
    );
};

// ===== PlaceManagementModal =====

const PLACE_STATUSES: PlaceStatus[] = ['미접촉', '접촉', '미팅예정', '성사', '거절'];
const PLACE_STATUS_COLORS: Record<PlaceStatus, string> = {
    '미접촉': '#9E9E9E',
    '접촉':   '#2196F3',
    '미팅예정': '#FF9800',
    '성사':   '#4CAF50',
    '거절':   '#F44336',
};

interface PlaceManagementModalProps {
    visible: boolean;
    onClose: () => void;
    latitude: number;
    longitude: number;
    address: string;
}

const PlaceManagementModal = ({ visible, onClose, latitude, longitude, address }: PlaceManagementModalProps) => {
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const [record, setRecord] = useState<PlaceRecord | null>(null);
    const [status, setStatus] = useState<PlaceStatus>('미접촉');
    const [memo, setMemo] = useState('');
    const [statusDate, setStatusDate] = useState('');
    const [showDatePicker, setShowDatePicker] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        if (!visible) return;
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
                setStatusDate(r.status_date || '');
            } else {
                setRecord(null);
                setStatus('미접촉');
                setMemo('');
                setStatusDate('');
            }
        })();
    }, [visible, latitude, longitude]);

    const showDateForStatus = ['미팅예정', '성사', '거절'].includes(status);

    const handleSave = async () => {
        setIsSaving(true);
        try {
            const today = new Date().toISOString().split('T')[0];
            const payload = {
                lat: latitude,
                lng: longitude,
                road_address: address,
                jibun_address: null,
                status,
                status_date: showDateForStatus ? (statusDate || today) : null,
                memo: memo || null,
                updated_at: new Date().toISOString(),
            };
            if (record) {
                await supabase.from('places').update(payload).eq('id', record.id);
            } else {
                await supabase.from('places').insert([{ ...payload, created_at: new Date().toISOString() }]);
            }
            Alert.alert('저장 완료', '장소 관리 정보가 저장되었습니다.');
            onClose();
        } catch (e) {
            Alert.alert('저장 실패', '저장 중 오류가 발생했습니다.');
        }
        setIsSaving(false);
    };

    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
            <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' }}>
                <View style={{ backgroundColor: '#FAFAFA', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, maxHeight: '80%' }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
                        <Text style={{ flex: 1, fontSize: fs.lg, fontWeight: '700', color: '#222' }}>장소관리</Text>
                        <TouchableOpacity onPress={onClose} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 12, backgroundColor: '#F4F4F5', borderRadius: 8, borderWidth: 1, borderColor: '#BFBFBF', minHeight: 44 }}>
                            <Text style={{ fontSize: 18, color: '#333', fontWeight: '700' }}>✕ </Text>
                            <Text style={{ fontSize: 15, color: '#333', fontWeight: '600' }}>닫기</Text>
                        </TouchableOpacity>
                    </View>
                    <Text style={{ fontSize: fs.sm, color: '#525252', marginBottom: 14 }} numberOfLines={2}>{address}</Text>

                    {/* 상태 선택 */}
                    <Text style={{ fontSize: fs.sm, fontWeight: '600', color: '#444', marginBottom: 8 }}>영업 상태</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
                        {PLACE_STATUSES.map(s => (
                            <TouchableOpacity
                                key={s}
                                onPress={() => setStatus(s)}
                                style={{
                                    paddingHorizontal: 14,
                                    paddingVertical: 8,
                                    borderRadius: 20,
                                    backgroundColor: status === s ? PLACE_STATUS_COLORS[s] : '#eee',
                                }}
                            >
                                <Text style={{ fontSize: fs.sm, color: status === s ? '#fff' : '#555', fontWeight: status === s ? '700' : '400' }}>{s}</Text>
                            </TouchableOpacity>
                        ))}
                    </View>

                    {/* 날짜 입력 (조건부) */}
                    {showDateForStatus && (
                        <View style={{ marginBottom: 14 }}>
                            <Text style={{ fontSize: fs.sm, fontWeight: '600', color: '#444', marginBottom: 8 }}>날짜</Text>
                            <TouchableOpacity
                                style={{ borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12 }}
                                onPress={() => setShowDatePicker(true)}
                            >
                                <Text style={{ fontSize: fs.base, color: statusDate ? '#222' : '#aaa' }}>
                                    {statusDate || '날짜 선택 (오늘: ' + new Date().toISOString().split('T')[0] + ')'}
                                </Text>
                            </TouchableOpacity>
                            {showDatePicker && (
                                <View style={{ marginTop: 8 }}>
                                    <TextInput
                                        style={{ borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 10, fontSize: fs.base }}
                                        value={statusDate}
                                        onChangeText={setStatusDate}
                                        placeholder="YYYY-MM-DD"
                                        keyboardType="numeric"
                                        maxLength={10}
                                        onBlur={() => setShowDatePicker(false)}
                                        autoFocus
                                    />
                                </View>
                            )}
                        </View>
                    )}

                    {/* 메모 */}
                    <Text style={{ fontSize: fs.sm, fontWeight: '600', color: '#444', marginBottom: 8 }}>메모</Text>
                    <TextInput
                        style={{ borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12, fontSize: fs.base, minHeight: 80, textAlignVertical: 'top', marginBottom: 16 }}
                        value={memo}
                        onChangeText={setMemo}
                        placeholder="영업 메모를 입력하세요..."
                        multiline
                        numberOfLines={3}
                    />

                    <TouchableOpacity
                        style={{ backgroundColor: '#18181B', borderRadius: 8, paddingVertical: 12, alignItems: 'center' }}
                        onPress={handleSave}
                        disabled={isSaving}
                    >
                        {isSaving ? <ActivityIndicator color="#FAFAFA" /> : <Text style={{ color: '#FAFAFA', fontSize: fs.base, fontWeight: '600' }}>저장</Text>}
                    </TouchableOpacity>
                </View>
            </View>
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
                    <Text style={[styles.backButtonText, { fontSize: fs.lg }]}>{'← 뒤로'}</Text>
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
                        <Text style={{ fontSize: fs.base, color: '#525252' }}>이 날의 영업 기록이 없습니다.</Text>
                    </View>
                ) : (
                    <>
                        {/* 요약 카드 */}
                        <View style={[cardStyle, { flexDirection: 'row', gap: 12 }]}>
                            <View style={{ flex: 1, alignItems: 'center', borderRightWidth: 1, borderRightColor: '#E4E4E7' }}>
                                <Text style={{ fontSize: fs.xs, color: '#525252', marginBottom: 4 }}>총 이동거리</Text>
                                <Text style={{ fontSize: fs['2xl'], fontWeight: '700', color: '#18181B' }}>{totalKm.toFixed(1)} km</Text>
                            </View>
                            <View style={{ flex: 1, alignItems: 'center' }}>
                                <Text style={{ fontSize: fs.xs, color: '#525252', marginBottom: 4 }}>방문 기록</Text>
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
                                            <Text style={{ fontSize: fs.xs, color: '#525252' }}>{new Date(l.visited_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</Text>
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
                                        <Text style={{ fontSize: fs.xs, color: '#525252' }}>{new Date(l.visited_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}{l.distance_from_prev_km > 0 ? `  +${l.distance_from_prev_km.toFixed(2)}km` : ''}</Text>
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

// ===== ScheduledRemindersScreen =====

const ScheduledRemindersScreen = ({ onBack, onOpenProperty }: {
    onBack: () => void;
    onOpenProperty?: (propertyId: string) => void;
}) => {
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const [items, setItems] = useState<Array<{ property_id: string; building_name: string | null; road_address: string | null; sales_status: SalesStatus; next_contact_date: string }>>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const { data } = await supabase
                    .from('properties')
                    .select('property_id, building_name, road_address, sales_status, next_contact_date')
                    .in('sales_status', ['보류', '대기중'])
                    .not('next_contact_date', 'is', null)
                    .order('next_contact_date', { ascending: true });
                setItems((data || []) as typeof items);
            } catch (_) {}
            setIsLoading(false);
        })();
    }, []);

    const now = new Date();

    return (
        <View style={styles.subScreenContainer}>
            <View style={styles.subScreenHeader}>
                <TouchableOpacity onPress={onBack} style={styles.backButton}>
                    <Text style={styles.backButtonText}>{'<'} 뒤로</Text>
                </TouchableOpacity>
                <Text style={styles.subScreenTitle}>재방문/연락 예정 목록</Text>
                <View style={{ width: 60 }} />
            </View>
            {isLoading ? (
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                    <ActivityIndicator size="large" color="#18181B" />
                </View>
            ) : items.length === 0 ? (
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 }}>
                    <Text style={{ fontSize: fs.base, color: '#525252', textAlign: 'center' }}>예정된 알림이 없습니다.</Text>
                </View>
            ) : (
                <ScrollView contentContainerStyle={{ padding: 16 }}>
                    {items.map(item => {
                        const contactDate = new Date(item.next_contact_date);
                        const isOverdue = contactDate < now;
                        const diffDays = Math.ceil((contactDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
                        const label = item.sales_status === '보류' ? '재방문' : '연락';
                        const name = item.building_name || item.road_address || item.property_id;
                        return (
                            <TouchableOpacity
                                key={item.property_id}
                                style={{
                                    backgroundColor: '#fff',
                                    borderRadius: 8,
                                    padding: 14,
                                    marginBottom: 10,
                                    borderWidth: 1,
                                    borderColor: isOverdue ? '#FCA5A5' : '#E4E4E7',
                                    borderLeftWidth: 4,
                                    borderLeftColor: isOverdue ? '#EF4444' : item.sales_status === '보류' ? '#F59E0B' : '#3B82F6',
                                }}
                                onPress={() => onOpenProperty && onOpenProperty(item.property_id)}
                                activeOpacity={0.7}
                            >
                                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                                    <View style={{ backgroundColor: item.sales_status === '보류' ? '#FEF3C7' : '#EFF6FF', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, marginRight: 8 }}>
                                        <Text style={{ fontSize: fs.xs, color: item.sales_status === '보류' ? '#92400E' : '#1D4ED8', fontWeight: '600' }}>{item.sales_status}</Text>
                                    </View>
                                    <Text style={{ fontSize: fs.sm, color: '#18181B', fontWeight: '500', flex: 1 }} numberOfLines={1}>{name}</Text>
                                </View>
                                <Text style={{ fontSize: fs.sm, color: isOverdue ? '#EF4444' : '#52525B' }}>
                                    {label} 예정일: {contactDate.toLocaleDateString('ko-KR')}
                                    {isOverdue ? ' (기한 초과)' : diffDays === 0 ? ' (오늘)' : ` (D-${diffDays})`}
                                </Text>
                            </TouchableOpacity>
                        );
                    })}
                </ScrollView>
            )}
        </View>
    );
};

// ===== HomeScreen (대시보드) =====

interface MoabogiCardsProps {
    onMoveToMap: () => void;
    onShowRegistry: () => void;
    onShowFavorites: () => void;
    onShowPlaces: () => void;
    onShowNotifications: () => void;
    onShowReminders: () => void;
    onShowActivity: () => void;
    onShowStats: () => void;
    onShowBuildings: () => void;
}

interface HomeScreenProps {
    onSelectRegion: () => void;
    onSelectSearch: () => void;
    onSelectMap: () => void;
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

const MoabogiCards = ({ onMoveToMap, onShowRegistry, onShowFavorites, onShowPlaces, onShowNotifications, onShowReminders, onShowActivity, onShowStats, onShowBuildings }: MoabogiCardsProps) => {
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const [registryCount, setRegistryCount] = useState<number | null>(null);
    const [favoritesCount, setFavoritesCount] = useState<number | null>(null);
    const [placeCounts, setPlaceCounts] = useState<Record<PlaceStatus, number>>({
        '미접촉': 0, '접촉': 0, '미팅예정': 0, '성사': 0, '거절': 0,
    });
    const [remindersCount, setRemindersCount] = useState<number | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [unreadCount, setUnreadCount] = useState(0);
    const [todayActivityKm, setTodayActivityKm] = useState(0);
    const [todayVisitCount, setTodayVisitCount] = useState(0);
    const [urgentItems, setUrgentItems] = useState<Array<{
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
                const [regRes, favJson, placesRes, improvRes, lastCountStr, unread, remindersRes, todayLogs, urgentRes] = await Promise.all([
                    supabase.from('registry_views').select('id', { count: 'exact', head: true }),
                    AsyncStorage.getItem(FAVORITE_PLACES_KEY),
                    supabase.from('places').select('status'),
                    supabase.from('improvements').select('id', { count: 'exact', head: true }),
                    AsyncStorage.getItem(LAST_IMPROVEMENTS_COUNT_KEY),
                    getUnreadNotificationCount(),
                    supabase.from('properties').select('property_id', { count: 'exact', head: true })
                        .in('sales_status', ['보류', '대기중'])
                        .not('next_contact_date', 'is', null),
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
                setRegistryCount(regRes.count ?? 0);
                const favs: unknown[] = favJson ? JSON.parse(favJson) : [];
                setFavoritesCount(favs.length);
                const counts: Record<PlaceStatus, number> = { '미접촉': 0, '접촉': 0, '미팅예정': 0, '성사': 0, '거절': 0 };
                (placesRes.data || []).forEach((row: { status: string }) => {
                    const s = row.status as PlaceStatus;
                    if (s in counts) counts[s]++;
                });
                setPlaceCounts(counts);
                setUnreadCount(unread);
                setRemindersCount(remindersRes.count ?? 0);
                const logs = todayLogs.data || [];
                setTodayActivityKm(logs.reduce((s: number, l: { distance_from_prev_km: number }) => s + (l.distance_from_prev_km || 0), 0));
                setTodayVisitCount(logs.length);
                setUrgentItems((urgentRes.data || []) as typeof urgentItems);
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

    const cardStyle = { backgroundColor: '#fff', borderRadius: 8, padding: 16, marginBottom: 8, flexDirection: 'row' as const, alignItems: 'center' as const, borderWidth: 1, borderColor: '#E4E4E7' };

    const now = new Date();

    return (
        <View style={{ backgroundColor: '#FAFAFA' }}>
            <View style={{ marginBottom: 16, marginTop: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                    <Text style={{ fontSize: fs['2xl'], fontWeight: '600', color: '#18181B', letterSpacing: -0.5 }}>모아보기</Text>
                    <TouchableOpacity
                        onPress={onShowNotifications}
                        style={{ backgroundColor: unreadCount > 0 ? '#EF4444' : '#E4E4E7', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 }}
                    >
                        <Text style={{ color: unreadCount > 0 ? '#fff' : '#71717A', fontSize: fs.xs, fontWeight: '700' }}>
                            알림 {unreadCount}
                        </Text>
                    </TouchableOpacity>
                </View>
                <Text style={{ fontSize: fs.sm, color: '#525252' }}>오늘도 좋은 영업 하세요</Text>
            </View>

            {/* 빠른 액션 버튼 */}
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
                {[
                    { label: '🗺️ 지도', onPress: onMoveToMap, color: '#18181B' },
                    { label: '📊 통계', onPress: onShowStats, color: '#1565C0' },
                    { label: '🏭 주변건물', onPress: onShowBuildings, color: '#065F46' },
                    { label: '📅 연락예정', onPress: onShowReminders, color: remindersCount && remindersCount > 0 ? '#D97706' : '#52525B' },
                ].map(btn => (
                    <TouchableOpacity
                        key={btn.label}
                        onPress={btn.onPress}
                        style={{ flex: 1, backgroundColor: btn.color, borderRadius: 8, paddingVertical: 11, alignItems: 'center' }}
                    >
                        <Text style={{ color: '#fff', fontSize: fs.xs, fontWeight: '600', textAlign: 'center' }}>{btn.label}</Text>
                    </TouchableOpacity>
                ))}
            </View>

            {/* D-Day 긴급 할일 카드 */}
            {urgentItems.length > 0 && (
                <View style={{ backgroundColor: '#fff', borderRadius: 8, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#FCA5A5', borderLeftWidth: 4, borderLeftColor: '#EF4444' }}>
                    <Text style={{ fontSize: fs.sm, fontWeight: '700', color: '#EF4444', marginBottom: 10 }}>
                        오늘 할일 — 연락/재방문 D-3 이내 ({urgentItems.length}건)
                    </Text>
                    {urgentItems.map(item => {
                        const contactDate = new Date(item.next_contact_date);
                        const diffMs = contactDate.getTime() - now.getTime();
                        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
                        const isOverdue = diffDays < 0;
                        const isToday = diffDays === 0;
                        const dLabel = isOverdue ? `D+${Math.abs(diffDays)}` : isToday ? 'D-Day' : `D-${diffDays}`;
                        const dColor = isOverdue ? '#EF4444' : isToday ? '#F59E0B' : '#3B82F6';
                        const name = item.building_name || item.road_address || item.property_id;
                        return (
                            <View key={item.property_id} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: '#F4F4F5' }}>
                                <View style={{ backgroundColor: dColor, borderRadius: 4, paddingHorizontal: 7, paddingVertical: 2, marginRight: 10, minWidth: 44, alignItems: 'center' }}>
                                    <Text style={{ fontSize: fs.xs, color: '#fff', fontWeight: '700' }}>{dLabel}</Text>
                                </View>
                                <View style={{ flex: 1 }}>
                                    <Text style={{ fontSize: fs.sm, color: '#18181B', fontWeight: '500' }} numberOfLines={1}>{name}</Text>
                                    <Text style={{ fontSize: fs.xs, color: '#525252' }}>
                                        {item.sales_status} · {contactDate.toLocaleDateString('ko-KR')}
                                    </Text>
                                </View>
                            </View>
                        );
                    })}
                    <TouchableOpacity onPress={onShowReminders} style={{ marginTop: 2 }}>
                        <Text style={{ fontSize: fs.xs, color: '#3B82F6', fontWeight: '600', textAlign: 'right' }}>전체 보기 ›</Text>
                    </TouchableOpacity>
                </View>
            )}

            {isLoading ? (
                <HomeSkeleton fs={fs} />
            ) : (
                <>
                    {/* 등기부등본 발급 내역 */}
                    <TouchableOpacity
                        style={[cardStyle, registryCount === 0 && { opacity: 0.45 }]}
                        onPress={registryCount !== 0 ? onShowRegistry : undefined}
                        disabled={registryCount === 0}
                    >
                        <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: fs.sm, fontWeight: '500', color: '#525252' }}>등기부등본 발급 내역</Text>
                            <Text style={{ fontSize: fs['2xl'], fontWeight: '600', color: '#18181B', marginTop: 4 }}>
                                {registryCount ?? 0}건
                            </Text>
                        </View>
                        {registryCount !== 0 && <Text style={{ fontSize: 20, color: '#737373' }}>›</Text>}
                    </TouchableOpacity>

                    {/* 즐겨찾는 장소 */}
                    <TouchableOpacity
                        style={[cardStyle, favoritesCount === 0 && { opacity: 0.45 }]}
                        onPress={favoritesCount !== 0 ? onShowFavorites : undefined}
                        disabled={favoritesCount === 0}
                    >
                        <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: fs.sm, fontWeight: '500', color: '#525252' }}>즐겨찾는 장소</Text>
                            <Text style={{ fontSize: fs['2xl'], fontWeight: '600', color: '#18181B', marginTop: 4 }}>
                                {favoritesCount ?? 0}건
                            </Text>
                        </View>
                        {favoritesCount !== 0 && <Text style={{ fontSize: 20, color: '#737373' }}>›</Text>}
                    </TouchableOpacity>

                    {/* 장소관리 현황 */}
                    <View style={{ backgroundColor: '#fff', borderRadius: 8, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: '#E4E4E7', opacity: totalPlaces === 0 ? 0.45 : 1 }}>
                        <TouchableOpacity
                            style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}
                            onPress={totalPlaces !== 0 ? onShowPlaces : undefined}
                            disabled={totalPlaces === 0}
                        >
                            <Text style={{ fontSize: fs.sm, fontWeight: '500', color: '#525252', flex: 1 }}>장소관리 현황</Text>
                            <Text style={{ fontSize: fs.lg, fontWeight: '600', color: '#18181B', marginRight: 6 }}>{totalPlaces}건</Text>
                            {totalPlaces !== 0 && <Text style={{ fontSize: 20, color: '#737373' }}>›</Text>}
                        </TouchableOpacity>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                            {PLACE_STATUSES.filter(s => s !== '미접촉').map(s => (
                                <View key={s} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#F4F4F5', borderRadius: 4, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: '#E4E4E7' }}>
                                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: PLACE_STATUS_COLORS[s], marginRight: 6 }} />
                                    <Text style={{ fontSize: fs.xs, color: '#52525B' }}>{s} {placeCounts[s]}건</Text>
                                </View>
                            ))}
                        </View>
                        <TouchableOpacity
                            style={{ marginTop: 14, backgroundColor: '#18181B', borderRadius: 6, paddingVertical: 10, alignItems: 'center' }}
                            onPress={onMoveToMap}
                        >
                            <Text style={{ color: '#FAFAFA', fontSize: fs.sm, fontWeight: '500' }}>지도에서 장소관리</Text>
                        </TouchableOpacity>
                    </View>

                    {/* 재방문/연락 예정 알림 */}
                    <TouchableOpacity
                        style={[cardStyle, (remindersCount === 0) && { opacity: 0.45 }, { borderLeftWidth: 4, borderLeftColor: remindersCount !== null && remindersCount > 0 ? '#F59E0B' : '#E4E4E7' }]}
                        onPress={remindersCount !== 0 ? onShowReminders : undefined}
                        disabled={remindersCount === 0}
                    >
                        <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: fs.sm, fontWeight: '500', color: '#525252' }}>재방문 / 연락 예정</Text>
                            <Text style={{ fontSize: fs['2xl'], fontWeight: '600', color: '#18181B', marginTop: 4 }}>
                                {remindersCount ?? 0}건
                            </Text>
                            {remindersCount !== null && remindersCount > 0 && (
                                <Text style={{ fontSize: fs.xs, color: '#F59E0B', marginTop: 2 }}>보류 · 대기중 매물 알림 예약됨</Text>
                            )}
                        </View>
                        {remindersCount !== 0 && <Text style={{ fontSize: 20, color: '#737373' }}>›</Text>}
                    </TouchableOpacity>

                    {/* 오늘 영업 이동거리 */}
                    <TouchableOpacity
                        style={[cardStyle, { borderLeftWidth: 4, borderLeftColor: todayVisitCount > 0 ? '#EAB308' : '#E4E4E7' }]}
                        onPress={onShowActivity}
                    >
                        <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: fs.sm, fontWeight: '500', color: '#525252' }}>오늘 영업 이동거리</Text>
                            <Text style={{ fontSize: fs['2xl'], fontWeight: '600', color: '#18181B', marginTop: 4 }}>
                                {todayActivityKm.toFixed(1)} km
                            </Text>
                            <Text style={{ fontSize: fs.xs, color: '#525252', marginTop: 2 }}>방문 {todayVisitCount}곳 기록됨</Text>
                        </View>
                        <Text style={{ fontSize: 20, color: '#737373' }}>›</Text>
                    </TouchableOpacity>
                </>
            )}
        </View>
    );
};

// ===== HomeScreen (조회조건 선택) =====

const HomeScreen = ({ onSelectRegion, onSelectSearch, onSelectMap }: HomeScreenProps) => {
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;

    const cards = [
        {
            title: '지역으로 선택',
            desc: '시·군·구 지역을 선택하여 해당 구역 건물을 조회합니다.',
            onPress: onSelectRegion,
        },
        {
            title: '검색하여 선택',
            desc: '주소 또는 장소명으로 검색하여 원하는 위치를 찾습니다.',
            onPress: onSelectSearch,
        },
        {
            title: '지도에서 선택',
            desc: '지도를 직접 탐색하며 건물을 확인하고 선택합니다.',
            onPress: onSelectMap,
        },
    ];

    return (
        <View style={{ flex: 1, backgroundColor: '#FAFAFA' }}>
            <View style={{ paddingHorizontal: 16, paddingTop: 28, paddingBottom: 4 }}>
                <Text style={{ fontSize: fs['2xl'], fontWeight: '700', color: '#18181B', letterSpacing: -0.5 }}>조회조건 선택</Text>
                <Text style={{ fontSize: fs.sm, color: '#525252', marginTop: 4 }}>원하는 방법으로 건물을 조회하세요</Text>
            </View>
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 130 }}>
                {cards.map(card => (
                    <TouchableOpacity
                        key={card.title}
                        onPress={card.onPress}
                        style={{
                            backgroundColor: '#fff',
                            borderRadius: 12,
                            padding: 20,
                            marginBottom: 12,
                            borderWidth: 1,
                            borderColor: '#E4E4E7',
                            flexDirection: 'row',
                            alignItems: 'center',
                            elevation: 2,
                            shadowColor: '#000',
                            shadowOpacity: 0.05,
                            shadowOffset: { width: 0, height: 1 },
                            shadowRadius: 4,
                        }}
                        accessibilityRole="button"
                    >
                        <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: fs.lg, fontWeight: '700', color: '#18181B', marginBottom: 6 }}>{card.title}</Text>
                            <Text style={{ fontSize: fs.sm, color: '#525252', lineHeight: 20 }}>{card.desc}</Text>
                        </View>
                        <Text style={{ fontSize: 22, color: '#737373', marginLeft: 12 }}>›</Text>
                    </TouchableOpacity>
                ))}
            </ScrollView>
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

type PlaceCategoryType = 'building' | 'commercial' | 'industrial';

interface RegionSelectScreenProps {
    onBack: () => void;
    onComplete: (province: string, city: string, category: PlaceCategoryType, lat: number, lng: number) => void;
}

const RegionSelectScreen = React.memo(({ onBack, onComplete }: RegionSelectScreenProps) => {
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const ts = elderlyMode ? TOUCH_SIZE.elderly : TOUCH_SIZE.normal;

    type Step = 'province' | 'city' | 'category' | 'result';
    const [step, setStep] = useState<Step>('province');
    const [selectedProvince, setSelectedProvince] = useState<string | null>(null);
    const [selectedCity, setSelectedCity] = useState<string | null>(null);
    const [selectedCategory, setSelectedCategory] = useState<PlaceCategoryType | null>(null);
    const [cityPage, setCityPage] = useState(0);

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

    const prevProvinceRef = useRef<string | null>(null);

    const handleProvinceSelect = useCallback((name: string) => {
        setSelectedProvince(prev => {
            const next = prev === name ? null : name;
            // 도가 변경되면 시군구 선택 초기화
            if (next !== prev) {
                setSelectedCity(null);
            }
            return next;
        });
    }, []);

    const handleNextFromProvince = useCallback(() => {
        if (!selectedProvince) return;
        // 같은 도면 재로드 안함 (이전 선택 유지)
        if (prevProvinceRef.current !== selectedProvince || cities.length === 0) {
            loadCities(selectedProvince);
            prevProvinceRef.current = selectedProvince;
        }
        setStep('city');
    }, [selectedProvince, cities.length, loadCities]);

    const handleCitySelect = useCallback((name: string) => {
        setSelectedCity(prev => prev === name ? null : name);
    }, []);

    const handleNextFromCity = useCallback(() => {
        if (!selectedProvince || !selectedCity) return;
        setStep('category');
    }, [selectedProvince, selectedCity]);

    const handleCategorySelect = useCallback((cat: PlaceCategoryType) => {
        setSelectedCategory(prev => prev === cat ? null : cat);
    }, []);

    const handleNextFromCategory = useCallback(() => {
        if (!selectedProvince || !selectedCity || !selectedCategory) return;
        setStep('result');
    }, [selectedProvince, selectedCity, selectedCategory]);

    // result 스텝: 검색 건수 및 목록 조회
    const [resultCount, setResultCount] = useState<number | null>(null);
    const [resultItems, setResultItems] = useState<VWorldPlaceItem[]>([]);
    const [resultLoading, setResultLoading] = useState(false);
    const [resultListOpen, setResultListOpen] = useState(false);

    useEffect(() => {
        if (step !== 'result' || !selectedProvince || !selectedCity || !selectedCategory) return;
        let cancelled = false;
        setResultLoading(true);
        setResultCount(null);
        setResultItems([]);
        setResultListOpen(false);

        (async () => {
            try {
                const cityData = cities.find(c => c.name === selectedCity);
                if (!cityData) return;

                const SEARCH_RADIUS = 0.05;
                const bbox = `${cityData.lng - SEARCH_RADIUS},${cityData.lat - SEARCH_RADIUS},${cityData.lng + SEARCH_RADIUS},${cityData.lat + SEARCH_RADIUS}`;

                const keywordMap: Record<PlaceCategoryType, string[]> = {
                    building: ['아파트', '주택', '다세대'],
                    commercial: ['상가', '오피스텔', '빌딩'],
                    industrial: ['공장', '창고', '물류'],
                };
                const keywords = keywordMap[selectedCategory] || [];

                const responses = await Promise.all(
                    keywords.map(keyword =>
                        fetch(`https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=20&page=1&query=${encodeURIComponent(keyword)}&type=place&format=json&errorformat=json&bbox=${bbox}&key=${VWORLD_API_KEY}`)
                            .then(r => r.json())
                            .catch(() => null)
                    )
                );

                if (cancelled) return;
                let total = 0;
                const allItems: VWorldPlaceItem[] = [];
                const seenIds = new Set<string>();

                responses.forEach((json: VWorldSearchResponse | null) => {
                    if (!json || json.response.status === 'NOT_FOUND' || !json.response.result) return;
                    if (json.response.record?.total) {
                        total += parseInt(json.response.record.total, 10);
                    }
                    json.response.result.items.forEach((item: VWorldPlaceItem) => {
                        if (!seenIds.has(item.id)) {
                            seenIds.add(item.id);
                            allItems.push(item);
                        }
                    });
                });

                if (total === 0) total = allItems.length;
                setResultCount(total);
                setResultItems(allItems);
            } catch {
                if (!cancelled) { setResultCount(0); setResultItems([]); }
            } finally {
                if (!cancelled) setResultLoading(false);
            }
        })();

        return () => { cancelled = true; };
    }, [step, selectedProvince, selectedCity, selectedCategory, cities]);

    const handleConfirmResult = useCallback(() => {
        if (!selectedProvince || !selectedCity || !selectedCategory) return;
        const cityData = cities.find(c => c.name === selectedCity);
        if (cityData) {
            onComplete(selectedProvince, selectedCity, selectedCategory, cityData.lat, cityData.lng);
        }
    }, [selectedProvince, selectedCity, selectedCategory, cities, onComplete]);

    const handleBack = useCallback(() => {
        if (step === 'result') {
            setStep('category');
        } else if (step === 'category') {
            setStep('city');
        } else if (step === 'city') {
            setStep('province');
        } else {
            onBack();
        }
        // 모든 선택값 유지 (초기화하지 않음)
    }, [step, onBack]);

    // 페이징 계산
    const totalPages = Math.ceil(cities.length / CITIES_PER_PAGE);
    const pagedCities = cities.slice(cityPage * CITIES_PER_PAGE, (cityPage + 1) * CITIES_PER_PAGE);

    const selectedProvinceShort = provinces.find(p => p.name === selectedProvince)?.short || '';

    return (
        <View style={{ flex: 1, backgroundColor: '#FAFAFA' }}>
            {/* 헤더 */}
            <View style={{
                flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12,
                backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#E4E4E7',
            }}>
                <TouchableOpacity onPress={handleBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Text style={{ fontSize: fs.lg, color: '#18181B', fontWeight: '600' }}>{'← 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={{ fontSize: fs.lg, fontWeight: '700', color: '#18181B' }}>지역으로 선택</Text>
                <View style={{ width: 50 }} />
            </View>

            {/* 스텝 인디케이터 (4단계 게이지바) */}
            {(() => {
                const currentStep = step === 'province' ? 0 : step === 'city' ? 1 : step === 'category' ? 2 : 3;
                const totalSteps = 4;
                const stepLabels = ['지역', '시군구', '상세', '결과'];

                return (
                    <View style={{ paddingHorizontal: 24, paddingTop: 20, paddingBottom: 16 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            {Array.from({ length: totalSteps }).map((_, i) => {
                                const isCompleted = i < currentStep;
                                const isActive = i === currentStep;
                                const isPending = i > currentStep;

                                return (
                                    <React.Fragment key={i}>
                                        {/* 동그란 뱃지 */}
                                        <View style={{
                                            width: 32, height: 32, borderRadius: 16,
                                            backgroundColor: isCompleted ? '#18181B' : isActive ? '#18181B' : '#E4E4E7',
                                            alignItems: 'center', justifyContent: 'center',
                                            borderWidth: isActive ? 3 : 0,
                                            borderColor: isActive ? '#A1A1AA' : 'transparent',
                                        }}>
                                            {isCompleted ? (
                                                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>{'✓'}</Text>
                                            ) : (
                                                <Text style={{
                                                    color: isActive ? '#fff' : '#A1A1AA',
                                                    fontSize: 14, fontWeight: '700',
                                                }}>{i + 1}</Text>
                                            )}
                                        </View>

                                        {/* 게이지바 (마지막 스텝 뒤에는 없음) */}
                                        {i < totalSteps - 1 && (
                                            <View style={{
                                                flex: 1, height: 4, backgroundColor: '#E4E4E7',
                                                borderRadius: 2, marginHorizontal: 6, overflow: 'hidden',
                                            }}>
                                                <View style={{
                                                    height: '100%', borderRadius: 2,
                                                    backgroundColor: '#18181B',
                                                    width: isCompleted ? '100%' : isActive ? '50%' : '0%',
                                                }} />
                                            </View>
                                        )}
                                    </React.Fragment>
                                );
                            })}
                        </View>
                        {/* 스텝 라벨 */}
                        <View style={{ flexDirection: 'row', marginTop: 8 }}>
                            {stepLabels.map((label, i) => {
                                const isActive = i === currentStep;
                                const isCompleted = i < currentStep;
                                return (
                                    <View key={label} style={{ flex: i < totalSteps - 1 ? 1 : 0, alignItems: i === 0 ? 'flex-start' : i === totalSteps - 1 ? 'flex-end' : 'center' }}>
                                        <Text style={{
                                            fontSize: 14, fontWeight: isActive || isCompleted ? '700' : '500',
                                            color: isActive ? '#18181B' : isCompleted ? '#3F3F46' : '#A1A1AA',
                                        }}>{label}</Text>
                                    </View>
                                );
                            })}
                        </View>
                    </View>
                );
            })()}

            {/* 메인 콘텐츠 */}
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 120 }}>
                {step === 'province' && (
                    <>
                        {/* Step 1: 지역 선택 */}
                        <Text style={{ fontSize: fs['2xl'], fontWeight: '700', color: '#18181B', marginBottom: 6, letterSpacing: -0.5 }}>
                            지역을 선택해주세요
                        </Text>
                        <Text style={{ fontSize: fs.sm, color: '#525252', marginBottom: 24 }}>
                            조회하려는 도 또는 광역시를 선택하세요
                        </Text>

                        {loadingProvinces ? (
                            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                                <ActivityIndicator size="large" color="#18181B" />
                                <Text style={{ marginTop: 12, color: '#525252', fontSize: fs.sm }}>지역 정보 로딩 중...</Text>
                            </View>
                        ) : (
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                                {provinces.map(p => {
                                    const isSelected = selectedProvince === p.name;
                                    return (
                                        <TouchableOpacity
                                            key={p.name}
                                            onPress={() => handleProvinceSelect(p.name)}
                                            style={{
                                                paddingHorizontal: 18,
                                                paddingVertical: 12,
                                                borderRadius: 20,
                                                borderWidth: 1.5,
                                                borderColor: isSelected ? '#18181B' : '#D4D4D8',
                                                backgroundColor: isSelected ? '#18181B' : '#fff',
                                                elevation: isSelected ? 3 : 1,
                                                shadowColor: '#000',
                                                shadowOpacity: isSelected ? 0.15 : 0.05,
                                                shadowOffset: { width: 0, height: 1 },
                                                shadowRadius: isSelected ? 4 : 2,
                                            }}
                                            accessibilityRole="radio"
                                            accessibilityState={{ checked: isSelected }}
                                            accessibilityLabel={p.name}
                                        >
                                            <Text style={{
                                                fontSize: fs.base, fontWeight: isSelected ? '700' : '500',
                                                color: isSelected ? '#FAFAFA' : '#3F3F46',
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
                                marginTop: 24, backgroundColor: '#F4F4F5', borderRadius: 10, padding: 14,
                                flexDirection: 'row', alignItems: 'center',
                            }}>
                                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#18181B', marginRight: 10 }} />
                                <Text style={{ fontSize: fs.base, color: '#18181B', fontWeight: '600' }}>
                                    선택: {selectedProvince}
                                </Text>
                            </View>
                        )}
                    </>
                )}

                {step === 'city' && (
                    <>
                        {/* Step 2: 상세 지역 선택 */}
                        <Text style={{ fontSize: fs['2xl'], fontWeight: '700', color: '#18181B', marginBottom: 6, letterSpacing: -0.5 }}>
                            상세 지역을 선택해주세요
                        </Text>
                        <Text style={{ fontSize: fs.sm, color: '#525252', marginBottom: 8 }}>
                            {selectedProvinceShort} 내 시·군·구를 선택하세요
                        </Text>

                        {/* 선택된 도 표시 */}
                        <View style={{
                            backgroundColor: '#18181B', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 6,
                            alignSelf: 'flex-start', marginBottom: 20,
                        }}>
                            <Text style={{ color: '#FAFAFA', fontSize: fs.sm, fontWeight: '600' }}>{selectedProvinceShort}</Text>
                        </View>

                        {loadingCities ? (
                            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                                <ActivityIndicator size="large" color="#18181B" />
                                <Text style={{ marginTop: 12, color: '#525252', fontSize: fs.sm }}>시·군·구 로딩 중...</Text>
                            </View>
                        ) : cities.length === 0 ? (
                            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                                <Text style={{ color: '#525252', fontSize: fs.base }}>등록된 시·군·구가 없습니다</Text>
                            </View>
                        ) : (
                            <>
                                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                                    {pagedCities.map(c => {
                                        const isSelected = selectedCity === c.name;
                                        return (
                                            <TouchableOpacity
                                                key={c.name}
                                                onPress={() => handleCitySelect(c.name)}
                                                style={{
                                                    paddingHorizontal: 16,
                                                    paddingVertical: 11,
                                                    borderRadius: 10,
                                                    borderWidth: 1.5,
                                                    borderColor: isSelected ? '#18181B' : '#D4D4D8',
                                                    backgroundColor: isSelected ? '#18181B' : '#fff',
                                                    minWidth: 80,
                                                    alignItems: 'center',
                                                    elevation: isSelected ? 3 : 1,
                                                    shadowColor: '#000',
                                                    shadowOpacity: isSelected ? 0.15 : 0.05,
                                                    shadowOffset: { width: 0, height: 1 },
                                                    shadowRadius: isSelected ? 4 : 2,
                                                }}
                                                accessibilityRole="radio"
                                                accessibilityState={{ checked: isSelected }}
                                                accessibilityLabel={c.name}
                                            >
                                                <Text style={{
                                                    fontSize: fs.base, fontWeight: isSelected ? '700' : '500',
                                                    color: isSelected ? '#FAFAFA' : '#3F3F46',
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
                                        marginTop: 20, gap: 16,
                                    }}>
                                        <TouchableOpacity
                                            onPress={() => setCityPage(prev => Math.max(0, prev - 1))}
                                            disabled={cityPage === 0}
                                            style={{
                                                paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8,
                                                backgroundColor: cityPage === 0 ? '#F4F4F5' : '#18181B',
                                            }}
                                        >
                                            <Text style={{ color: cityPage === 0 ? '#A1A1AA' : '#FAFAFA', fontSize: fs.sm, fontWeight: '600' }}>이전</Text>
                                        </TouchableOpacity>
                                        <Text style={{ fontSize: fs.sm, color: '#525252', fontWeight: '600' }}>
                                            {cityPage + 1} / {totalPages}
                                        </Text>
                                        <TouchableOpacity
                                            onPress={() => setCityPage(prev => Math.min(totalPages - 1, prev + 1))}
                                            disabled={cityPage >= totalPages - 1}
                                            style={{
                                                paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8,
                                                backgroundColor: cityPage >= totalPages - 1 ? '#F4F4F5' : '#18181B',
                                            }}
                                        >
                                            <Text style={{ color: cityPage >= totalPages - 1 ? '#A1A1AA' : '#FAFAFA', fontSize: fs.sm, fontWeight: '600' }}>다음</Text>
                                        </TouchableOpacity>
                                    </View>
                                )}
                            </>
                        )}

                        {selectedCity && (
                            <View style={{
                                marginTop: 20, backgroundColor: '#F4F4F5', borderRadius: 10, padding: 14,
                                flexDirection: 'row', alignItems: 'center',
                            }}>
                                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#18181B', marginRight: 10 }} />
                                <Text style={{ fontSize: fs.base, color: '#18181B', fontWeight: '600' }}>
                                    선택: {selectedProvinceShort} {'>'} {selectedCity}
                                </Text>
                            </View>
                        )}
                    </>
                )}

                {step === 'category' && (
                    <>
                        {/* Step 3: 장소 유형 선택 */}
                        <Text style={{ fontSize: fs['2xl'], fontWeight: '700', color: '#18181B', marginBottom: 6, letterSpacing: -0.5 }}>
                            어떤 장소를 찾으시나요?
                        </Text>
                        <Text style={{ fontSize: fs.sm, color: '#525252', marginBottom: 8 }}>
                            조회할 건물 유형을 선택하세요
                        </Text>

                        {/* 선택된 지역 요약 */}
                        <View style={{ flexDirection: 'row', gap: 6, marginBottom: 24 }}>
                            <View style={{
                                backgroundColor: '#18181B', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 5,
                            }}>
                                <Text style={{ color: '#FAFAFA', fontSize: fs.xs, fontWeight: '600' }}>{selectedProvinceShort}</Text>
                            </View>
                            <View style={{
                                backgroundColor: '#3F3F46', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 5,
                            }}>
                                <Text style={{ color: '#FAFAFA', fontSize: fs.xs, fontWeight: '600' }}>{selectedCity}</Text>
                            </View>
                        </View>

                        {/* 카테고리 카드 3개 */}
                        <View style={{ gap: 12 }}>
                            {([
                                { key: 'building' as PlaceCategoryType, label: '일반건축물', desc: '주택, 아파트, 다세대 등 일반 건축물' },
                                { key: 'commercial' as PlaceCategoryType, label: '상가', desc: '상가, 오피스텔, 업무용 빌딩 등' },
                                { key: 'industrial' as PlaceCategoryType, label: '공단', desc: '공장, 창고, 물류센터 등 산업시설' },
                            ]).map(cat => {
                                const isSelected = selectedCategory === cat.key;
                                const iconColor = isSelected ? '#FAFAFA' : '#3F3F46';
                                const iconBg = isSelected ? '#27272A' : '#F4F4F5';
                                return (
                                    <TouchableOpacity
                                        key={cat.key}
                                        onPress={() => handleCategorySelect(cat.key)}
                                        style={{
                                            backgroundColor: isSelected ? '#18181B' : '#fff',
                                            borderRadius: 16,
                                            padding: 24,
                                            borderWidth: 2,
                                            borderColor: isSelected ? '#18181B' : '#E4E4E7',
                                            alignItems: 'center',
                                            elevation: isSelected ? 6 : 2,
                                            shadowColor: '#000',
                                            shadowOpacity: isSelected ? 0.2 : 0.06,
                                            shadowOffset: { width: 0, height: isSelected ? 4 : 1 },
                                            shadowRadius: isSelected ? 8 : 3,
                                        }}
                                        accessibilityRole="radio"
                                        accessibilityState={{ checked: isSelected }}
                                        accessibilityLabel={cat.label}
                                    >
                                        {/* 단색 아이콘 */}
                                        <View style={{
                                            width: 56, height: 56, borderRadius: 16,
                                            backgroundColor: iconBg,
                                            alignItems: 'center', justifyContent: 'center',
                                            marginBottom: 12,
                                        }}>
                                            {cat.key === 'building' && (
                                                /* 집 아이콘: 삼각형 지붕 + 사각형 몸체 */
                                                <View style={{ alignItems: 'center' }}>
                                                    <View style={{
                                                        width: 0, height: 0,
                                                        borderLeftWidth: 14, borderRightWidth: 14, borderBottomWidth: 12,
                                                        borderLeftColor: 'transparent', borderRightColor: 'transparent',
                                                        borderBottomColor: iconColor,
                                                        marginBottom: -1,
                                                    }} />
                                                    <View style={{
                                                        width: 20, height: 14,
                                                        backgroundColor: iconColor, borderBottomLeftRadius: 2, borderBottomRightRadius: 2,
                                                    }} />
                                                </View>
                                            )}
                                            {cat.key === 'commercial' && (
                                                /* 빌딩 아이콘: 세로 직사각형 + 창문 점 */
                                                <View style={{ alignItems: 'center' }}>
                                                    <View style={{
                                                        width: 22, height: 28, backgroundColor: iconColor,
                                                        borderRadius: 2, justifyContent: 'center', alignItems: 'center', paddingTop: 4,
                                                    }}>
                                                        {[0, 1, 2].map(row => (
                                                            <View key={row} style={{ flexDirection: 'row', gap: 4, marginBottom: 3 }}>
                                                                <View style={{ width: 4, height: 3, backgroundColor: iconBg, borderRadius: 0.5 }} />
                                                                <View style={{ width: 4, height: 3, backgroundColor: iconBg, borderRadius: 0.5 }} />
                                                            </View>
                                                        ))}
                                                    </View>
                                                </View>
                                            )}
                                            {cat.key === 'industrial' && (
                                                /* 공장 아이콘: 톱니 지붕 2개 + 사각형 몸체 + 굴뚝 */
                                                <View style={{ alignItems: 'center' }}>
                                                    <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
                                                        {/* 굴뚝 */}
                                                        <View style={{ width: 4, height: 10, backgroundColor: iconColor, marginRight: 1, borderTopLeftRadius: 1, borderTopRightRadius: 1 }} />
                                                        {/* 톱니 지붕 1 */}
                                                        <View style={{
                                                            width: 0, height: 0,
                                                            borderLeftWidth: 8, borderRightWidth: 8, borderBottomWidth: 10,
                                                            borderLeftColor: 'transparent', borderRightColor: 'transparent',
                                                            borderBottomColor: iconColor,
                                                        }} />
                                                        {/* 톱니 지붕 2 */}
                                                        <View style={{
                                                            width: 0, height: 0,
                                                            borderLeftWidth: 8, borderRightWidth: 8, borderBottomWidth: 10,
                                                            borderLeftColor: 'transparent', borderRightColor: 'transparent',
                                                            borderBottomColor: iconColor,
                                                            marginLeft: -2,
                                                        }} />
                                                    </View>
                                                    {/* 몸체 */}
                                                    <View style={{
                                                        width: 28, height: 10, backgroundColor: iconColor,
                                                        borderBottomLeftRadius: 2, borderBottomRightRadius: 2, marginTop: -1,
                                                    }} />
                                                </View>
                                            )}
                                        </View>
                                        {/* 텍스트 */}
                                        <Text style={{
                                            fontSize: fs.lg, fontWeight: '700',
                                            color: isSelected ? '#FAFAFA' : '#18181B',
                                            marginBottom: 4,
                                        }}>
                                            {cat.label}
                                        </Text>
                                        <Text style={{
                                            fontSize: fs.sm,
                                            color: isSelected ? '#A1A1AA' : '#71717A',
                                            textAlign: 'center',
                                        }}>
                                            {cat.desc}
                                        </Text>
                                        {/* 선택 체크 표시 */}
                                        {isSelected && (
                                            <View style={{
                                                position: 'absolute', top: 12, right: 12,
                                                width: 24, height: 24, borderRadius: 12,
                                                backgroundColor: '#FAFAFA',
                                                alignItems: 'center', justifyContent: 'center',
                                            }}>
                                                <Text style={{ color: '#18181B', fontSize: 14, fontWeight: '700' }}>{'✓'}</Text>
                                            </View>
                                        )}
                                    </TouchableOpacity>
                                );
                            })}
                        </View>
                    </>
                )}

                {step === 'result' && (
                    <>
                        {/* Step 4: 검색 결과 확인 */}
                        <Text style={{ fontSize: fs['2xl'], fontWeight: '700', color: '#18181B', marginBottom: 6, letterSpacing: -0.5 }}>
                            검색 조건 확인
                        </Text>
                        <Text style={{ fontSize: fs.sm, color: '#525252', marginBottom: 24 }}>
                            선택하신 내용이 맞는지 확인해주세요
                        </Text>

                        {/* 요약 카드 */}
                        <View style={{
                            backgroundColor: '#fff', borderRadius: 20, padding: 28,
                            borderWidth: 1.5, borderColor: '#E4E4E7',
                            elevation: 3, shadowColor: '#000', shadowOpacity: 0.08,
                            shadowOffset: { width: 0, height: 2 }, shadowRadius: 8,
                            marginBottom: 20,
                        }}>
                            {/* 지역 */}
                            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
                                <View style={{
                                    width: 44, height: 44, borderRadius: 12,
                                    backgroundColor: '#F4F4F5', alignItems: 'center', justifyContent: 'center',
                                    marginRight: 14,
                                }}>
                                    {/* 핀 아이콘 */}
                                    <View style={{ alignItems: 'center' }}>
                                        <View style={{
                                            width: 16, height: 16, borderRadius: 8,
                                            borderWidth: 3, borderColor: '#3F3F46', backgroundColor: 'transparent',
                                        }} />
                                        <View style={{
                                            width: 0, height: 0, marginTop: -2,
                                            borderLeftWidth: 5, borderRightWidth: 5, borderTopWidth: 8,
                                            borderLeftColor: 'transparent', borderRightColor: 'transparent',
                                            borderTopColor: '#3F3F46',
                                        }} />
                                    </View>
                                </View>
                                <View style={{ flex: 1 }}>
                                    <Text style={{ fontSize: fs.xs, color: '#737373', fontWeight: '500', marginBottom: 2 }}>지역</Text>
                                    <Text style={{ fontSize: fs.xl, fontWeight: '700', color: '#18181B' }}>
                                        {selectedProvinceShort} {selectedCity}
                                    </Text>
                                </View>
                            </View>

                            {/* 구분선 */}
                            <View style={{ height: 1, backgroundColor: '#F4F4F5', marginBottom: 20 }} />

                            {/* 카테고리 */}
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <View style={{
                                    width: 44, height: 44, borderRadius: 12,
                                    backgroundColor: '#F4F4F5', alignItems: 'center', justifyContent: 'center',
                                    marginRight: 14,
                                }}>
                                    {/* 카테고리별 아이콘 */}
                                    {selectedCategory === 'building' && (
                                        <View style={{ alignItems: 'center' }}>
                                            <View style={{
                                                width: 0, height: 0,
                                                borderLeftWidth: 10, borderRightWidth: 10, borderBottomWidth: 9,
                                                borderLeftColor: 'transparent', borderRightColor: 'transparent',
                                                borderBottomColor: '#3F3F46', marginBottom: -1,
                                            }} />
                                            <View style={{ width: 14, height: 10, backgroundColor: '#3F3F46', borderBottomLeftRadius: 2, borderBottomRightRadius: 2 }} />
                                        </View>
                                    )}
                                    {selectedCategory === 'commercial' && (
                                        <View style={{
                                            width: 16, height: 22, backgroundColor: '#3F3F46',
                                            borderRadius: 2, justifyContent: 'center', alignItems: 'center', paddingTop: 3,
                                        }}>
                                            {[0, 1, 2].map(row => (
                                                <View key={row} style={{ flexDirection: 'row', gap: 3, marginBottom: 2 }}>
                                                    <View style={{ width: 3, height: 2, backgroundColor: '#F4F4F5', borderRadius: 0.5 }} />
                                                    <View style={{ width: 3, height: 2, backgroundColor: '#F4F4F5', borderRadius: 0.5 }} />
                                                </View>
                                            ))}
                                        </View>
                                    )}
                                    {selectedCategory === 'industrial' && (
                                        <View style={{ alignItems: 'center' }}>
                                            <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
                                                <View style={{ width: 3, height: 7, backgroundColor: '#3F3F46', marginRight: 1, borderTopLeftRadius: 1, borderTopRightRadius: 1 }} />
                                                <View style={{
                                                    width: 0, height: 0,
                                                    borderLeftWidth: 6, borderRightWidth: 6, borderBottomWidth: 7,
                                                    borderLeftColor: 'transparent', borderRightColor: 'transparent',
                                                    borderBottomColor: '#3F3F46',
                                                }} />
                                                <View style={{
                                                    width: 0, height: 0, marginLeft: -1,
                                                    borderLeftWidth: 6, borderRightWidth: 6, borderBottomWidth: 7,
                                                    borderLeftColor: 'transparent', borderRightColor: 'transparent',
                                                    borderBottomColor: '#3F3F46',
                                                }} />
                                            </View>
                                            <View style={{ width: 22, height: 7, backgroundColor: '#3F3F46', borderBottomLeftRadius: 2, borderBottomRightRadius: 2, marginTop: -1 }} />
                                        </View>
                                    )}
                                </View>
                                <View style={{ flex: 1 }}>
                                    <Text style={{ fontSize: fs.xs, color: '#737373', fontWeight: '500', marginBottom: 2 }}>건물 유형</Text>
                                    <Text style={{ fontSize: fs.xl, fontWeight: '700', color: '#18181B' }}>
                                        {selectedCategory === 'building' ? '일반건축물' : selectedCategory === 'commercial' ? '상가' : '공단'}
                                    </Text>
                                </View>
                            </View>
                        </View>

                        {/* 검색 건수 (탭하면 목록 토글) */}
                        <TouchableOpacity
                            onPress={() => { if (!resultLoading && resultItems.length > 0) setResultListOpen(prev => !prev); }}
                            activeOpacity={resultItems.length > 0 ? 0.7 : 1}
                            style={{
                                backgroundColor: '#18181B', borderRadius: 16, padding: 20,
                                alignItems: 'center', marginBottom: resultListOpen ? 0 : 24,
                                borderBottomLeftRadius: resultListOpen ? 0 : 16,
                                borderBottomRightRadius: resultListOpen ? 0 : 16,
                            }}
                        >
                            {resultLoading ? (
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                                    <ActivityIndicator color="#FAFAFA" size="small" />
                                    <Text style={{ fontSize: fs.lg, color: '#737373', fontWeight: '600' }}>
                                        검색 중입니다...
                                    </Text>
                                </View>
                            ) : (
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                    <Text style={{ fontSize: fs.xl, fontWeight: '700', color: '#FAFAFA' }}>
                                        {resultCount !== null && resultCount > 0
                                            ? `총 ${resultCount}건 찾았습니다`
                                            : '검색 준비 완료'}
                                    </Text>
                                    {resultItems.length > 0 && (
                                        <Text style={{ fontSize: 14, color: '#737373', fontWeight: '600' }}>
                                            {resultListOpen ? '▲' : '▼'}
                                        </Text>
                                    )}
                                </View>
                            )}
                        </TouchableOpacity>

                        {/* 검색 결과 목록 */}
                        {resultListOpen && resultItems.length > 0 && (
                            <View style={{
                                backgroundColor: '#fff', borderBottomLeftRadius: 16, borderBottomRightRadius: 16,
                                borderWidth: 1, borderTopWidth: 0, borderColor: '#E4E4E7',
                                marginBottom: 24, overflow: 'hidden',
                            }}>
                                {resultItems.map((item, idx) => (
                                    <TouchableOpacity
                                        key={item.id}
                                        onPress={() => {
                                            if (!selectedProvince || !selectedCity || !selectedCategory) return;
                                            const lat = parseFloat(item.point.y);
                                            const lng = parseFloat(item.point.x);
                                            if (!isNaN(lat) && !isNaN(lng)) {
                                                onComplete(selectedProvince, selectedCity, selectedCategory, lat, lng);
                                            }
                                        }}
                                        style={{
                                            flexDirection: 'row', alignItems: 'center',
                                            paddingHorizontal: 16, paddingVertical: 14,
                                            borderTopWidth: idx > 0 ? 1 : 0, borderTopColor: '#F4F4F5',
                                        }}
                                        accessibilityRole="button"
                                        accessibilityLabel={`${item.title} 지도에서 보기`}
                                    >
                                        {/* 지도 아이콘 */}
                                        <View style={{
                                            width: 36, height: 36, borderRadius: 10,
                                            backgroundColor: '#F4F4F5', alignItems: 'center', justifyContent: 'center',
                                            marginRight: 12,
                                        }}>
                                            <View style={{ alignItems: 'center' }}>
                                                <View style={{
                                                    width: 10, height: 10, borderRadius: 5,
                                                    borderWidth: 2, borderColor: '#18181B', backgroundColor: 'transparent',
                                                }} />
                                                <View style={{
                                                    width: 0, height: 0, marginTop: -1,
                                                    borderLeftWidth: 3, borderRightWidth: 3, borderTopWidth: 5,
                                                    borderLeftColor: 'transparent', borderRightColor: 'transparent',
                                                    borderTopColor: '#18181B',
                                                }} />
                                            </View>
                                        </View>
                                        {/* 텍스트 */}
                                        <View style={{ flex: 1 }}>
                                            <Text style={{ fontSize: fs.md, fontWeight: '600', color: '#18181B', marginBottom: 2 }} numberOfLines={1}>
                                                {item.title}
                                            </Text>
                                            <Text style={{ fontSize: fs.sm, color: '#525252' }} numberOfLines={1}>
                                                {item.address.road || item.address.parcel || '주소 정보 없음'}
                                            </Text>
                                        </View>
                                        {/* 화살표 */}
                                        <Text style={{ fontSize: 16, color: '#737373', marginLeft: 8 }}>{'>'}</Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                        )}

                        {/* 지도에서 보기 버튼 */}
                        <TouchableOpacity
                            onPress={handleConfirmResult}
                            style={{
                                backgroundColor: '#18181B', borderRadius: 16,
                                paddingVertical: 20, alignItems: 'center',
                                elevation: 6, shadowColor: '#000', shadowOpacity: 0.2,
                                shadowOffset: { width: 0, height: 4 }, shadowRadius: 10,
                                marginBottom: 16,
                            }}
                            accessibilityRole="button"
                            accessibilityLabel="지도에서 보기"
                        >
                            <Text style={{ fontSize: fs.xl, fontWeight: '700', color: '#FAFAFA' }}>
                                지도에서 보기
                            </Text>
                        </TouchableOpacity>

                        {/* 다시 선택하기 */}
                        <TouchableOpacity
                            onPress={() => setStep('province')}
                            style={{ alignItems: 'center', paddingVertical: 12 }}
                            accessibilityRole="button"
                            accessibilityLabel="처음부터 다시 선택하기"
                        >
                            <Text style={{ fontSize: fs.md, color: '#525252', fontWeight: '500' }}>
                                처음부터 다시 선택하기
                            </Text>
                        </TouchableOpacity>
                    </>
                )}
            </ScrollView>

            {/* 하단 이전/다음 버튼 (result 스텝에서는 자체 버튼 사용하므로 숨김) */}
            {step !== 'result' && (
                <View style={{
                    position: 'absolute', bottom: 0, left: 0, right: 0,
                    paddingHorizontal: 20, paddingVertical: 16, paddingBottom: 32,
                    backgroundColor: '#FAFAFA',
                    borderTopWidth: 1, borderTopColor: '#E4E4E7',
                    flexDirection: 'row', gap: 12,
                }}>
                    {/* 이전 버튼 */}
                    <TouchableOpacity
                        onPress={handleBack}
                        style={{
                            flex: 1,
                            backgroundColor: '#fff',
                            borderRadius: 12, paddingVertical: 16, alignItems: 'center',
                            borderWidth: 1.5, borderColor: '#D4D4D8',
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="이전 단계로"
                    >
                        <Text style={{ fontSize: fs.lg, fontWeight: '700', color: '#3F3F46' }}>이전</Text>
                    </TouchableOpacity>

                    {/* 다음 버튼 */}
                    {(() => {
                        const nextHandler = step === 'province' ? handleNextFromProvince : step === 'city' ? handleNextFromCity : handleNextFromCategory;
                        const isEnabled = step === 'province' ? !!selectedProvince : step === 'city' ? !!selectedCity : !!selectedCategory;
                        return (
                            <TouchableOpacity
                                onPress={nextHandler}
                                disabled={!isEnabled}
                                style={{
                                    flex: 2,
                                    backgroundColor: isEnabled ? '#18181B' : '#D4D4D8',
                                    borderRadius: 12, paddingVertical: 16, alignItems: 'center',
                                    elevation: isEnabled ? 4 : 0,
                                    shadowColor: '#000',
                                    shadowOpacity: 0.15,
                                    shadowOffset: { width: 0, height: 2 },
                                    shadowRadius: 6,
                                }}
                                accessibilityRole="button"
                                accessibilityLabel="다음 단계로"
                            >
                                <Text style={{
                                    fontSize: fs.lg, fontWeight: '700',
                                    color: isEnabled ? '#FAFAFA' : '#A1A1AA',
                                }}>
                                    다음
                                </Text>
                            </TouchableOpacity>
                        );
                    })()}
                </View>
            )}
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
                    <Text style={[styles.backButtonText, { fontSize: fs.lg }]}>{'← 뒤로'}</Text>
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
                        <Text style={{ fontSize: fs.sm, color: '#525252', marginLeft: 12 }}>{place.status_date}</Text>
                    )}
                </View>

                {/* 상세 정보 행 */}
                {infoRows.map(({ label, value }) => value ? (
                    <View key={label} style={{ backgroundColor: '#fff', borderRadius: 8, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#E4E4E7' }}>
                        <Text style={{ fontSize: fs.xs, color: '#525252', marginBottom: 4 }}>{label}</Text>
                        <Text style={{ fontSize: fs.base, color: '#18181B', fontWeight: '500' }}>{value}</Text>
                    </View>
                ) : null)}
            </ScrollView>
        </View>
    );
};

// ===== PlaceManagementListScreen =====

const PLACE_LIST_PAGE_SIZE = 20;

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

    const loadPlaces = async (reset: boolean, currentSearch: string, currentStatus: PlaceStatus | null, currentPage: number) => {
        if (isLoading) return;
        setIsLoading(true);
        try {
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

    if (selectedPlace) {
        return (
            <PlaceDetailScreen
                place={selectedPlace}
                onBack={() => setSelectedPlace(null)}
                onMoveToMap={onMoveToMap}
            />
        );
    }

    return (
        <View style={styles.subScreenContainer}>
            <View style={styles.subScreenHeader}>
                <TouchableOpacity onPress={onBack} style={styles.backButton}>
                    <Text style={[styles.backButtonText, { fontSize: fs.lg }]}>{'← 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={[styles.subScreenTitle, { fontSize: fs['2xl'] }]}>장소관리 목록</Text>
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

            {/* 카테고리 필터 탭 */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16, marginBottom: 10, gap: 6 }}>
                <TouchableOpacity
                    onPress={() => setSelectedStatus(null)}
                    style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: selectedStatus === null ? '#18181B' : '#F4F4F5', borderWidth: 1, borderColor: selectedStatus === null ? '#18181B' : '#E4E4E7' }}
                >
                    <Text style={{ fontSize: fs.sm, color: selectedStatus === null ? '#FAFAFA' : '#52525B', fontWeight: '600' }}>전체</Text>
                </TouchableOpacity>
                {PLACE_STATUSES.map(s => (
                    <TouchableOpacity
                        key={s}
                        onPress={() => setSelectedStatus(selectedStatus === s ? null : s)}
                        style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: selectedStatus === s ? PLACE_STATUS_COLORS[s] : '#F4F4F5', borderWidth: 1, borderColor: selectedStatus === s ? PLACE_STATUS_COLORS[s] : '#E4E4E7', flexDirection: 'row', alignItems: 'center', gap: 4 }}
                    >
                        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: selectedStatus === s ? '#fff' : PLACE_STATUS_COLORS[s] }} />
                        <Text style={{ fontSize: fs.sm, color: selectedStatus === s ? '#fff' : '#52525B', fontWeight: '600' }}>{s}</Text>
                    </TouchableOpacity>
                ))}
            </View>

            {/* 목록 */}
            <FlatList
                data={places}
                keyExtractor={(item) => item.id}
                removeClippedSubviews={true}
                maxToRenderPerBatch={10}
                windowSize={5}
                renderItem={({ item }) => (
                    <TouchableOpacity
                        style={{ backgroundColor: '#fff', marginHorizontal: 16, marginBottom: 8, borderRadius: 8, padding: 14, borderWidth: 1, borderColor: '#E4E4E7' }}
                        onPress={() => setSelectedPlace(item)}
                    >
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: PLACE_STATUS_COLORS[item.status], marginRight: 6 }} />
                            <Text style={{ fontSize: fs.sm, color: PLACE_STATUS_COLORS[item.status], fontWeight: '600' }}>{item.status}</Text>
                            {item.status_date && (
                                <Text style={{ fontSize: fs.xs, color: '#737373', marginLeft: 8 }}>{item.status_date}</Text>
                            )}
                            <Text style={{ fontSize: fs.xs, color: '#737373', marginLeft: 'auto' }}>
                                {item.created_at ? new Date(item.created_at).toLocaleDateString('ko-KR') : ''}
                            </Text>
                        </View>
                        <Text style={{ fontSize: fs.base, color: '#18181B', fontWeight: '500', marginBottom: 2 }} numberOfLines={1}>
                            {item.road_address || item.jibun_address || `${item.lat.toFixed(6)}, ${item.lng.toFixed(6)}`}
                        </Text>
                        {item.memo ? (
                            <Text style={{ fontSize: fs.sm, color: '#525252' }} numberOfLines={1}>{item.memo}</Text>
                        ) : null}
                    </TouchableOpacity>
                )}
                onEndReached={handleLoadMore}
                onEndReachedThreshold={0.3}
                ListFooterComponent={isLoading ? <ActivityIndicator style={{ margin: 16 }} /> : null}
                ListEmptyComponent={!isLoading ? (
                    <View style={styles.emptyContainer}>
                        <Text style={[styles.emptyText, { fontSize: fs.base }]}>장소관리 데이터가 없습니다.</Text>
                    </View>
                ) : null}
            />
        </View>
    );
};

// ===== NotificationListScreen =====

const NOTIF_TYPE_LABELS: Record<AppNotification['type'], string> = {
    improvement: '개선사항',
    favorite: '즐겨찾기',
    registry: '등기열람',
};
const NOTIF_TYPE_COLORS: Record<AppNotification['type'], string> = {
    improvement: '#7C3AED',
    favorite: '#D97706',
    registry: '#1D4ED8',
};

const NotificationListScreen = ({ onBack }: { onBack: () => void }) => {
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const [notifications, setNotifications] = useState<AppNotification[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const json = await AsyncStorage.getItem(NOTIFICATIONS_KEY);
                setNotifications(json ? JSON.parse(json) : []);
                await markAllNotificationsRead();
            } catch {}
            setIsLoading(false);
        })();
    }, []);

    const handleClearAll = () => {
        Alert.alert('알림 전체 삭제', '모든 알림을 삭제하시겠습니까?', [
            { text: '취소', style: 'cancel' },
            {
                text: '삭제', style: 'destructive', onPress: async () => {
                    await AsyncStorage.removeItem(NOTIFICATIONS_KEY);
                    setNotifications([]);
                }
            },
        ]);
    };

    return (
        <View style={styles.subScreenContainer}>
            <View style={styles.subScreenHeader}>
                <TouchableOpacity onPress={onBack} style={styles.backButton}>
                    <Text style={[styles.backButtonText, { fontSize: fs.lg }]}>{'← 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={[styles.subScreenTitle, { fontSize: fs['2xl'] }]}>알림</Text>
                {notifications.length > 0 ? (
                    <TouchableOpacity onPress={handleClearAll} style={{ paddingHorizontal: 10, paddingVertical: 6, marginRight: 4 }}>
                        <Text style={{ fontSize: fs.xs, color: '#EF4444', fontWeight: '600' }}>전체삭제</Text>
                    </TouchableOpacity>
                ) : <View style={{ width: 50 }} />}
            </View>

            {isLoading ? (
                <View style={styles.loadingContainer}><ActivityIndicator /></View>
            ) : (
                <FlatList
                    data={notifications}
                    keyExtractor={(item) => item.id}
                    renderItem={({ item }) => (
                        <View style={{ backgroundColor: '#fff', marginHorizontal: 16, marginBottom: 8, borderRadius: 8, padding: 14, borderWidth: 1, borderColor: '#E4E4E7' }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6, gap: 8 }}>
                                <View style={{ backgroundColor: NOTIF_TYPE_COLORS[item.type], borderRadius: 4, paddingHorizontal: 7, paddingVertical: 2 }}>
                                    <Text style={{ fontSize: fs.xs, color: '#fff', fontWeight: '700' }}>{NOTIF_TYPE_LABELS[item.type]}</Text>
                                </View>
                                <Text style={{ fontSize: fs.xs, color: '#737373' }}>
                                    {new Date(item.timestamp).toLocaleDateString('ko-KR')} {new Date(item.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                                </Text>
                            </View>
                            <Text style={{ fontSize: fs.base, color: '#18181B', fontWeight: '500' }}>{item.message}</Text>
                        </View>
                    )}
                    contentContainerStyle={{ paddingTop: 8, paddingBottom: 100 }}
                    ListEmptyComponent={
                        <View style={styles.emptyContainer}>
                            <Text style={[styles.emptyText, { fontSize: fs.base }]}>알림이 없습니다.</Text>
                        </View>
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
                            <Text style={{ fontSize: fs.xs, color: '#636363', marginRight: 8 }}>v{selectedItem.version}</Text>
                        )}
                        <Text style={{ fontSize: fs.xs, color: '#636363' }}>
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
                    <Text style={{ textAlign: 'center', color: '#737373', marginTop: 40, fontSize: fs.base }}>등록된 내용이 없습니다.</Text>
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
                                <Text style={{ fontSize: fs.xs, color: '#636363', marginRight: 6 }}>v{item.version}</Text>
                            )}
                            <Text style={{ fontSize: fs.xs, color: '#737373', marginLeft: 'auto' }}>
                                {new Date(item.created_at).toLocaleDateString('ko-KR')}
                            </Text>
                        </View>
                        <Text style={{ fontSize: fs.base, fontWeight: '600', color: '#222', marginBottom: 4 }}>{item.title}</Text>
                        <Text style={{ fontSize: fs.sm, color: '#525252' }} numberOfLines={1}>{item.content}</Text>
                    </TouchableOpacity>
                )}
            />
        </View>
    );
};

// ===== MoreScreen =====

const MoreScreen = ({ onMoveToMap, onMoveToMapWithLocation, onOpenProperty }: {
    onMoveToMap: () => void;
    onMoveToMapWithLocation: (lat: number, lng: number, address: string) => void;
    onOpenProperty: (propertyId: string) => void;
}) => {
    const { elderlyMode, tilkoBalance, setTilkoBalance, fontSizeLevel, simpleMode, balanceError } = useMapStore();
    const fs = FONT_SCALE_LEVELS[fontSizeLevel] || FONT_SCALE.normal;
    const ts = elderlyMode ? TOUCH_SIZE.elderly : TOUCH_SIZE.normal;
    type MoreView = 'menu' | 'recent' | 'favorites' | 'registry' | 'settings' | 'improvements' | 'stats' | 'notifications' | 'reminders' | 'activity' | 'buildings' | 'places';
    const [currentView, setCurrentView] = useState<MoreView>('menu');
    const [balanceLoading, setBalanceLoading] = useState(false);

    const handleRefreshBalance = useCallback(async () => {
        setBalanceLoading(true);
        const bal = await fetchTilkoBalanceFromDB();
        if (bal !== null) {
            setTilkoBalance(bal);
            useMapStore.getState().setBalanceError(false);
        } else {
            useMapStore.getState().setBalanceError(true);
        }
        setBalanceLoading(false);
    }, [setTilkoBalance]);
    if (currentView === 'recent') return <RecentPlacesScreen onBack={() => setCurrentView('menu')} onMoveToMap={onMoveToMap} />;
    if (currentView === 'favorites') return <FavoritePlacesScreen onBack={() => setCurrentView('menu')} onMoveToMap={onMoveToMap} />;
    if (currentView === 'registry') return <RegistryHistoryScreen onBack={() => setCurrentView('menu')} />;
    if (currentView === 'settings') return <ElderlyModeScreen onBack={() => setCurrentView('menu')} />;
    if (currentView === 'improvements') return <ImprovementsScreen onBack={() => setCurrentView('menu')} />;
    if (currentView === 'stats') return <SalesStatsScreen onBack={() => setCurrentView('menu')} />;
    if (currentView === 'notifications') return <NotificationListScreen onBack={() => setCurrentView('menu')} />;
    if (currentView === 'activity') return <SalesActivityScreen onBack={() => setCurrentView('menu')} />;
    if (currentView === 'buildings') return <BuildingListScreen onMoveToMap={onMoveToMap} />;
    if (currentView === 'places') return <PlaceManagementListScreen onBack={() => setCurrentView('menu')} onMoveToMap={onMoveToMapWithLocation} />;
    if (currentView === 'reminders') return (
        <ScheduledRemindersScreen
            onBack={() => setCurrentView('menu')}
            onOpenProperty={onOpenProperty}
        />
    );
    return (
        <ScrollView style={{ flex: 1, backgroundColor: '#FAFAFA' }} contentContainerStyle={{ padding: 16, paddingBottom: 130, gap: 8 }}>
            {/* 모아보기 섹션 */}
            <Text style={{ fontSize: fs.lg, fontWeight: '700', color: '#18181B', marginTop: 8, marginBottom: 4 }}>모아보기</Text>
            <MoabogiCards
                onMoveToMap={onMoveToMap}
                onShowRegistry={() => setCurrentView('registry')}
                onShowFavorites={() => setCurrentView('favorites')}
                onShowPlaces={() => setCurrentView('places')}
                onShowNotifications={() => setCurrentView('notifications')}
                onShowReminders={() => setCurrentView('reminders')}
                onShowActivity={() => setCurrentView('activity')}
                onShowStats={() => setCurrentView('stats')}
                onShowBuildings={() => setCurrentView('buildings')}
            />
            <View style={{ height: 1, backgroundColor: '#E4E4E7', marginVertical: 4 }} />
            {/* 틸코 잔액 카드 - 간편 모드에서 숨김 */}
            {!simpleMode && <View style={{
                backgroundColor: tilkoBalance !== null && tilkoBalance < 5 ? '#FEF2F2' : '#F4F4F5',
                borderRadius: 12, marginHorizontal: 16, marginBottom: 8,
                padding: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                borderWidth: tilkoBalance !== null && tilkoBalance < 5 ? 1 : 0,
                borderColor: '#FCA5A5',
            }}>
                <View>
                    <Text style={{ fontSize: fs.xs, color: '#525252', marginBottom: 2 }}>틸코 API 포인트 잔액</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
                        {balanceError ? (
                            <Text style={{ fontSize: fs.base, color: '#DC2626' }}>잔액조회 중 문제가 생겼습니다</Text>
                        ) : tilkoBalance !== null ? (
                            <>
                                <Text style={{ fontSize: fs['2xl'], fontWeight: '700', color: tilkoBalance < 5 ? '#DC2626' : '#18181B' }}>
                                    {tilkoBalance.toLocaleString()}
                                </Text>
                                <Text style={{ fontSize: fs.sm, color: '#525252' }}>P</Text>
                                {tilkoBalance < 5 && (
                                    <Text style={{ fontSize: fs.sm, color: '#DC2626', fontWeight: '600' }}>⚠ 잔액 부족</Text>
                                )}
                            </>
                        ) : (
                            <Text style={{ fontSize: fs.base, color: '#737373' }}>조회 중...</Text>
                        )}
                    </View>
                </View>
                <TouchableOpacity
                    onPress={handleRefreshBalance}
                    disabled={balanceLoading}
                    style={{ backgroundColor: '#18181B', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 }}
                    accessibilityLabel="잔액 새로고침"
                    accessibilityRole="button"
                >
                    {balanceLoading
                        ? <ActivityIndicator size="small" color="#fff" />
                        : <Text style={{ fontSize: fs.sm, color: '#fff', fontWeight: '600' }}>새로고침</Text>
                    }
                </TouchableOpacity>
            </View>}

            {/* 간편 모드: 핵심 메뉴만 표시 */}
            <TouchableOpacity
                style={[styles.menuButton, { minHeight: ts.minHeight, padding: ts.padding }]}
                onPress={() => { hapticFeedback(); setCurrentView('recent'); }}
                accessibilityLabel="최근 본 장소 화면으로 이동"
                accessibilityRole="button"
            >
                <Text style={[styles.menuButtonText, { fontSize: fs.xl }]}>📍 최근 본 장소</Text>
            </TouchableOpacity>
            <TouchableOpacity
                style={[styles.menuButton, { minHeight: ts.minHeight, padding: ts.padding }]}
                onPress={() => { hapticFeedback(); setCurrentView('favorites'); }}
                accessibilityLabel="즐겨 찾는 장소 화면으로 이동"
                accessibilityRole="button"
            >
                <Text style={[styles.menuButtonText, { fontSize: fs.xl }]}>⭐ 즐겨 찾는 장소</Text>
            </TouchableOpacity>

            {!simpleMode && (
                <>
                    <TouchableOpacity
                        style={[styles.menuButton, { minHeight: ts.minHeight, padding: ts.padding }]}
                        onPress={() => { hapticFeedback(); setCurrentView('stats'); }}
                        accessibilityLabel="영업 통계 화면으로 이동"
                        accessibilityRole="button"
                    >
                        <Text style={[styles.menuButtonText, { fontSize: fs.xl }]}>📊 영업 통계</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.menuButton, { minHeight: ts.minHeight, padding: ts.padding }]}
                        onPress={() => { hapticFeedback(); setCurrentView('registry'); }}
                        accessibilityLabel="등기 열람 이력 화면으로 이동"
                        accessibilityRole="button"
                    >
                        <Text style={[styles.menuButtonText, { fontSize: fs.xl }]}>📑 등기 열람 이력</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.menuButton, { minHeight: ts.minHeight, padding: ts.padding }]}
                        onPress={() => { hapticFeedback(); setCurrentView('improvements'); }}
                        accessibilityLabel="개선사항 및 공지 화면으로 이동"
                        accessibilityRole="button"
                    >
                        <Text style={[styles.menuButtonText, { fontSize: fs.xl }]}>📢 개선사항 / 공지</Text>
                    </TouchableOpacity>
                </>
            )}

            <TouchableOpacity
                style={[styles.menuButton, { minHeight: ts.minHeight, padding: ts.padding }]}
                onPress={() => { hapticFeedback(); setCurrentView('settings'); }}
                accessibilityLabel="화면 설정"
                accessibilityRole="button"
            >
                <Text style={[styles.menuButtonText, { fontSize: fs.xl }]}>
                    ⚙️ 화면 설정 {elderlyMode ? '(어르신 모드)' : simpleMode ? '(간편 모드)' : fontSizeLevel !== 'normal' ? `(글자: ${fontSizeLevel === 'large' ? '크게' : '아주 크게'})` : ''}
                </Text>
            </TouchableOpacity>
        </ScrollView>
    );
};

// ===== BuildingListScreen =====

const BuildingListScreen = ({ onMoveToMap }: { onMoveToMap: () => void }) => {
    const { region, buildings, isLoading, isLoadingMore, fetchBuildings, lastFetchedRegion, page, hasMore, setRegion, setSelectedMarker, saveRecentPlace, buildingFilter, setBuildingFilter, elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const ts = elderlyMode ? TOUCH_SIZE.elderly : TOUCH_SIZE.normal;
    const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());

    useEffect(() => {
        (async () => {
            try {
                const jsonValue = await AsyncStorage.getItem(FAVORITE_PLACES_KEY);
                const places: Building[] = jsonValue ? JSON.parse(jsonValue) : [];
                setFavoriteIds(new Set(places.map(p => p.id)));
            } catch (_) {}
        })();
    }, []);

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

    // 스마트 필터 적용
    const filteredBuildings = useMemo(() => {
        return buildings.filter(b => {
            // 카테고리 필터
            if (buildingFilter.selectedCategories.length < FILTER_CATEGORIES.length) {
                if (!b.category) return false;
                if (!buildingFilter.selectedCategories.some(cat => b.category?.includes(cat))) return false;
            }
            // 고잠재력 필터 (카테고리 + 이름 기반 휴리스틱)
            if (buildingFilter.onlyHighPotential) {
                const isIndustrial = ['공장', '창고', '물류'].some(k => (b.category || b.name || '').includes(k));
                if (!isIndustrial) return false;
            }
            return true;
        });
    }, [buildings, buildingFilter]);

    if (isLoading && buildings.length === 0) {
        return (
            <View style={styles.listContainer}>
                {Array.from({ length: 6 }).map((_, i) => <SkeletonItem key={i} />)}
            </View>
        );
    }

    return (
        <View style={styles.listContainer}>
            <View style={styles.listHeader}>
                <Text style={[styles.listTitle, { fontSize: fs.lg }]}>주변 공장·창고·물류 (1km 이내)</Text>
                <TouchableOpacity
                    onPress={() => fetchBuildings(region, 1)}
                    style={elderlyMode ? { paddingVertical: 8, paddingHorizontal: 12 } : undefined}
                    accessibilityLabel="목록 새로고침"
                    accessibilityRole="button"
                >
                    <Text style={[styles.refreshText, { fontSize: fs.base }]}>새로고침</Text>
                </TouchableOpacity>
            </View>

            {/* 스마트 필터 바 */}
            <FilterBar
                filter={buildingFilter}
                onChange={setBuildingFilter}
                totalCount={buildings.length}
                filteredCount={filteredBuildings.length}
            />

            <FlatList
                data={filteredBuildings}
                keyExtractor={(item) => item.id}
                removeClippedSubviews={true}
                maxToRenderPerBatch={10}
                windowSize={5}
                renderItem={({ item }) => (
                    <View style={[styles.listItemContainer, elderlyMode && { minHeight: 96 }]}>
                        <View style={[styles.listItem, elderlyMode && { padding: 18 }]}>
                            <View style={styles.itemHeader}>
                                <Text style={[styles.itemName, { fontSize: fs.lg }]} accessibilityRole="text">{item.name}</Text>
                                <Text style={[styles.itemDistance, { fontSize: fs.sm }]}>{item.distance}m</Text>
                            </View>
                            {item.category ? (
                                <View style={[styles.categoryBadge, elderlyMode && { paddingHorizontal: 10, paddingVertical: 4 }]}>
                                    <Text style={[styles.categoryBadgeText, { fontSize: fs.xs }]}>{item.category}</Text>
                                </View>
                            ) : null}
                            <Text style={[styles.itemAddress, { fontSize: fs.md }]}>{item.address}</Text>
                        </View>
                        <View style={styles.listItemActions}>
                            <TouchableOpacity
                                style={[styles.listItemIconBtn, { paddingHorizontal: elderlyMode ? 14 : 10, width: 'auto' as any }, elderlyMode && { minHeight: ts.minHeight, borderRadius: 10 }]}
                                onPress={async () => {
                                    await saveRecentPlace(item);
                                    setSelectedMarker(item);
                                    setRegion({ latitude: item.latitude, longitude: item.longitude, latitudeDelta: 0.001, longitudeDelta: 0.001 });
                                    onMoveToMap();
                                }}
                                accessibilityLabel={`${item.name} 지도에서 보기`}
                                accessibilityRole="button"
                            >
                                <Text style={{ color: '#18181B', fontSize: fs.md, fontWeight: '500' }}>보기</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[styles.listItemIconBtn, elderlyMode && { width: 44, height: 44, borderRadius: 22 }]}
                                onPress={() => toggleFavorite(item)}
                                accessibilityLabel={favoriteIds.has(item.id) ? `${item.name} 즐겨찾기 해제` : `${item.name} 즐겨찾기 추가`}
                                accessibilityRole="button"
                            >
                                <Text style={[styles.listItemIconText, { color: favoriteIds.has(item.id) ? '#FFD700' : '#aaa' }, elderlyMode && { fontSize: 22 }]}>★</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                )}
                contentContainerStyle={{ paddingBottom: 100 }}
                refreshing={isLoading}
                onRefresh={() => fetchBuildings(region, 1)}
                onEndReached={() => { if (!isLoadingMore && !isLoading && hasMore) fetchBuildings(region, page + 1); }}
                onEndReachedThreshold={0.5}
                ListFooterComponent={isLoadingMore ? <ActivityIndicator style={{ padding: 16 }} color="#71717A" /> : null}
                ListEmptyComponent={
                    <View style={styles.emptyContainer}>
                        <Text style={[styles.emptyText, { fontSize: fs.base, lineHeight: fs.base * 1.6 }]}>주변 1km 이내에 공장·창고·물류 건물이 없습니다.{'\n'}산업단지 주변으로 이동 후 새로고침 해주세요.</Text>
                    </View>
                }
            />
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

    const successRate = totalProps > 0 ? ((statusCounts['영업성공'] / totalProps) * 100).toFixed(1) : '0.0';
    const contactRate = totalProps > 0 ? (((totalProps - statusCounts['미접촉']) / totalProps) * 100).toFixed(1) : '0.0';

    const PERIOD_OPTIONS: { key: StatPeriod; label: string }[] = [
        { key: 'week', label: '최근 7일' },
        { key: 'month', label: '이번 달' },
        { key: 'all', label: '전체' },
    ];
    const cardStyle = { backgroundColor: '#fff', borderRadius: 8, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: '#E4E4E7' };

    return (
        <View style={styles.subScreenContainer}>
            <View style={styles.subScreenHeader}>
                <TouchableOpacity onPress={onBack} style={styles.backButton}>
                    <Text style={[styles.backButtonText, { fontSize: fs.lg }]}>{'← 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={[styles.subScreenTitle, { fontSize: fs['2xl'] }]}>영업 통계</Text>
                <View style={{ width: 60 }} />
            </View>

            {/* 기간 선택 */}
            <View style={{ flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 10, gap: 8, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#E4E4E7' }}>
                {PERIOD_OPTIONS.map(opt => (
                    <TouchableOpacity
                        key={opt.key}
                        onPress={() => setPeriod(opt.key)}
                        style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 6, backgroundColor: period === opt.key ? '#18181B' : '#F4F4F5', borderWidth: 1, borderColor: period === opt.key ? '#18181B' : '#E4E4E7' }}
                    >
                        <Text style={{ fontSize: fs.sm, color: period === opt.key ? '#FAFAFA' : '#52525B', fontWeight: '600' }}>{opt.label}</Text>
                    </TouchableOpacity>
                ))}
            </View>

            {isLoading ? (
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                    <ActivityIndicator size="large" color="#18181B" />
                </View>
            ) : (
                <ScrollView contentContainerStyle={{ padding: 16 }}>
                    {/* 핵심 지표 3가지 */}
                    <View style={[cardStyle, { flexDirection: 'row' }]}>
                        {[
                            { label: '전체 매물', value: `${totalProps}건` },
                            { label: '성공률', value: `${successRate}%` },
                            { label: '접촉률', value: `${contactRate}%` },
                        ].map((item, i, arr) => (
                            <View key={item.label} style={{ flex: 1, alignItems: 'center', borderRightWidth: i < arr.length - 1 ? 1 : 0, borderRightColor: '#E4E4E7' }}>
                                <Text style={{ fontSize: fs.xs, color: '#525252', marginBottom: 4 }}>{item.label}</Text>
                                <Text style={{ fontSize: fs['2xl'], fontWeight: '700', color: '#18181B' }}>{item.value}</Text>
                            </View>
                        ))}
                    </View>

                    {/* 상태별 분포 막대 */}
                    <View style={cardStyle}>
                        <Text style={{ fontSize: fs.sm, fontWeight: '600', color: '#52525B', marginBottom: 14 }}>영업상태 분포</Text>
                        {totalProps === 0 ? (
                            <Text style={{ fontSize: fs.sm, color: '#737373', textAlign: 'center', paddingVertical: 16 }}>등록된 매물이 없습니다.</Text>
                        ) : (
                            SALES_STATUSES.map(s => {
                                const count = statusCounts[s] || 0;
                                const pct = totalProps > 0 ? count / totalProps : 0;
                                return (
                                    <View key={s} style={{ marginBottom: 10 }}>
                                        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 5 }}>
                                            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: SALES_STATUS_COLORS[s], marginRight: 8 }} />
                                            <Text style={{ fontSize: fs.sm, color: '#18181B', flex: 1 }}>{s}</Text>
                                            <Text style={{ fontSize: fs.sm, color: '#52525B', fontWeight: '600' }}>{count}건</Text>
                                            <Text style={{ fontSize: fs.xs, color: '#737373', marginLeft: 8, width: 34, textAlign: 'right' }}>
                                                {(pct * 100).toFixed(0)}%
                                            </Text>
                                        </View>
                                        <View style={{ height: 7, backgroundColor: '#F4F4F5', borderRadius: 4, overflow: 'hidden' }}>
                                            <View style={{ height: '100%', width: `${Math.round(pct * 100)}%`, backgroundColor: SALES_STATUS_COLORS[s], borderRadius: 4 }} />
                                        </View>
                                    </View>
                                );
                            })
                        )}
                    </View>

                    {/* 이동 활동 통계 */}
                    <View style={cardStyle}>
                        <Text style={{ fontSize: fs.sm, fontWeight: '600', color: '#52525B', marginBottom: 12 }}>
                            영업 이동 기록
                            <Text style={{ fontSize: fs.xs, color: '#737373', fontWeight: '400' }}>  ({PERIOD_OPTIONS.find(p => p.key === period)?.label})</Text>
                        </Text>
                        <View style={{ flexDirection: 'row', gap: 12 }}>
                            <View style={{ flex: 1, backgroundColor: '#F4F4F5', borderRadius: 8, padding: 14, alignItems: 'center' }}>
                                <Text style={{ fontSize: fs.xs, color: '#525252', marginBottom: 4 }}>총 이동거리</Text>
                                <Text style={{ fontSize: fs['2xl'], fontWeight: '700', color: '#18181B' }}>{activityKm.toFixed(1)}</Text>
                                <Text style={{ fontSize: fs.xs, color: '#525252' }}>km</Text>
                            </View>
                            <View style={{ flex: 1, backgroundColor: '#F4F4F5', borderRadius: 8, padding: 14, alignItems: 'center' }}>
                                <Text style={{ fontSize: fs.xs, color: '#525252', marginBottom: 4 }}>GPS 방문 기록</Text>
                                <Text style={{ fontSize: fs['2xl'], fontWeight: '700', color: '#18181B' }}>{activityVisits}</Text>
                                <Text style={{ fontSize: fs.xs, color: '#525252' }}>건</Text>
                            </View>
                        </View>
                    </View>

                    {/* 미접촉 매물 주의 알림 */}
                    {statusCounts['미접촉'] > 0 && (
                        <View style={[cardStyle, { borderLeftWidth: 4, borderLeftColor: '#9E9E9E' }]}>
                            <Text style={{ fontSize: fs.sm, fontWeight: '600', color: '#52525B', marginBottom: 4 }}>미접촉 매물</Text>
                            <Text style={{ fontSize: fs['2xl'], fontWeight: '700', color: '#18181B' }}>{statusCounts['미접촉']}건</Text>
                            <Text style={{ fontSize: fs.xs, color: '#737373', marginTop: 4 }}>아직 연락하지 않은 매물입니다. 지도에서 확인하세요.</Text>
                        </View>
                    )}
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
                                <TouchableOpacity onPress={() => setStep(step === 'town' ? 'city' : 'province')} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={{ paddingVertical: 6, paddingHorizontal: 8, minWidth: 44, minHeight: 44, justifyContent: 'center' }}>
                                    <Text style={{ fontSize: 22, color: '#3F3F46', fontWeight: '600' }}>{'← 뒤로'}</Text>
                                </TouchableOpacity>
                            )}
                            <Text style={{ fontSize: 17, fontWeight: '700', color: '#18181B' }}>{stepTitle}</Text>
                        </View>
                        <TouchableOpacity onPress={resetAndClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 12, backgroundColor: '#F4F4F5', borderRadius: 8, borderWidth: 1, borderColor: '#BFBFBF', minHeight: 44 }}>
                            <Text style={{ fontSize: 18, color: '#333', fontWeight: '700' }}>✕ </Text>
                            <Text style={{ fontSize: 15, color: '#333', fontWeight: '600' }}>닫기</Text>
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
                                    <Text style={{ fontSize: 13, color: '#737373' }}>{'>'}</Text>
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

// ===== 햅틱 피드백 유틸 =====
const hapticFeedback = (duration = 10) => {
    try { Vibration.vibrate(duration); } catch (_) {}
};

// ===== 온보딩 컴포넌트 =====
const OnboardingScreen = ({ onComplete }: { onComplete: () => void }) => {
    const [step, setStep] = useState(0);
    const steps = [
        {
            emoji: '🗺️',
            title: '지도에서 건물을 터치하세요',
            desc: '지도 위의 건물 마커를 터치하면\n해당 건물의 정보가 아래에 표시됩니다.',
        },
        {
            emoji: '📋',
            title: '건물 정보를 확인하세요',
            desc: '주소, 등기부등본 조회, 장소관리 등\n다양한 기능을 사용할 수 있습니다.',
        },
        {
            emoji: '⚙️',
            title: '글자 크기를 조절할 수 있어요',
            desc: '메뉴 > 화면 설정에서\n글자 크기를 크게 변경할 수 있습니다.',
        },
    ];

    return (
        <View style={{ flex: 1, backgroundColor: '#09090B', justifyContent: 'center', alignItems: 'center', padding: 32 }}>
            <Text style={{ fontSize: 80, marginBottom: 32 }}>{steps[step].emoji}</Text>
            <Text style={{ fontSize: 26, fontWeight: '800', color: '#FAFAFA', textAlign: 'center', marginBottom: 16, lineHeight: 36 }}>
                {steps[step].title}
            </Text>
            <Text style={{ fontSize: 18, color: '#A1A1AA', textAlign: 'center', lineHeight: 28, marginBottom: 48 }}>
                {steps[step].desc}
            </Text>

            {/* 진행 표시 */}
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 40 }}>
                {steps.map((_, i) => (
                    <View key={i} style={{ width: i === step ? 32 : 10, height: 10, borderRadius: 5, backgroundColor: i === step ? '#4A90E2' : '#3F3F46' }} />
                ))}
            </View>

            <View style={{ flexDirection: 'row', gap: 12, width: '100%' }}>
                {step > 0 && (
                    <TouchableOpacity
                        style={{ flex: 1, paddingVertical: 18, backgroundColor: '#27272A', borderRadius: 14, alignItems: 'center', minHeight: 60 }}
                        onPress={() => { hapticFeedback(); setStep(step - 1); }}
                    >
                        <Text style={{ color: '#FAFAFA', fontSize: 19, fontWeight: '700' }}>← 이전</Text>
                    </TouchableOpacity>
                )}
                <TouchableOpacity
                    style={{ flex: 2, paddingVertical: 18, backgroundColor: '#4A90E2', borderRadius: 14, alignItems: 'center', minHeight: 60 }}
                    onPress={() => {
                        hapticFeedback();
                        if (step < steps.length - 1) {
                            setStep(step + 1);
                        } else {
                            AsyncStorage.setItem(ONBOARDING_DONE_KEY, 'true').catch(() => {});
                            onComplete();
                        }
                    }}
                >
                    <Text style={{ color: '#fff', fontSize: 19, fontWeight: '700' }}>
                        {step < steps.length - 1 ? '다음 →' : '시작하기'}
                    </Text>
                </TouchableOpacity>
            </View>

            {step === 0 && (
                <TouchableOpacity
                    style={{ marginTop: 20, padding: 12 }}
                    onPress={() => {
                        AsyncStorage.setItem(ONBOARDING_DONE_KEY, 'true').catch(() => {});
                        onComplete();
                    }}
                >
                    <Text style={{ color: '#737373', fontSize: 16 }}>건너뛰기</Text>
                </TouchableOpacity>
            )}
        </View>
    );
};

function AppContent() {
    const [currentTab, setCurrentTab] = useState('map');
    const [placeManagementVisible, setPlaceManagementVisible] = useState(false);
    const [showOnboarding, setShowOnboarding] = useState(false);
    const mapRef = useRef<GoogleMapHandle>(null);
    const kakaoSkyRef = useRef<KakaoSkyViewHandle>(null);
    const { region, setRegion, selectedMarker, setSelectedMarker, mapType, setMapType, propertyMarkers, setPropertyMarkers, saveRecentPlace, buildingFilter, clusteringEnabled, setClusteringEnabled, elderlyMode, setElderlyMode, salesTargetFilter, setSalesTargetFilter, tilkoBalance, setTilkoBalance } = useMapStore();
    const { fontSizeLevel, setFontSizeLevel, simpleMode, setSimpleMode } = useMapStore();

    // 현재 활성화된 지도 ref로 이동 명령 전달 (mapType 구독 이후 선언)
    const animateActiveMap = useCallback((region: Region, duration?: number) => {
        if (mapType === 'satellite') {
            kakaoSkyRef.current?.animateToRegion(region, duration);
        } else {
            mapRef.current?.animateToRegion(region, duration);
        }
    }, [mapType]);
    const fs = FONT_SCALE_LEVELS[fontSizeLevel] || FONT_SCALE.normal;
    const ts = elderlyMode ? TOUCH_SIZE.elderly : TOUCH_SIZE.normal;

    // 앱 시작 시 설정 복원 + 온보딩 체크
    useEffect(() => {
        // 온보딩 체크
        AsyncStorage.getItem(ONBOARDING_DONE_KEY).then(val => {
            if (val !== 'true') setShowOnboarding(true);
        }).catch(() => {});

        // 고령자 모드 복원
        AsyncStorage.getItem(ELDERLY_MODE_KEY).then(val => {
            if (val !== null) setElderlyMode(JSON.parse(val));
        }).catch(console.warn);

        // 글자 크기 레벨 복원
        AsyncStorage.getItem(FONT_SIZE_LEVEL_KEY).then(val => {
            if (val && (val === 'normal' || val === 'large' || val === 'extraLarge')) {
                setFontSizeLevel(val as FontSizeLevel);
            }
        }).catch(() => {});

        // 간편 모드 복원
        AsyncStorage.getItem(SIMPLE_MODE_KEY).then(val => {
            if (val !== null) setSimpleMode(JSON.parse(val));
        }).catch(() => {});

        // 알림 표시 핸들러 (포그라운드)
        if (Notifications) {
            try {
                Notifications.setNotificationHandler({
                    handleNotification: async () => ({
                        shouldShowAlert: true,
                        shouldPlaySound: true,
                        shouldSetBadge: false,
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
    const [splashStage, setSplashStage] = useState('앱 시작 중...');
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

    const handleMapLoadProgress = useCallback((stage: 'sdkLoaded' | 'mapReady') => {
        if (stage === 'sdkLoaded') {
            clearInterval(splashIntervalRef.current!);
            setSplashStage('지도 초기화 중...');
            // 35→80% 구간 자동 증가
            splashIntervalRef.current = setInterval(() => {
                setSplashProgress(prev => {
                    if (prev >= 80) { clearInterval(splashIntervalRef.current!); return 80; }
                    return prev + 1.2;
                });
            }, 60);
        } else if (stage === 'mapReady') {
            clearInterval(splashIntervalRef.current!);
            setSplashStage('완료!');
            setSplashProgress(100);
            setTimeout(() => setSplashVisible(false), 500);
        }
    }, []);

    const [registryModalVisible, setRegistryModalVisible] = useState(false);
    const [selectedProperty, setSelectedProperty] = useState<Property | null>(null);
    const [propertyModalVisible, setPropertyModalVisible] = useState(false);
    const [registryRecord, setRegistryRecord] = useState<{ id: string; lat?: number; lng?: number; jibun_address?: string; xml_data?: string } | null>(null);
    const [allRegistryViews, setAllRegistryViews] = useState<Array<{ id: string; lat?: number; lng?: number; jibun_address?: string; xml_data?: string }>>([]);
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

    // 앱 시작 시 DB에서 잔액 조회
    useEffect(() => {
        fetchTilkoBalanceFromDB().then(bal => {
            if (bal !== null) {
                setTilkoBalance(bal);
            } else {
                useMapStore.getState().setBalanceError(true);
            }
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

    // 사용자 위치 및 방향
    const [userLocation, setUserLocation] = useState<{ latitude: number; longitude: number } | null>(null);
    const [userHeading, setUserHeading] = useState<number | null>(null);
    const [headingMode, setHeadingMode] = useState(false); // GPS 버튼 2번째 탭 → 나침반 모드
    const lastRecordedPosRef = useRef<{ lat: number; lng: number } | null>(null);

    // heading → 방위 텍스트 변환
    const getDirectionLabel = (heading: number | null): string => {
        if (heading == null) return '';
        const h = ((heading % 360) + 360) % 360;
        if (h >= 337.5 || h < 22.5) return '북';
        if (h >= 22.5 && h < 67.5) return '북동';
        if (h >= 67.5 && h < 112.5) return '동';
        if (h >= 112.5 && h < 157.5) return '남동';
        if (h >= 157.5 && h < 202.5) return '남';
        if (h >= 202.5 && h < 247.5) return '남서';
        if (h >= 247.5 && h < 292.5) return '서';
        return '북서';
    };

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
                .select('id, lat, lng, jibun_address, xml_data')
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

    // 앱 시작 시 위치 권한 요청 및 현재 위치 설정
    useEffect(() => {
        (async () => {
            try {
                const { status } = await Location.requestForegroundPermissionsAsync();
                if (status !== 'granted') return;

                // 1단계: 캐시된 마지막 위치로 즉시 이동 (빠름)
                const last = await Location.getLastKnownPositionAsync({});
                if (last) {
                    const coords = { latitude: last.coords.latitude, longitude: last.coords.longitude };
                    setUserLocation(coords);
                    setRegion({ ...coords, latitudeDelta: 0.001, longitudeDelta: 0.001 });
                    setTimeout(() => animateActiveMap({ ...coords, latitudeDelta: 0.001, longitudeDelta: 0.001 }), 300);
                }

                // 2단계: 정확한 현재 위치로 업데이트
                const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
                const coords = { latitude: location.coords.latitude, longitude: location.coords.longitude };
                setUserLocation(coords);
                setRegion({ ...coords, latitudeDelta: 0.001, longitudeDelta: 0.001 });
                setTimeout(() => animateActiveMap({ ...coords, latitudeDelta: 0.001, longitudeDelta: 0.001 }), 300);
            } catch (error) {
                console.log("Location error:", error);
            }
        })();
    }, []);

    useEffect(() => {
        if (currentTab === 'map') {
            setTimeout(() => animateActiveMap(region, 500), 100);
        }
    }, [currentTab, region]);

    // GPS 와처: 실시간 위치 추적 (부드러운 이동) + 150m 이동 시 영업 동선 기록
    useEffect(() => {
        let locationSub: Location.LocationSubscription | null = null;
        let headingSub: Location.LocationSubscription | null = null;
        (async () => {
            try {
                const { status } = await Location.requestForegroundPermissionsAsync();
                if (status !== 'granted') return;

                // 위치 추적: 2초 / 5m 간격으로 부드럽게 업데이트
                locationSub = await Location.watchPositionAsync(
                    { accuracy: Location.Accuracy.High, timeInterval: 2000, distanceInterval: 5 },
                    (loc) => {
                        const { latitude: lat, longitude: lng } = loc.coords;
                        setUserLocation({ latitude: lat, longitude: lng });
                        // 방향값이 위치에 포함되어 있으면 사용
                        if (loc.coords.heading != null && loc.coords.heading >= 0) {
                            setUserHeading(loc.coords.heading);
                        }
                        // 150m 이상 이동 시 영업 동선 기록
                        if (!lastRecordedPosRef.current ||
                            haversineDistance(lastRecordedPosRef.current.lat, lastRecordedPosRef.current.lng, lat, lng) >= 150) {
                            lastRecordedPosRef.current = { lat, lng };
                            recordGPSVisit(lat, lng);
                        }
                    }
                );

                // 나침반(heading) 구독: 디바이스 방향 실시간 추적
                headingSub = await Location.watchHeadingAsync((headingData) => {
                    if (headingData.trueHeading >= 0) {
                        setUserHeading(headingData.trueHeading);
                    } else if (headingData.magHeading >= 0) {
                        setUserHeading(headingData.magHeading);
                    }
                });
            } catch (_) {}
        })();
        return () => {
            locationSub?.remove();
            headingSub?.remove();
        };
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

    // 마커 변경 시 장소관리 모달 닫기
    useEffect(() => {
        setPlaceManagementVisible(false);
    }, [selectedMarker]);

    const handleGpsPress = useCallback(async () => {
        hapticFeedback();
        // 이미 heading 모드면 → 끄기
        if (headingMode) {
            setHeadingMode(false);
            return;
        }

        try {
            const { status } = await Location.requestForegroundPermissionsAsync();
            if (status !== 'granted') return;

            // 이미 내 위치에 있으면 → heading 모드 ON
            if (userLocation && region) {
                const dist = Math.abs(region.latitude - userLocation.latitude) + Math.abs(region.longitude - userLocation.longitude);
                if (dist < 0.001) {
                    setHeadingMode(true);
                    return;
                }
            }

            // 내 위치로 이동
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
    }, [headingMode, userLocation, region]);

    const handleRefreshRegistry = () => {
        Alert.alert(
            "이전 조회 기록 존재",
            "이전 조회 기록이 존재합니다.\n갱신하시겠습니까?",
            [
                { text: "취소", style: "cancel" },
                {
                    text: "예",
                    onPress: async () => {
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
                            if (info.pointBalance !== null) { useMapStore.getState().setTilkoBalance(info.pointBalance); saveTilkoBalanceToDB(info.pointBalance); }
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
                            Alert.alert("완료", "등기부등본 정보가 갱신되었습니다.");
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
                    },
                },
            ]
        );
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
            case 'home':
                return (
                    <HomeScreen
                        onSelectRegion={() => setCurrentTab('regionSelect')}
                        onSelectSearch={() => setCurrentTab('homeSearch')}
                        onSelectMap={() => setCurrentTab('map')}
                    />
                );
            case 'homeSearch':
                return (
                    <PlaceSearchScreen
                        onBack={() => setCurrentTab('home')}
                        onMoveToMap={() => setCurrentTab('map')}
                    />
                );
            case 'regionSelect':
                return (
                    <RegionSelectScreen
                        onBack={() => setCurrentTab('home')}
                        onComplete={(province, city, category, lat, lng) => {
                            const newRegion = { latitude: lat, longitude: lng, latitudeDelta: 0.08, longitudeDelta: 0.08 };
                            setRegion(newRegion);
                            animateActiveMap(newRegion, 600);
                            const shortName = DEFAULT_PROVINCES.find(p => p.name === province)?.short || province;
                            setSelectedRegionLabel(`${shortName} ${city}`);
                            AsyncStorage.setItem(SELECTED_REGION_KEY, `${shortName} ${city}`).catch(() => {});
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
                                initialRegion={region}
                                onRegionChangeComplete={(r) => setRegion(r)}
                                onPress={handleMapPress}
                                onMarkerPress={handleMarkerPress}
                                selectedMarker={selectedMarker}
                                markers={allMarkersForMap}
                                userLocation={userLocation}
                                userHeading={userHeading}
                                headingMode={headingMode}
                                directionLabel={getDirectionLabel(userHeading)}
                                elderlyMode={elderlyMode}
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
                                userHeading={userHeading}
                                headingMode={headingMode}
                                directionLabel={getDirectionLabel(userHeading)}
                                elderlyMode={elderlyMode}
                                onLoadProgress={handleMapLoadProgress}
                            />
                        )}

                        <RegionSelectorModal
                            visible={regionSelectorVisible}
                            onClose={() => setRegionSelectorVisible(false)}
                            onSelect={handleRegionSelect}
                            currentLabel={selectedRegionLabel}
                        />

                        {/* 지도 타입 탭 */}
                        <View style={styles.mapTypeContainer}>
                            <TouchableOpacity
                                style={[
                                    styles.tabButton,
                                    elderlyMode && { paddingVertical: 12, paddingHorizontal: 14 },
                                    mapType === 'standard' && styles.activeTabButton,
                                ]}
                                onPress={() => changeMapType('standard')}
                                accessibilityLabel="일반 지도로 전환"
                                accessibilityRole="button"
                                accessibilityState={{ selected: mapType === 'standard' }}
                            >
                                <Text style={[styles.tabButtonText, { fontSize: fs.md }, mapType === 'standard' && styles.activeTabButtonText]}>일반지도</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[
                                    styles.tabButton,
                                    elderlyMode && { paddingVertical: 12, paddingHorizontal: 14 },
                                    mapType === 'cadastral' && styles.activeTabButton,
                                ]}
                                onPress={() => changeMapType('cadastral')}
                                accessibilityLabel="지적도로 전환"
                                accessibilityRole="button"
                                accessibilityState={{ selected: mapType === 'cadastral' }}
                            >
                                <Text style={[styles.tabButtonText, { fontSize: fs.md }, mapType === 'cadastral' && styles.activeTabButtonText]}>지적도</Text>
                            </TouchableOpacity>
                            {!simpleMode && (
                                <TouchableOpacity
                                    style={[
                                        styles.tabButton,
                                        elderlyMode && { paddingVertical: 12, paddingHorizontal: 14 },
                                        mapType === 'satellite' && styles.activeTabButton,
                                    ]}
                                    onPress={() => changeMapType('satellite')}
                                    accessibilityLabel="항공뷰로 전환"
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: mapType === 'satellite' }}
                                >
                                    <Text style={[styles.tabButtonText, { fontSize: fs.md }, mapType === 'satellite' && styles.activeTabButtonText]}>항공뷰</Text>
                                </TouchableOpacity>
                            )}
                        </View>


                        {/* 플로팅 지도 검색바 */}
                        <View style={{ position: 'absolute', top: 12, left: 12, right: 12, zIndex: 30 }} pointerEvents="box-none">
                            <View style={{ backgroundColor: '#fff', borderRadius: 10, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, elevation: 6, shadowColor: '#000', shadowOpacity: 0.18, shadowOffset: { width: 0, height: 2 }, shadowRadius: 6 }}>
                                <Text style={{ color: '#737373', fontSize: 14, marginRight: 8 }}>Q</Text>
                                <TextInput
                                    style={{ flex: 1, fontSize: fs.base, color: '#18181B', paddingVertical: 0 }}
                                    placeholder="지도에서 장소 검색..."
                                    placeholderTextColor="#A1A1AA"
                                    value={mapSearchText}
                                    onChangeText={setMapSearchText}
                                    onSubmitEditing={handleMapSearch}
                                    returnKeyType="search"
                                    blurOnSubmit={false}
                                />
                                {mapSearchLoading ? (
                                    <ActivityIndicator size="small" color="#71717A" style={{ marginLeft: 6 }} />
                                ) : mapSearchText.length > 0 ? (
                                    <TouchableOpacity onPress={() => { setMapSearchText(''); setMapSearchResults([]); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                        <Text style={{ color: '#737373', fontSize: 16, marginLeft: 6 }}>×</Text>
                                    </TouchableOpacity>
                                ) : null}
                            </View>
                            {mapSearchResults.length > 0 && (
                                <View style={{ backgroundColor: '#fff', borderRadius: 8, marginTop: 4, elevation: 6, shadowColor: '#000', shadowOpacity: 0.18, shadowOffset: { width: 0, height: 2 }, shadowRadius: 6, maxHeight: 260, overflow: 'hidden' }}>
                                    <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                                        {mapSearchResults.map((item, idx) => (
                                            <TouchableOpacity
                                                key={item.id}
                                                style={{ paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: idx < mapSearchResults.length - 1 ? 1 : 0, borderBottomColor: '#F4F4F5' }}
                                                onPress={() => {
                                                    const newRegion = { latitude: item.latitude, longitude: item.longitude, latitudeDelta: 0.001, longitudeDelta: 0.001 };
                                                    setRegion(newRegion);
                                                    animateActiveMap(newRegion, 500);
                                                    setSelectedMarker(item);
                                                    saveRecentPlace(item);
                                                    setMapSearchText('');
                                                    setMapSearchResults([]);
                                                }}
                                            >
                                                <Text style={{ fontSize: fs.base, fontWeight: '500', color: '#18181B' }} numberOfLines={1}>{item.name}</Text>
                                                <Text style={{ fontSize: fs.sm, color: '#525252', marginTop: 2 }} numberOfLines={1}>{item.address}</Text>
                                            </TouchableOpacity>
                                        ))}
                                    </ScrollView>
                                </View>
                            )}
                        </View>

                        {/* 등기 잔액 뱃지 - 어르신 모드에서 숨김 */}
                        {!elderlyMode && tilkoBalance !== null && (
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
                                <Text style={{ fontSize: 13, color: '#737373' }}>잔액</Text>
                                <Text style={{ fontSize: 13, fontWeight: '700', color: tilkoBalance < 5 ? '#FEF2F2' : '#FAFAFA' }}>
                                    {tilkoBalance.toLocaleString()}P
                                </Text>
                                {tilkoBalance < 5 && (
                                    <Text style={{ fontSize: 13, color: '#FCA5A5' }}>⚠</Text>
                                )}
                            </TouchableOpacity>
                        )}

                        {/* 나침반 위젯 - 어르신 모드에서 숨김 */}
                        {!elderlyMode && headingMode && userHeading != null && (
                            <View style={{
                                position: 'absolute', top: 16, left: 16, zIndex: 20,
                                width: 56, height: 56, borderRadius: 28,
                                backgroundColor: 'rgba(255,255,255,0.95)',
                                alignItems: 'center', justifyContent: 'center',
                                elevation: 6, shadowColor: '#000', shadowOpacity: 0.15,
                                shadowOffset: { width: 0, height: 2 }, shadowRadius: 6,
                                borderWidth: 1, borderColor: '#E4E4E7',
                            }}>
                                {/* 회전하는 나침반 바늘 */}
                                <View style={{
                                    width: 44, height: 44,
                                    alignItems: 'center', justifyContent: 'center',
                                    transform: [{ rotate: `${-userHeading}deg` }],
                                }}>
                                    {/* 북쪽 (빨간) */}
                                    <View style={{
                                        position: 'absolute', top: 2,
                                        width: 0, height: 0,
                                        borderLeftWidth: 5, borderRightWidth: 5, borderBottomWidth: 16,
                                        borderLeftColor: 'transparent', borderRightColor: 'transparent',
                                        borderBottomColor: '#EF4444',
                                    }} />
                                    {/* 남쪽 (회색) */}
                                    <View style={{
                                        position: 'absolute', bottom: 2,
                                        width: 0, height: 0,
                                        borderLeftWidth: 5, borderRightWidth: 5, borderTopWidth: 16,
                                        borderLeftColor: 'transparent', borderRightColor: 'transparent',
                                        borderTopColor: '#A1A1AA',
                                    }} />
                                    {/* N 글자 */}
                                    <Text style={{
                                        position: 'absolute', top: -1,
                                        fontSize: 7, fontWeight: '900', color: '#EF4444',
                                    }}>N</Text>
                                </View>
                            </View>
                        )}

                        {/* 줌 +/- 버튼 */}
                        <View style={[styles.zoomControls, elderlyMode && { bottom: elderlyMode ? 208 : 198 }]}>
                            <TouchableOpacity
                                style={styles.zoomButton}
                                onPress={() => {
                                    hapticFeedback(5);
                                    const newDelta = Math.max(region.latitudeDelta * 0.5, 0.0005);
                                    const newRegion = { ...region, latitudeDelta: newDelta, longitudeDelta: newDelta * (region.longitudeDelta / region.latitudeDelta) };
                                    setRegion(newRegion);
                                    mapRef.current?.animateToRegion(newRegion, 300);
                                }}
                                accessibilityLabel="지도 확대"
                                accessibilityRole="button"
                            >
                                <Text style={styles.zoomButtonText}>＋</Text>
                            </TouchableOpacity>
                            <View style={styles.zoomDivider} />
                            <TouchableOpacity
                                style={styles.zoomButton}
                                onPress={() => {
                                    hapticFeedback(5);
                                    const newDelta = Math.min(region.latitudeDelta * 2, 5);
                                    const newRegion = { ...region, latitudeDelta: newDelta, longitudeDelta: newDelta * (region.longitudeDelta / region.latitudeDelta) };
                                    setRegion(newRegion);
                                    mapRef.current?.animateToRegion(newRegion, 300);
                                }}
                                accessibilityLabel="지도 축소"
                                accessibilityRole="button"
                            >
                                <Text style={styles.zoomButtonText}>－</Text>
                            </TouchableOpacity>
                        </View>

                        {/* 현재 위치 버튼 */}
                        <TouchableOpacity
                            style={[
                                styles.gpsButton,
                                headingMode && { backgroundColor: '#4285F4', borderColor: '#3B78DB' },
                                elderlyMode && { width: 60, height: 60, borderRadius: 30, bottom: elderlyMode ? 140 : 130 },
                            ]}
                            onPress={handleGpsPress}
                            accessibilityLabel={headingMode ? "나침반 모드 끄기" : "현재 위치로 이동"}
                            accessibilityRole="button"
                        >
                            <Text style={[styles.gpsButtonText, elderlyMode && { fontSize: 16 }]}>
                                {headingMode ? '🧭' : 'GPS'}
                            </Text>
                        </TouchableOpacity>

                        <LoadingOverlay visible={isMapLoading} message={loadingMessage} />

                        {/* 카카오 로드뷰 모달 */}
                        {selectedMarker && (
                            <StreetViewModal
                                visible={streetViewVisible}
                                onClose={() => setStreetViewVisible(false)}
                                latitude={selectedMarker.latitude}
                                longitude={selectedMarker.longitude}
                                title={selectedMarker.address}
                            />
                        )}

                        {/* 선택된 일반 마커 하단 패널 */}
                        {selectedMarker && !propertyModalVisible && (
                            <View style={[styles.bottomPanel, elderlyMode && { padding: 20, bottom: elderlyMode ? 130 : 125 }]}>
                                <View style={styles.bottomPanelHandle} />
                                <View style={styles.bottomPanelTopRow}>
                                    <View style={{ flex: 1 }}>
                                        <Text style={[styles.bottomPanelAddress, { fontSize: fs.lg, fontWeight: '700' }]}
                                            accessibilityRole="text"
                                        >
                                            {selectedMarker.address}
                                        </Text>
                                        {!elderlyMode && (
                                            <Text style={[styles.bottomPanelCoord, { fontSize: fs.sm }]}>
                                                {selectedMarker.latitude.toFixed(6)}, {selectedMarker.longitude.toFixed(6)}
                                            </Text>
                                        )}
                                        {/* 주소에 한글이 없으면 한글 주소 조회 버튼 표시 */}
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
                                                style={{ marginTop: 4, flexDirection: 'row', alignItems: 'center', gap: 4 }}
                                            >
                                                {isTranslatingAddr
                                                    ? <ActivityIndicator size="small" color="#4A90E2" />
                                                    : <Text style={{ fontSize: fs.xs, color: '#4A90E2', fontWeight: '600' }}>🌐 한글 주소 보기</Text>
                                                }
                                            </TouchableOpacity>
                                        )}
                                    </View>
                                    <View style={styles.bottomPanelIcons}>
                                        <TouchableOpacity
                                            style={[styles.bottomPanelIconBtn, { width: 48, height: 48, borderRadius: 12 }, elderlyMode && { width: 56, height: 56, borderRadius: 14 }]}
                                            onPress={handleToggleFavorite}
                                            accessibilityLabel={isFavorite ? '즐겨찾기 해제' : '즐겨찾기 추가'}
                                            accessibilityRole="button"
                                        >
                                            <Text style={[styles.bottomPanelIconText, { color: isFavorite ? '#FFD700' : '#737373', fontSize: 22 }, elderlyMode && { fontSize: 26 }]}>★</Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity
                                            style={[styles.bottomPanelIconBtn, { width: 48, height: 48, borderRadius: 12, backgroundColor: '#F0F0F0', borderColor: '#BFBFBF' }, elderlyMode && { width: 56, height: 56, borderRadius: 14 }]}
                                            onPress={() => setSelectedMarker(null)}
                                            accessibilityLabel="선택 해제"
                                            accessibilityRole="button"
                                        >
                                            <Text style={[styles.bottomPanelIconText, { color: '#525252', fontSize: 18, fontWeight: '700' }, elderlyMode && { fontSize: 22 }]}>✕</Text>
                                        </TouchableOpacity>
                                    </View>
                                </View>
                                <View style={styles.bottomPanelButtons}>
                                    {elderlyMode ? (
                                        <>
                                            {/* 어르신 모드: 등기부등본 조회 버튼만 크게 */}
                                            <TouchableOpacity
                                                style={[
                                                    styles.bottomPanelButtonRegistry,
                                                    { flex: 1, paddingVertical: 16, borderRadius: 12 },
                                                    registryRecord ? { backgroundColor: '#27272A' } : null,
                                                ]}
                                                onPress={() => {
                                                    if (registryRecord) {
                                                        handleRefreshRegistry();
                                                    } else {
                                                        Alert.alert(
                                                            "건물주 정보 조회",
                                                            "이 건물의 소유자 정보를 조회하시겠습니까?\n(열람비용 발생)",
                                                            [
                                                                { text: "취소", style: "cancel" },
                                                                { text: "조회하기", onPress: () => setRegistryModalVisible(true) },
                                                            ]
                                                        );
                                                    }
                                                }}
                                                accessibilityLabel="건물주 정보 조회"
                                                accessibilityRole="button"
                                            >
                                                <Text style={[styles.bottomPanelButtonText, { fontSize: fs.xl, fontWeight: '700' }]}>
                                                    건물주 정보 조회
                                                </Text>
                                            </TouchableOpacity>
                                        </>
                                    ) : (
                                        <>
                                            {/* 일반 모드: 3개 버튼 */}
                                            <TouchableOpacity
                                                style={styles.bottomPanelButtonRoadview}
                                                onPress={() => setStreetViewVisible(true)}
                                            >
                                                <Text style={styles.bottomPanelButtonText}>실제이미지</Text>
                                            </TouchableOpacity>
                                            <TouchableOpacity
                                                style={[styles.bottomPanelButtonRoadview, { backgroundColor: '#27272A' }]}
                                                onPress={() => setPlaceManagementVisible(true)}
                                                accessibilityLabel="장소관리"
                                                accessibilityRole="button"
                                            >
                                                <Text style={styles.bottomPanelButtonText}>장소관리</Text>
                                            </TouchableOpacity>
                                            <TouchableOpacity
                                                style={[
                                                    styles.bottomPanelButtonRegistry,
                                                    registryRecord ? { backgroundColor: '#27272A' } : null,
                                                ]}
                                                onPress={() => {
                                                    if (registryRecord) {
                                                        handleRefreshRegistry();
                                                    } else {
                                                        Alert.alert(
                                                            "등기부등본 조회",
                                                            "등기부등본을 조회하시겠습니까?\n(열람비용 발생)",
                                                            [
                                                                { text: "취소", style: "cancel" },
                                                                { text: "조회", onPress: () => setRegistryModalVisible(true) },
                                                            ]
                                                        );
                                                    }
                                                }}
                                                accessibilityLabel="등기부등본 조회"
                                                accessibilityRole="button"
                                            >
                                                <Text style={[styles.bottomPanelButtonText, { fontSize: fs.md }]}>
                                                    등기부등본조회
                                                </Text>
                                            </TouchableOpacity>
                                        </>
                                    )}
                                </View>
                            </View>
                        )}

                        {/* 장소관리 모달 */}
                        {selectedMarker && (
                            <PlaceManagementModal
                                visible={placeManagementVisible}
                                onClose={() => setPlaceManagementVisible(false)}
                                latitude={selectedMarker.latitude}
                                longitude={selectedMarker.longitude}
                                address={selectedMarker.address}
                            />
                        )}
                    </View>
                );
            case 'more':
                return (
                    <MoreScreen
                        onMoveToMap={() => setCurrentTab('map')}
                        onMoveToMapWithLocation={(lat, lng, address) => {
                            setRegion({ latitude: lat, longitude: lng, latitudeDelta: 0.001, longitudeDelta: 0.001 });
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

    // 온보딩 화면
    if (showOnboarding) {
        return (
            <>
                <StatusBar barStyle="light-content" backgroundColor="#09090B" translucent={false} />
                <SafeAreaView style={{ flex: 1, backgroundColor: '#09090B' }}>
                    <OnboardingScreen onComplete={() => setShowOnboarding(false)} />
                </SafeAreaView>
            </>
        );
    }

    return (
    <>
        <StatusBar barStyle="light-content" backgroundColor="#09090B" translucent={false} />
        <SafeAreaView style={styles.container}>
            {/* 네트워크 상태 말풍선 (모든 탭에서 표시) */}
            <NetworkBubble isOnline={isOnline} />

            {renderContent()}

            {/* 하단 탭바 (3탭) - regionSelect 시 숨김 */}
            {currentTab !== 'regionSelect' && <View style={[styles.floatingMenu, elderlyMode && { height: 72, bottom: 40 }]}>
                {([
                    { id: 'map',  label: '지도',  a11y: '지도 탭' },
                    { id: 'home', label: '홈',    a11y: '홈 탭' },
                    { id: 'more', label: '메뉴', a11y: '메뉴 탭' },
                ] as { id: string; label: string; a11y: string }[]).map(tab => {
                    const active = currentTab === tab.id || (tab.id === 'home' && currentTab === 'homeSearch');
                    return (
                        <TouchableOpacity
                            key={tab.id}
                            style={styles.menuItem}
                            onPress={() => { hapticFeedback(5); setCurrentTab(tab.id === 'home' && currentTab === 'homeSearch' ? 'home' : tab.id); }}
                            accessibilityLabel={tab.a11y}
                            accessibilityRole="tab"
                            accessibilityState={{ selected: active }}
                        >
                            <Text style={[
                                styles.menuText,
                                { fontSize: fs.base },
                                active && styles.activeMenuText,
                                elderlyMode && active && { color: COLORS_HIGH_CONTRAST.primary, fontWeight: '800' },
                            ]}>{tab.label}</Text>
                            {active && <View style={styles.menuActiveIndicator} />}
                        </TouchableOpacity>
                    );
                })}
            </View>}

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
    </>
    );
}

// ===== 대문(스플래시) 화면 =====

interface SplashProps {
    progress: number;       // 0~100
    stage: string;          // 단계 메시지
    visible: boolean;
    onHidden: () => void;
}

const SplashScreen = ({ progress, stage, visible, onHidden }: SplashProps) => {
    const fadeAnim = useRef(new Animated.Value(1)).current;
    const scaleAnim = useRef(new Animated.Value(1)).current;
    const hidden = useRef(false);

    useEffect(() => {
        if (!visible && !hidden.current) {
            hidden.current = true;
            Animated.parallel([
                Animated.timing(fadeAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
                Animated.timing(scaleAnim, { toValue: 1.05, duration: 600, useNativeDriver: true }),
            ]).start(() => onHidden());
        }
    }, [visible]);

    const clampedProgress = Math.min(Math.max(progress, 0), 100);

    return (
        <Animated.View style={[splashStyles.container, { opacity: fadeAnim, transform: [{ scale: scaleAnim }] }]}>
            <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

            {/* 로고 영역 */}
            <View style={splashStyles.logoArea}>
                <Text style={splashStyles.appTitle}>태양광 영업지원</Text>
                <Text style={splashStyles.appSubtitle}>지도 서비스</Text>
            </View>

            {/* 로딩 영역 */}
            <View style={splashStyles.loadingArea}>
                <Text style={splashStyles.stageText}>{stage}</Text>

                {/* 퍼센테이지 */}
                <Text style={splashStyles.percentText}>{Math.round(clampedProgress)}%</Text>

                {/* 프로그래스 바 */}
                <View style={splashStyles.progressTrack}>
                    <Animated.View style={[splashStyles.progressFill, { width: `${clampedProgress}%` }]} />
                </View>
            </View>

            {/* 하단 */}
            <Text style={splashStyles.versionText}>v{APP_VERSION}</Text>
        </Animated.View>
    );
};

const splashStyles = StyleSheet.create({
    container: {
        ...StyleSheet.absoluteFillObject,
        zIndex: 9999,
        backgroundColor: '#09090B',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 80,
    },
    logoArea: {
        alignItems: 'center',
        marginTop: 60,
    },
    appTitle: {
        fontSize: 22,
        fontWeight: '600',
        color: '#FAFAFA',
        letterSpacing: -0.5,
        marginBottom: 6,
    },
    appSubtitle: {
        fontSize: 13,
        color: '#525252',
        letterSpacing: 1,
    },
    loadingArea: {
        width: '70%',
        alignItems: 'center',
    },
    stageText: {
        fontSize: 15,
        color: '#525252',
        marginBottom: 10,
    },
    percentText: {
        fontSize: 32,
        fontWeight: '600',
        color: '#FAFAFA',
        marginBottom: 14,
        letterSpacing: -1,
    },
    progressTrack: {
        width: '100%',
        height: 3,
        backgroundColor: '#27272A',
        borderRadius: 2,
        overflow: 'hidden',
    },
    progressFill: {
        height: '100%',
        backgroundColor: '#FAFAFA',
        borderRadius: 2,
    },
    versionText: {
        fontSize: 14,
        color: '#52525B',
    },
});

export default function App() {
    return (
        <QueryClientProvider client={queryClient}>
            <AppContent />
        </QueryClientProvider>
    );
}

// ===== 스타일 =====

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#09090B',
        paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0,
    },
    header: {
        height: 58,
        backgroundColor: '#09090B',
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 10,
        borderBottomWidth: 1,
        borderBottomColor: '#27272A',
    },
    headerIconWrap: {
        position: 'absolute',
        left: 16,
        justifyContent: 'center',
        alignItems: 'center',
    },
    headerIcon: { fontSize: 24 },
    title: {
        color: '#FAFAFA',
        fontSize: 18,
        fontWeight: '700',
        letterSpacing: -0.3,
    },
    mapContainer: { flex: 1, width: '100%', height: '100%' },
    map: { flex: 1, width: '100%', height: '100%' },
    floatingMenu: {
        position: 'absolute',
        bottom: 24,
        left: 16,
        right: 16,
        backgroundColor: '#FFFFFF',
        borderRadius: 18,
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'center',
        height: 72,
        paddingHorizontal: 4,
        borderWidth: 1.5,
        borderColor: '#BFBFBF',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.1,
        shadowRadius: 12,
        elevation: 10,
        zIndex: 10,
    },
    menuItem: { flex: 1, alignItems: 'center', justifyContent: 'center', height: '100%', paddingVertical: 10 },
    menuText: { fontSize: 17, color: '#636363', fontWeight: '600' },
    activeMenuText: { color: '#09090B', fontWeight: '800' },
    menuActiveIndicator: {
        width: 28,
        height: 3,
        backgroundColor: '#09090B',
        borderRadius: 2,
        marginTop: 4,
    },
    zoomControls: {
        position: 'absolute',
        bottom: 172,
        right: 16,
        backgroundColor: '#FFFFFF',
        borderRadius: 14,
        borderWidth: 1.5,
        borderColor: '#BFBFBF',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.15,
        shadowRadius: 4,
        elevation: 5,
        zIndex: 11,
        overflow: 'hidden',
    },
    zoomButton: {
        width: 56,
        height: 52,
        justifyContent: 'center',
        alignItems: 'center',
    },
    zoomButtonText: {
        fontSize: 26,
        fontWeight: '700',
        color: '#18181B',
    },
    zoomDivider: {
        height: 1,
        backgroundColor: '#BFBFBF',
    },
    gpsButton: {
        position: 'absolute',
        bottom: 108,
        right: 16,
        width: 56,
        height: 56,
        borderRadius: 14,
        backgroundColor: '#18181B',
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: '#27272A',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 4,
        elevation: 5,
        zIndex: 11,
    },
    gpsButtonText: { fontSize: 14, color: '#FAFAFA', fontWeight: '700', letterSpacing: -0.3 },
    mapTypeContainer: {
        position: 'absolute',
        top: 62,
        left: '50%',
        transform: [{ translateX: -90 }],
        flexDirection: 'row',
        backgroundColor: '#FFFFFF',
        borderRadius: 20,
        borderWidth: 1,
        borderColor: '#E4E4E7',
        overflow: 'hidden',
        elevation: 6,
        shadowColor: '#000',
        shadowOpacity: 0.12,
        shadowOffset: { width: 0, height: 2 },
        shadowRadius: 6,
        zIndex: 39,
    },
    tabButton: {
        paddingVertical: 10,
        paddingHorizontal: 18,
        backgroundColor: '#FFFFFF',
    },
    activeTabButton: { backgroundColor: '#18181B' },
    tabButtonText: { fontSize: 14, color: '#525252', fontWeight: '600' },
    activeTabButtonText: { color: '#FFFFFF', fontWeight: '700' },

    // 하단 패널
    bottomPanel: {
        position: 'absolute',
        bottom: 125,
        left: 16,
        right: 16,
        backgroundColor: '#FAFAFA',
        borderRadius: 12,
        padding: 16,
        borderWidth: 1,
        borderColor: '#E4E4E7',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -2 },
        shadowOpacity: 0.08,
        shadowRadius: 8,
        elevation: 20,
        zIndex: 20,
    },
    bottomPanelHandle: {
        width: 32,
        height: 3,
        backgroundColor: '#D4D4D8',
        borderRadius: 2,
        alignSelf: 'center',
        marginBottom: 12,
    },
    bottomPanelTopRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginBottom: 10,
    },
    bottomPanelIcons: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginLeft: 8,
    },
    bottomPanelIconBtn: {
        width: 44,
        height: 44,
        borderRadius: 10,
        backgroundColor: '#F4F4F5',
        justifyContent: 'center',
        alignItems: 'center',
    },
    bottomPanelIconText: { fontSize: 20 },
    bottomPanelClose: {
        padding: 10,
    },
    bottomPanelCloseText: { fontSize: 20, color: '#525252', fontWeight: '600' },
    bottomPanelAddress: { fontSize: 17, color: '#18181B', fontWeight: '700', marginBottom: 6, letterSpacing: -0.2 },
    bottomPanelCoord: { fontSize: 13, color: '#737373', marginBottom: 4, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
    bottomPanelButtons: { flexDirection: 'row', gap: 8 },
    bottomPanelButton: {
        flex: 1,
        paddingVertical: 14,
        backgroundColor: '#4A90E2',
        borderRadius: 10,
        alignItems: 'center',
        minHeight: 48,
        justifyContent: 'center',
    },
    bottomPanelButtonRoadview: {
        paddingVertical: 14,
        paddingHorizontal: 18,
        backgroundColor: '#18181B',
        borderRadius: 10,
        alignItems: 'center',
        minHeight: 48,
        justifyContent: 'center',
    },
    bottomPanelButtonRegistry: {
        flex: 1,
        paddingVertical: 14,
        backgroundColor: '#18181B',
        borderRadius: 10,
        alignItems: 'center',
        minHeight: 48,
        justifyContent: 'center',
    },
    bottomPanelButtonText: { color: '#FAFAFA', fontSize: 15, fontWeight: '600', textAlign: 'center' },

    // 로딩 오버레이
    loadingOverlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 100,
    },
    loadingBox: {
        backgroundColor: '#FAFAFA',
        borderRadius: 12,
        padding: 24,
        width: Dimensions.get('window').width * 0.75,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: '#E4E4E7',
    },
    loadingText: { fontSize: 17, color: '#18181B', textAlign: 'center', marginBottom: 16, fontWeight: '500', lineHeight: 24 },
    progressBarContainer: { width: '100%', height: 6, backgroundColor: '#E4E4E7', borderRadius: 3, overflow: 'hidden' },
    progressBar: { height: '100%', backgroundColor: '#18181B', borderRadius: 3 },
    progressText: { fontSize: 14, color: '#737373', marginTop: 8 },

    // 모달 (등기정보 Tilko)
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'flex-end',
    },
    modalContent: {
        backgroundColor: '#FAFAFA',
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        padding: 20,
        paddingBottom: 34,
        borderTopWidth: 1,
        borderTopColor: '#E4E4E7',
    },
    modalTitle: { fontSize: 19, fontWeight: '700', color: '#18181B', marginBottom: 18, textAlign: 'center', letterSpacing: -0.3 },
    modalLabel: { fontSize: 15, color: '#525252', fontWeight: '600', marginBottom: 6 },
    modalInput: {
        borderWidth: 1.5,
        borderColor: '#BFBFBF',
        borderRadius: 10,
        padding: 14,
        fontSize: 17,
        marginBottom: 12,
        backgroundColor: '#fff',
        minHeight: 48,
    },
    modalSearchButton: {
        backgroundColor: '#18181B',
        paddingVertical: 16,
        borderRadius: 10,
        alignItems: 'center',
        minHeight: 52,
        justifyContent: 'center',
    },
    modalSearchButtonText: { color: '#FAFAFA', fontWeight: '700', fontSize: 17 },
    modalResultBox: {
        backgroundColor: '#F4F4F5',
        borderRadius: 10,
        padding: 16,
        marginBottom: 16,
        borderWidth: 1.5,
        borderColor: '#BFBFBF',
    },
    modalResultLabel: { fontSize: 14, color: '#525252', fontWeight: '600', marginBottom: 4 },
    modalResultValue: { fontSize: 17, color: '#18181B', fontWeight: '700', marginBottom: 10 },
    modalErrorText: { fontSize: 16, color: '#C62828', textAlign: 'center', fontWeight: '600' },
    modalCloseButton: {
        paddingVertical: 16,
        backgroundColor: '#F4F4F5',
        borderRadius: 10,
        alignItems: 'center',
        marginTop: 8,
        borderWidth: 1.5,
        borderColor: '#BFBFBF',
        minHeight: 52,
        justifyContent: 'center',
    },
    modalCloseButtonText: { fontSize: 17, color: '#333333', fontWeight: '600' },

    // PropertyDetailModal
    propModalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 16,
    },
    propModalTitle: { fontSize: 19, fontWeight: '700', color: '#18181B', flex: 1, marginRight: 10, letterSpacing: -0.3 },
    statusBadge: {
        paddingHorizontal: 14,
        paddingVertical: 6,
        borderRadius: 8,
    },
    statusBadgeText: { color: '#fff', fontSize: 14, fontWeight: '700' },
    propSection: {
        backgroundColor: '#F4F4F5',
        borderRadius: 8,
        padding: 14,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: '#E4E4E7',
    },
    propSectionTitle: { fontSize: 16, fontWeight: '700', color: '#18181B', marginBottom: 12, letterSpacing: -0.2 },
    propRow: {
        flexDirection: 'row',
        marginBottom: 10,
        alignItems: 'flex-start',
    },
    propLabel: { fontSize: 14, color: '#525252', width: 90, flexShrink: 0, paddingTop: 2, fontWeight: '500' },
    propValue: { fontSize: 16, color: '#18181B', flex: 1, lineHeight: 24 },
    statusGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        marginBottom: 14,
    },
    statusChip: {
        paddingHorizontal: 18,
        paddingVertical: 10,
        borderRadius: 8,
        borderWidth: 1.5,
        minHeight: 44,
        justifyContent: 'center',
        alignItems: 'center',
    },
    statusChipText: { fontSize: 15, fontWeight: '600' },
    memoInput: {
        borderWidth: 1.5,
        borderColor: '#BFBFBF',
        borderRadius: 10,
        padding: 14,
        fontSize: 17,
        minHeight: 100,
        backgroundColor: '#fff',
    },
    propModalButtons: {
        flexDirection: 'row',
        gap: 10,
        paddingTop: 12,
        borderTopWidth: 1,
        borderTopColor: '#eee',
        marginTop: 4,
    },
    // 등기 이력 툴바 (건수 + CSV 버튼)
    historyToolbar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 6,
        backgroundColor: '#F4F4F5',
        borderBottomWidth: 1,
        borderBottomColor: '#E4E4E7',
    },
    exportButton: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: '#18181B',
        borderRadius: 8,
        minHeight: 44,
        justifyContent: 'center',
    },
    exportButtonText: {
        color: '#FAFAFA',
        fontSize: 14,
        fontWeight: '600',
    },

    propCancelButton: {
        flex: 1,
        paddingVertical: 16,
        backgroundColor: '#F4F4F5',
        borderRadius: 10,
        alignItems: 'center',
        borderWidth: 1.5,
        borderColor: '#BFBFBF',
        minHeight: 52,
        justifyContent: 'center',
    },
    propCancelButtonText: { fontSize: 17, color: '#333333', fontWeight: '600' },
    propSaveButton: {
        flex: 2,
        paddingVertical: 16,
        backgroundColor: '#18181B',
        borderRadius: 10,
        alignItems: 'center',
        minHeight: 52,
        justifyContent: 'center',
    },
    propSaveButtonText: { fontSize: 17, color: '#FAFAFA', fontWeight: '700' },

    // 리스트 화면
    listContainer: { flex: 1, backgroundColor: '#FAFAFA' },
    listHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#E4E4E7',
    },
    listTitle: { fontSize: 17, fontWeight: '700', color: '#18181B', letterSpacing: -0.2 },
    refreshText: { fontSize: 15, color: '#333333' },
    listItemContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        borderBottomWidth: 2,
        borderBottomColor: '#EBEBEB',
        minHeight: 72,
    },
    listItem: { flex: 1, padding: 16 },
    itemHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
    itemName: { fontSize: 17, fontWeight: '700', color: '#18181B', flex: 1, letterSpacing: -0.2 },
    itemDistance: { fontSize: 14, color: '#737373', marginLeft: 8 },
    itemAddress: { fontSize: 15, color: '#525252', marginTop: 4 },
    itemDate: { fontSize: 13, color: '#737373', marginTop: 4 },
    categoryBadge: {
        alignSelf: 'flex-start',
        backgroundColor: '#F4F4F5',
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
        marginBottom: 6,
        borderWidth: 1,
        borderColor: '#BFBFBF',
    },
    categoryBadgeText: { fontSize: 13, color: '#333333', fontWeight: '600' },
    listItemActions: {
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        paddingRight: 14,
        gap: 10,
    },
    listItemIconBtn: {
        width: 44,
        height: 44,
        borderRadius: 10,
        backgroundColor: '#F4F4F5',
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: '#BFBFBF',
    },
    listItemIconText: { fontSize: 20 },
    moveButton: {
        flex: 1,
        paddingVertical: 12,
        backgroundColor: '#18181B',
        borderRadius: 8,
        alignItems: 'center',
        minHeight: 44,
        justifyContent: 'center',
    },
    moveButtonText: { color: '#FAFAFA', fontSize: 15, fontWeight: '600' },
    favoriteButton: {
        flex: 1,
        paddingVertical: 12,
        backgroundColor: '#18181B',
        borderRadius: 8,
        alignItems: 'center',
        minHeight: 44,
        justifyContent: 'center',
    },
    favoriteButtonText: { color: '#FAFAFA', fontSize: 15, fontWeight: '600' },

    // 서브 화면
    subScreenContainer: { flex: 1, backgroundColor: '#FAFAFA' },
    subScreenHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#E4E4E7',
    },
    subScreenTitle: { fontSize: 19, fontWeight: '700', color: '#18181B', letterSpacing: -0.3 },
    backButton: { padding: 8, minWidth: 48, minHeight: 48, justifyContent: 'center' },
    backButtonText: { fontSize: 17, color: '#333333', fontWeight: '500' },
    searchContainer: {
        flexDirection: 'row',
        padding: 12,
        gap: 10,
        borderBottomWidth: 1.5,
        borderBottomColor: '#BFBFBF',
    },
    searchInput: {
        flex: 1,
        borderWidth: 1.5,
        borderColor: '#BFBFBF',
        borderRadius: 10,
        paddingHorizontal: 14,
        paddingVertical: 12,
        fontSize: 17,
        backgroundColor: '#fff',
        minHeight: 48,
    },
    searchButton: {
        backgroundColor: '#18181B',
        paddingHorizontal: 20,
        borderRadius: 10,
        justifyContent: 'center',
        minHeight: 48,
    },
    searchButtonText: { color: '#FAFAFA', fontWeight: '600', fontSize: 16 },
    clearButton: { padding: 12, justifyContent: 'center', minWidth: 44, minHeight: 44 },
    clearButtonText: { color: '#636363', fontSize: 16, fontWeight: '600' },
    viewLocationButton: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        marginRight: 8,
        backgroundColor: '#18181B',
        borderRadius: 8,
        minHeight: 44,
        justifyContent: 'center',
    },
    viewLocationButtonText: { color: '#FAFAFA', fontSize: 15, fontWeight: '600' },

    // 다음 주소검색
    daumSearchButton: {
        marginHorizontal: 12,
        marginTop: 12,
        marginBottom: 4,
        paddingVertical: 16,
        backgroundColor: '#18181B',
        borderRadius: 10,
        alignItems: 'center',
        minHeight: 52,
        justifyContent: 'center',
    },
    daumSearchButtonText: {
        fontSize: 17,
        fontWeight: '700',
        color: '#FAFAFA',
    },
    daumModalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#E4E4E7',
        backgroundColor: '#FAFAFA',
    },
    daumModalTitle: { fontSize: 19, fontWeight: '700', color: '#18181B', letterSpacing: -0.3 },
    daumModalClose: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: 16,
        backgroundColor: '#18181B',
        borderRadius: 8,
        minHeight: 48,
    },
    daumModalCloseText: { color: '#FAFAFA', fontSize: 16, fontWeight: '600' },

    // 위치 버튼 (검색결과 옆)
    locationButton: {
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginRight: 10,
        backgroundColor: '#18181B',
        borderRadius: 8,
        minWidth: 62,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    locationButtonText: { color: '#FAFAFA', fontSize: 15, fontWeight: '600', textAlign: 'center', lineHeight: 20 },

    // 다음 주소검색 확인 카드
    pendingCard: {
        marginHorizontal: 12,
        marginTop: 10,
        backgroundColor: '#FAFAFA',
        borderRadius: 8,
        padding: 14,
        borderWidth: 1,
        borderColor: '#E4E4E7',
    },
    pendingCardBadge: {
        alignSelf: 'flex-start',
        backgroundColor: '#18181B',
        borderRadius: 4,
        paddingHorizontal: 8,
        paddingVertical: 3,
        marginBottom: 8,
    },
    pendingCardBadgeText: { color: '#FAFAFA', fontSize: 13, fontWeight: '600' },
    pendingCardName: { fontSize: 17, fontWeight: '700', color: '#18181B', marginBottom: 6, letterSpacing: -0.2 },
    pendingCardAddress: { fontSize: 15, color: '#525252', marginBottom: 4 },
    pendingCardCoord: { fontSize: 13, color: '#737373', marginBottom: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
    pendingCardButtons: { flexDirection: 'row', gap: 10 },
    pendingCancelButton: {
        flex: 1,
        paddingVertical: 14,
        backgroundColor: '#F4F4F5',
        borderRadius: 8,
        alignItems: 'center',
        borderWidth: 1.5,
        borderColor: '#BFBFBF',
        minHeight: 48,
        justifyContent: 'center',
    },
    pendingCancelButtonText: { fontSize: 16, color: '#333333', fontWeight: '600' },
    pendingConfirmButton: {
        flex: 2,
        paddingVertical: 14,
        backgroundColor: '#18181B',
        borderRadius: 8,
        alignItems: 'center',
        minHeight: 48,
        justifyContent: 'center',
    },
    pendingConfirmButtonText: { fontSize: 16, color: '#FAFAFA', fontWeight: '700' },
    deleteButton: { paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#18181B', borderRadius: 8, justifyContent: 'center', alignItems: 'center', marginLeft: 8, minHeight: 44 },
    deleteButtonText: { fontSize: 15, color: '#FAFAFA', fontWeight: '600' },
    emptyContainer: { padding: 40, alignItems: 'center' },
    emptyText: { fontSize: 16, color: '#737373', textAlign: 'center', lineHeight: 26 },
    loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },

    // 더보기 메뉴
    menuContainer: { flex: 1, padding: 16, gap: 8, backgroundColor: '#FAFAFA' },
    menuButton: {
        padding: 18,
        backgroundColor: '#fff',
        borderRadius: 10,
        borderWidth: 1.5,
        borderColor: '#BFBFBF',
        minHeight: 56,
        justifyContent: 'center',
    },
    menuButtonText: { fontSize: 17, color: '#18181B', fontWeight: '600' },

    // 등기 조회내역 배지
    registryOwnerBadge: {
        backgroundColor: '#F4F4F5',
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: '#BFBFBF',
    },
    registryOwnerBadgeText: { fontSize: 13, color: '#18181B', fontWeight: '600' },
    registryUnknownBadge: {
        backgroundColor: '#F4F4F5',
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 4,
    },
    registryUnknownBadgeText: { fontSize: 13, color: '#737373' },
    registryOwnerAddr: { fontSize: 14, color: '#525252', marginBottom: 2 },

    // 스켈레톤
    skeletonBox: {
        backgroundColor: '#E0E0E0',
        borderRadius: 4,
    },
    loaderFooter: { padding: 16, alignItems: 'center' },
});
