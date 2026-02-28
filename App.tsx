import './global.css';
import 'react-native-url-polyfill/auto';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
    StyleSheet, Text, View, SafeAreaView, TouchableOpacity,
    Platform, StatusBar, Alert, FlatList, Animated,
    ActivityIndicator, Dimensions, TextInput, Modal, ScrollView,
    Share, Image, Linking, AppState, AppStateStatus,
} from 'react-native';
import KakaoMapView, { KakaoMapHandle, type MapRegion as Region } from './KakaoMapView';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { VWORLD_API_KEY, TILKO_API_KEY, IROS_USER_ID, IROS_USER_PASSWORD, EMONEY_NO1, EMONEY_NO2, EMONEY_PWD, KAKAO_API_KEY } from '@env';
import forge from 'node-forge';
import { supabase, type Property, type SalesStatus } from './lib/supabase';

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

const { width, height } = Dimensions.get('window');
const RECENT_PLACES_KEY = 'recent_places';
const FAVORITE_PLACES_KEY = 'favorite_places';
const REGISTRY_CACHE_KEY = 'registry_cache';
const OFFLINE_QUEUE_KEY = 'offline_queue';
const BUILDING_FILTER_KEY = 'building_filter';
const NOTIFICATION_STORE_KEY = 'notification_store';
const ELDERLY_MODE_KEY = 'elderly_mode';

// 태양광 설치 기준 면적 (㎡)
const SOLAR_MIN_AREA_SMALL = 200;   // 소형 (필터 1단계)
const SOLAR_MIN_AREA_MEDIUM = 500;  // 중형 (필터 2단계)
const SOLAR_MIN_AREA_LARGE = 1000;  // 대형 (필터 3단계)

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

type MapType = 'standard' | 'cadastral';

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
                    const R = 6371e3;
                    const φ1 = currentRegion.latitude * Math.PI / 180;
                    const φ2 = itemLat * Math.PI / 180;
                    const Δφ = (itemLat - currentRegion.latitude) * Math.PI / 180;
                    const Δλ = (itemLng - currentRegion.longitude) * Math.PI / 180;
                    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
                    const distance = Math.floor(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));

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
                        const R = 6371e3;
                        const φ1 = currentRegion.latitude * Math.PI / 180;
                        const φ2 = itemLat * Math.PI / 180;
                        const Δφ = (itemLat - currentRegion.latitude) * Math.PI / 180;
                        const Δλ = (itemLng - currentRegion.longitude) * Math.PI / 180;
                        const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
                        const distance = Math.floor(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
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
        return '[잔액부족] 전자민원 캐시(전자화폐) 잔액이 부족합니다.\n전자민원 포털에서 충전 후 다시 시도해주세요.';
    }
    return '[잔액부족] 틸코 API 토큰 잔액이 부족합니다.\n틸코 API 포털(api.tilko.net)에서 충전 후 다시 시도해주세요.';
}

async function createTilkoEncryption() {
    const pubKeyRes = await fetch(`https://api.tilko.net/api/Auth/GetPublicKey?APIkey=${TILKO_API_KEY}`);
    const pubKeyJson = await pubKeyRes.json();
    const pubKeyRaw = pubKeyJson.PublicKey;
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

    return { encryptAES, encAesKey };
}

async function fetchRegistryInfo(pin: string): Promise<{ owner: string; address: string; xmlData: string }> {
    const { encryptAES, encAesKey } = await createTilkoEncryption();
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
    const clusterRadius = latitudeDelta * 1.2;
    const clusters: PropertyCluster[] = [];
    const assigned = new Set<string>();

    properties.forEach(prop => {
        if (assigned.has(prop.property_id)) return;

        const nearby = properties.filter(other => {
            if (assigned.has(other.property_id)) return false;
            return Math.abs(prop.lat - other.lat) < clusterRadius
                && Math.abs(prop.lng - other.lng) < clusterRadius;
        });

        nearby.forEach(p => assigned.add(p.property_id));

        const avgLat = nearby.reduce((s, p) => s + p.lat, 0) / nearby.length;
        const avgLng = nearby.reduce((s, p) => s + p.lng, 0) / nearby.length;

        const counts = nearby.reduce((acc, p) => {
            acc[p.sales_status] = (acc[p.sales_status] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);
        const dominantStatus = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '미접촉') as SalesStatus;

        clusters.push({
            id: `cluster-${prop.property_id}`,
            coordinate: { latitude: avgLat, longitude: avgLng },
            count: nearby.length,
            items: nearby,
            dominantStatus,
        });
    });
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
        throw new Error(searchJson.ErrorLog || searchJson.Message || '고유번호 검색 실패');
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
        const interval = setInterval(check, 30000);
        return () => { mounted = false; clearInterval(interval); };
    }, []);

    return isOnline;
}

// ===== 오프라인 배너 컴포넌트 =====

// GPS 버튼 반대편(왼쪽) 말풍선 형태 온/오프라인 표시
const NetworkBubble = ({ isOnline }: { isOnline: boolean }) => {
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
};

// 기존 OfflineBanner는 더 이상 사용하지 않지만 타입 호환을 위해 유지
const OfflineBanner = ({ isOnline, pendingCount }: { isOnline: boolean; pendingCount: number }) => null;

const offlineStyles = StyleSheet.create({
    bubble: {
        position: 'absolute',
        bottom: 135,
        left: 20,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 16,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
        elevation: 6,
        zIndex: 20,
    },
    offlineBubble: { backgroundColor: '#E53935' },
    onlineBubble: { backgroundColor: '#2E7D32' },
    bubbleText: { color: '#fff', fontSize: 13, fontWeight: '700' },
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
        borderTopColor: '#E53935',
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
        borderTopColor: '#2E7D32',
    },
    // 아래는 기존 코드 호환용 (사용 안함)
    banner: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 44,
        backgroundColor: '#E53935',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        zIndex: 999,
    },
    bannerIcon: { fontSize: 18 },
    bannerText: { color: '#fff', fontSize: 13, fontWeight: '700' },
});

// ===== 카카오 로드뷰 모달 =====

function buildStreetViewHTML(lat: number, lng: number, kakaoKey: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    html,body{width:100%;height:100%;background:#000;}
    #roadview{width:100%;height:100%;}
    #fallback{display:none;padding:40px 20px;color:#fff;text-align:center;font-size:15px;background:#222;height:100%;justify-content:center;align-items:center;flex-direction:column;}
    #fallback-icon{font-size:48px;margin-bottom:16px;}
  </style>
</head>
<body>
  <div id="roadview"></div>
  <div id="fallback">
    <div id="fallback-icon">🗺️</div>
    <p>이 위치에서는 로드뷰를 제공하지 않습니다.<br><small style="color:#aaa;margin-top:8px;display:block;">건물 외부 또는 주요 도로 주변으로 이동해 다시 시도하세요.</small></p>
  </div>
  <script src="//dapi.kakao.com/v2/maps/sdk.js?appkey=${kakaoKey}&libraries=services"></script>
  <script>
    try {
      var rv = new kakao.maps.Roadview(document.getElementById('roadview'));
      var rvc = new kakao.maps.RoadviewClient();
      rvc.getNearestPanoId(new kakao.maps.LatLng(${lat},${lng}), 50, function(panoId) {
        if (panoId === null) {
          document.getElementById('roadview').style.display='none';
          document.getElementById('fallback').style.display='flex';
        } else {
          rv.setPanoId(panoId, new kakao.maps.LatLng(${lat},${lng}));
        }
      });
    } catch(e) {
      document.getElementById('roadview').style.display='none';
      document.getElementById('fallback').style.display='flex';
      document.getElementById('fallback-icon').innerText='⚠️';
      document.querySelector('#fallback p').innerText='로드뷰 로드 오류: '+e.message;
    }
  </script>
</body>
</html>`;
}

const StreetViewModal = ({
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
    const kakaoKey = KAKAO_API_KEY || '';
    const html = useMemo(
        () => buildStreetViewHTML(latitude, longitude, kakaoKey),
        [latitude, longitude, kakaoKey],
    );

    return (
        <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
            <SafeAreaView style={{ flex: 1, backgroundColor: '#000' }}>
                <View style={svStyles.header}>
                    <Text style={svStyles.title} numberOfLines={1}>
                        🗺️ {title || '로드뷰'}
                    </Text>
                    <TouchableOpacity onPress={onClose} style={svStyles.closeBtn}>
                        <Text style={svStyles.closeTxt}>닫기</Text>
                    </TouchableOpacity>
                </View>
                {!kakaoKey ? (
                    <View style={svStyles.noKey}>
                        <Text style={svStyles.noKeyText}>
                            .env에 KAKAO_API_KEY를 설정해 주세요.{'\n'}
                            (kakao developers → 내 애플리케이션 → JavaScript 키)
                        </Text>
                    </View>
                ) : (
                    <WebView
                        source={{ html, baseUrl: 'https://dapi.kakao.com' }}
                        style={{ flex: 1 }}
                        javaScriptEnabled
                        domStorageEnabled
                        originWhitelist={['*']}
                        mixedContentMode="always"
                        startInLoadingState
                        renderLoading={() => (
                            <View style={svStyles.loading}>
                                <ActivityIndicator color="#fff" size="large" />
                                <Text style={{ color: '#fff', marginTop: 12 }}>로드뷰 불러오는 중...</Text>
                            </View>
                        )}
                    />
                )}
            </SafeAreaView>
        </Modal>
    );
};

const svStyles = StyleSheet.create({
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: '#1A1A1A',
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    title: { color: '#fff', fontSize: 15, fontWeight: '700', flex: 1, marginRight: 12 },
    closeBtn: { paddingHorizontal: 14, paddingVertical: 6, backgroundColor: '#444', borderRadius: 8 },
    closeTxt: { color: '#fff', fontSize: 14, fontWeight: '600' },
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

const FilterBar = ({
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
                <Text style={filterStyles.headerIcon}>{hasActiveFilter ? '🔆' : '🔽'}</Text>
                <Text style={[filterStyles.headerText, hasActiveFilter && { color: '#1565C0' }]}>
                    필터{hasActiveFilter ? ' (적용중)' : ''}
                </Text>
                <Text style={filterStyles.countText}>{filteredCount}/{totalCount}건</Text>
                {hasActiveFilter && (
                    <TouchableOpacity
                        onPress={() => onChange(DEFAULT_FILTER)}
                        style={filterStyles.resetBtn}
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
                    >
                        <Text style={filterStyles.toggleLabel}>
                            ⚡ 고잠재력만 보기 (500㎡+ 공장/창고)
                        </Text>
                        <View style={[filterStyles.toggle, filter.onlyHighPotential && filterStyles.toggleOn]}>
                            <View style={[filterStyles.toggleThumb, filter.onlyHighPotential && filterStyles.toggleThumbOn]} />
                        </View>
                    </TouchableOpacity>
                </View>
            )}
        </View>
    );
};

const filterStyles = StyleSheet.create({
    wrapper: { backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#eee' },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        paddingVertical: 10,
        gap: 8,
    },
    headerActive: { backgroundColor: '#E3F2FD' },
    headerIcon: { fontSize: 16 },
    headerText: { fontSize: 14, color: '#555', fontWeight: '600', flex: 1 },
    countText: { fontSize: 12, color: '#888' },
    resetBtn: { paddingHorizontal: 10, paddingVertical: 4, backgroundColor: '#1565C0', borderRadius: 8 },
    resetText: { color: '#fff', fontSize: 11, fontWeight: '700' },
    panel: { paddingHorizontal: 14, paddingBottom: 14 },
    sectionLabel: { fontSize: 12, color: '#888', fontWeight: '600', marginBottom: 8, marginTop: 10 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1.5, borderColor: '#ddd', backgroundColor: '#fff' },
    chipActive: { borderColor: '#1565C0', backgroundColor: '#1565C0' },
    chipText: { fontSize: 13, color: '#555', fontWeight: '600' },
    chipTextActive: { color: '#fff' },
    toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#f0f0f0' },
    toggleLabel: { fontSize: 13, color: '#333', flex: 1 },
    toggle: { width: 44, height: 24, borderRadius: 12, backgroundColor: '#ddd', padding: 2 },
    toggleOn: { backgroundColor: '#1565C0' },
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
        backgroundColor: '#F8F9FA',
        borderRadius: 12,
        padding: 14,
        marginBottom: 12,
    },
    sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
    addBtn: { backgroundColor: '#4A90E2', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
    addBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
    empty: { fontSize: 13, color: '#aaa', textAlign: 'center', paddingVertical: 16 },
    photoWrap: { marginRight: 10, borderRadius: 8, overflow: 'hidden' },
    photo: { width: 100, height: 100, borderRadius: 8 },
    deleteHint: { backgroundColor: 'rgba(0,0,0,0.4)', paddingVertical: 3, alignItems: 'center' },
    deleteHintText: { color: '#fff', fontSize: 10 },
});

// ===== 알림 스케줄 섹션 (PropertyDetailModal 내부) =====

const NotificationSection = ({ property }: { property: Property }) => {
    const [scheduledInfo, setScheduledInfo] = useState<{ notificationId: string; scheduledDate: string } | null>(null);
    const [showDatePicker, setShowDatePicker] = useState(false);
    const [dateInput, setDateInput] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        getScheduledNotification(property.property_id).then(setScheduledInfo);
    }, [property.property_id]);

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

            {scheduledInfo ? (
                <View style={notifStyles.scheduledBox}>
                    <Text style={notifStyles.scheduledIcon}>🔔</Text>
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
                    <Text style={notifStyles.addBtnText}>🔔 연락 예정일 알림 설정</Text>
                </TouchableOpacity>
            )}
        </View>
    );
};

const notifStyles = StyleSheet.create({
    section: { backgroundColor: '#FFF8E1', borderRadius: 12, padding: 14, marginBottom: 12 },
    scheduledBox: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    scheduledIcon: { fontSize: 24 },
    scheduledDate: { fontSize: 15, fontWeight: '700', color: '#333' },
    scheduledSub: { fontSize: 12, color: '#888', marginTop: 2 },
    cancelBtn: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#F44336', borderRadius: 8 },
    cancelBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
    addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FF9800', borderRadius: 10, paddingVertical: 12 },
    addBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
    pickerBox: {},
    dateInput: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 10, fontSize: 15 },
    cancelTextBtn: { flex: 1, alignItems: 'center', paddingVertical: 10 },
    confirmBtn: { flex: 2, backgroundColor: '#FF9800', borderRadius: 8, alignItems: 'center', paddingVertical: 10 },
    confirmBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
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
                <View style={[styles.modalContent, { maxHeight: height * 0.88 }]}>
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
                        <NotificationSection property={property} />

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
    favorable: '✅',
    neutral: 'ℹ️',
    restricted: '⚠️',
};

const LandUsePanel = ({
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
};

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
    const [fromCache, setFromCache] = useState(false);
    const [directMode, setDirectMode] = useState(false);
    const [directPin, setDirectPin] = useState('');
    const [xmlData, setXmlData] = useState('');
    const [xmlModalVisible, setXmlModalVisible] = useState(false);
    const [landUseInfo, setLandUseInfo] = useState<LandUseInfo | null>(null);
    const [isLoadingLandUse, setIsLoadingLandUse] = useState(false);

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
            setResult({ owner: info.owner, address: info.address });
            setXmlData(info.xmlData || '');
            setStatus('');
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
            setResult({ owner: info.owner, address: info.address });
            setXmlData(info.xmlData || '');
            setStatus('');
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
        setStatus('');
        setFromCache(false);
        setXmlData('');
        setDirectMode(false);
        setDirectPin('');
        setLandUseInfo(null);
        onClose();
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
                <ActivityIndicator size="large" color="#4A90E2" style={{ marginBottom: 20 }} />
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
            Alert.alert('오류', '검색 중 문제가 발생했습니다.');
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
        <View style={styles.subScreenContainer}>
            {/* 헤더 */}
            <View style={styles.subScreenHeader}>
                <TouchableOpacity onPress={onBack} style={styles.backButton} accessibilityLabel="뒤로 가기" accessibilityRole="button">
                    <Text style={[styles.backButtonText, { fontSize: fs.lg }]}>{'< 뒤로'}</Text>
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
                    <ActivityIndicator size="large" color="#4A90E2" />
                    <Text style={{ marginTop: 10, color: '#888' }}>검색 중...</Text>
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
                            <Text style={styles.pendingConfirmButtonText}>✓ 확인 (목록에 추가)</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            )}

            {/* 결과 목록 */}
            {!isLoading && (
                <FlatList
                    data={searchResults}
                    keyExtractor={(item) => item.id}
                    renderItem={({ item }) => (
                        <View style={[styles.listItemContainer, elderlyMode && { minHeight: 72 }]}>
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
                            Alert.alert("삭제 확인", "삭제하시겠습니까?", [
                                { text: "취소", style: "cancel" },
                                { text: "확인", onPress: async () => { await removeRecentPlace(item.id); loadPlaces(); } }
                            ]);
                        }} accessibilityLabel={`${item.name} 삭제`} accessibilityRole="button">
                            <Text style={[styles.deleteButtonText, elderlyMode && { fontSize: 22 }]}>🗑️</Text>
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
                            Alert.alert("삭제 확인", "즐겨찾기에서 삭제하시겠습니까?", [
                                { text: "취소", style: "cancel" },
                                { text: "확인", onPress: async () => { await removeFavoritePlace(item.id); loadPlaces(); } }
                            ]);
                        }} accessibilityLabel={`${item.name} 즐겨찾기에서 삭제`} accessibilityRole="button">
                            <Text style={[styles.deleteButtonText, elderlyMode && { fontSize: 22 }]}>🗑️</Text>
                        </TouchableOpacity>
                    </View>
                )}
                ListEmptyComponent={<View style={styles.emptyContainer}><Text style={[styles.emptyText, { fontSize: fs.base }]}>{searchText ? "검색 결과가 없습니다." : "즐겨 찾는 장소가 없습니다."}</Text></View>}
            />
        </View>
    );
};

// ===== RegistryHistoryScreen (등기 열람 이력) =====

const RegistryHistoryScreen = ({ onBack }: { onBack: () => void }) => {
    const [records, setRecords] = useState<RegistryViewRecord[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchText, setSearchText] = useState('');
    const [selectedRecord, setSelectedRecord] = useState<RegistryViewRecord | null>(null);
    const [detailVisible, setDetailVisible] = useState(false);
    const [histXmlModalVisible, setHistXmlModalVisible] = useState(false);
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
            if (!error && data) setRecords(data);
        } catch (e) {
            console.warn('열람 이력 조회 실패:', e);
        } finally {
            setIsLoading(false);
        }
    };

    const handleDelete = (id: string) => {
        Alert.alert('삭제 확인', '이 열람 이력을 삭제하시겠습니까?', [
            { text: '취소', style: 'cancel' },
            {
                text: '삭제',
                style: 'destructive',
                onPress: async () => {
                    await supabase.from('registry_views').delete().eq('id', id);
                    setRecords(prev => prev.filter(r => r.id !== id));
                    if (selectedRecord?.id === id) setDetailVisible(false);
                },
            },
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

        const BOM = '\uFEFF'; // Excel UTF-8 호환을 위한 BOM
        const headers = '소유자명,소유자주소,부동산주소(도로명),부동산주소(지번),열람일시';
        const rows = exportable.map(r => [
            `"${(r.owner_name || '').replace(/"/g, '""')}"`,
            `"${(r.owner_address || '').replace(/"/g, '""')}"`,
            `"${(r.road_address || '').replace(/"/g, '""')}"`,
            `"${(r.jibun_address || '').replace(/"/g, '""')}"`,
            `"${new Date(r.viewed_at).toLocaleString('ko-KR')}"`,
        ].join(',')).join('\n');

        const csvContent = BOM + headers + '\n' + rows;

        try {
            await Share.share({
                title: `소유주 주소 목록 (${exportable.length}건)`,
                message: csvContent,
            });
        } catch (e: any) {
            Alert.alert('공유 실패', e.message);
        }
    };

    return (
        <View style={styles.subScreenContainer}>
            {/* 헤더 */}
            <View style={styles.subScreenHeader}>
                <TouchableOpacity onPress={onBack} style={styles.backButton} accessibilityLabel="뒤로 가기" accessibilityRole="button">
                    <Text style={[styles.backButtonText, { fontSize: fs.lg }]}>{'< 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={[styles.subScreenTitle, { fontSize: fs['2xl'] }]}>등기 열람 이력</Text>
                <TouchableOpacity onPress={loadHistory} style={{ paddingRight: 12, paddingVertical: elderlyMode ? 8 : 0 }} accessibilityLabel="새로고침" accessibilityRole="button">
                    <Text style={{ color: '#4A90E2', fontSize: fs.md, fontWeight: '600' }}>새로고침</Text>
                </TouchableOpacity>
            </View>

            {/* 검색 */}
            <View style={styles.searchContainer}>
                <TextInput
                    style={[styles.searchInput, { fontSize: fs.base }, elderlyMode && { paddingVertical: 12 }]}
                    placeholder="주소 또는 소유자명 검색..."
                    value={searchText}
                    onChangeText={setSearchText}
                    accessibilityLabel="주소 또는 소유자명 검색"
                />
                {searchText.length > 0 && (
                    <TouchableOpacity onPress={() => setSearchText('')} style={[styles.clearButton, elderlyMode && { padding: 12 }]} accessibilityLabel="검색어 지우기" accessibilityRole="button">
                        <Text style={[styles.clearButtonText, { fontSize: fs.base }]}>X</Text>
                    </TouchableOpacity>
                )}
            </View>

            {/* 건수 요약 + CSV 내보내기 */}
            {!isLoading && (
                <View style={{ paddingHorizontal: 16, paddingVertical: elderlyMode ? 10 : 6, backgroundColor: '#F5F5F5' }}>
                    <Text style={{ fontSize: fs.sm, color: '#888' }}>
                        총 {filtered.length}건 | 소유자 확인: {filtered.filter(r => r.owner_name).length}건
                    </Text>
                    <TouchableOpacity
                        style={styles.exportButton}
                        onPress={handleExportCSV}
                    >
                        <Text style={styles.exportButtonText}>📋 CSV 내보내기</Text>
                    </TouchableOpacity>
                </View>
            )}

            {isLoading ? (
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color="#4A90E2" />
                    <Text style={{ marginTop: 10, color: '#888' }}>열람 이력 로딩 중...</Text>
                </View>
            ) : (
                <FlatList
                    data={filtered}
                    keyExtractor={(item) => item.id}
                    renderItem={({ item }) => (
                        <View style={styles.listItemContainer}>
                            <TouchableOpacity
                                style={styles.listItem}
                                onPress={() => { setSelectedRecord(item); setDetailVisible(true); }}
                            >
                                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                                    <Text style={[styles.itemName, { flex: 1, marginRight: 8 }]} numberOfLines={1}>
                                        {item.road_address || item.jibun_address || '주소 없음'}
                                    </Text>
                                    {item.owner_name ? (
                                        <View style={styles.registryOwnerBadge}>
                                            <Text style={styles.registryOwnerBadgeText}>{item.owner_name}</Text>
                                        </View>
                                    ) : (
                                        <View style={styles.registryUnknownBadge}>
                                            <Text style={styles.registryUnknownBadgeText}>소유자 미확인</Text>
                                        </View>
                                    )}
                                </View>
                                {item.owner_address ? (
                                    <Text style={styles.registryOwnerAddr} numberOfLines={1}>
                                        실거주: {item.owner_address}
                                    </Text>
                                ) : null}
                                <Text style={styles.itemDate}>
                                    열람: {new Date(item.viewed_at).toLocaleDateString('ko-KR')} {new Date(item.viewed_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                                </Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.deleteButton} onPress={() => handleDelete(item.id)}>
                                <Text style={styles.deleteButtonText}>🗑️</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                    contentContainerStyle={{ paddingBottom: 100 }}
                    ListEmptyComponent={
                        <View style={styles.emptyContainer}>
                            <Text style={styles.emptyText}>
                                {searchText
                                    ? '검색 결과가 없습니다.'
                                    : '아직 열람한 이력이 없습니다.\n지도에서 부동산을 선택하고\n등기 정보를 열람해 보세요.'}
                            </Text>
                        </View>
                    }
                    refreshing={isLoading}
                    onRefresh={loadHistory}
                />
            )}

            {/* 상세 보기 모달 */}
            <Modal visible={detailVisible} transparent animationType="slide" onRequestClose={() => setDetailVisible(false)}>
                <View style={styles.modalOverlay}>
                    <View style={[styles.modalContent, { maxHeight: height * 0.88 }]}>
                        <Text style={styles.modalTitle}>등기 열람 상세</Text>
                        {selectedRecord && (
                            <ScrollView showsVerticalScrollIndicator={false}>
                                {/* 핵심: 실명 + 실거주지 */}
                                <View style={[styles.propSection, { backgroundColor: '#E3F2FD' }]}>
                                    <Text style={[styles.propSectionTitle, { color: '#1565C0' }]}>소유자 정보 (핵심)</Text>
                                    <View style={styles.propRow}>
                                        <Text style={styles.propLabel}>실명 (소유자명)</Text>
                                        <Text style={[styles.propValue, { color: '#1565C0', fontWeight: '700', fontSize: 16 }]}>
                                            {selectedRecord.owner_name || '미확인'}
                                        </Text>
                                    </View>
                                    <View style={styles.propRow}>
                                        <Text style={styles.propLabel}>실거주지</Text>
                                        <Text style={[styles.propValue, { color: '#1565C0', fontWeight: '600' }]}>
                                            {selectedRecord.owner_address || '미확인'}
                                        </Text>
                                    </View>
                                </View>

                                {/* 부동산 주소 */}
                                <View style={styles.propSection}>
                                    <Text style={styles.propSectionTitle}>부동산 주소</Text>
                                    <View style={styles.propRow}>
                                        <Text style={styles.propLabel}>도로명주소</Text>
                                        <Text style={styles.propValue}>{selectedRecord.road_address || '-'}</Text>
                                    </View>
                                    <View style={styles.propRow}>
                                        <Text style={styles.propLabel}>지번주소</Text>
                                        <Text style={styles.propValue}>{selectedRecord.jibun_address || '-'}</Text>
                                    </View>
                                    <View style={styles.propRow}>
                                        <Text style={styles.propLabel}>좌표</Text>
                                        <Text style={styles.propValue}>
                                            {selectedRecord.lat?.toFixed(6)}, {selectedRecord.lng?.toFixed(6)}
                                        </Text>
                                    </View>
                                </View>

                                {/* 열람 정보 */}
                                <View style={styles.propSection}>
                                    <Text style={styles.propSectionTitle}>열람 정보</Text>
                                    <View style={styles.propRow}>
                                        <Text style={styles.propLabel}>열람일시</Text>
                                        <Text style={styles.propValue}>
                                            {new Date(selectedRecord.viewed_at).toLocaleDateString('ko-KR')}{' '}
                                            {new Date(selectedRecord.viewed_at).toLocaleTimeString('ko-KR')}
                                        </Text>
                                    </View>
                                </View>

                                {/* 우편 발송 정보 */}
                                {selectedRecord.owner_name && selectedRecord.owner_address && (
                                    <View style={[styles.propSection, { backgroundColor: '#FFF8E1' }]}>
                                        <Text style={[styles.propSectionTitle, { color: '#E65100' }]}>우편 발송 정보</Text>
                                        <Text style={{ fontSize: 14, color: '#E65100', lineHeight: 24, marginBottom: 10 }}>
                                            수신: {selectedRecord.owner_name}{'\n'}
                                            주소: {selectedRecord.owner_address}
                                        </Text>
                                        <TouchableOpacity
                                            style={styles.exportButton}
                                            onPress={async () => {
                                                const text = `소유자: ${selectedRecord.owner_name}\n주소: ${selectedRecord.owner_address}\n부동산: ${selectedRecord.road_address || selectedRecord.jibun_address || ''}`;
                                                await Share.share({ title: '소유주 발송 정보', message: text });
                                            }}
                                        >
                                            <Text style={styles.exportButtonText}>📤 발송 정보 공유</Text>
                                        </TouchableOpacity>
                                    </View>
                                )}
                            </ScrollView>
                        )}
                        {selectedRecord?.xml_data ? (
                            <TouchableOpacity
                                style={{ marginBottom: 10, backgroundColor: '#1A237E', borderRadius: 6, paddingVertical: 10, alignItems: 'center' }}
                                onPress={() => setHistXmlModalVisible(true)}
                            >
                                <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>📄 XML 정보 보기 (등기부등본)</Text>
                            </TouchableOpacity>
                        ) : null}
                        <View style={{ flexDirection: 'row', gap: 10 }}>
                            {selectedRecord && (
                                <TouchableOpacity
                                    style={[styles.propCancelButton, { flex: 1, borderColor: '#F44336', borderWidth: 1 }]}
                                    onPress={() => { setDetailVisible(false); handleDelete(selectedRecord.id); }}
                                >
                                    <Text style={[styles.propCancelButtonText, { color: '#F44336' }]}>삭제</Text>
                                </TouchableOpacity>
                            )}
                            <TouchableOpacity style={[styles.propSaveButton, { flex: 2 }]} onPress={() => setDetailVisible(false)}>
                                <Text style={styles.propSaveButtonText}>닫기</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>
            <RegistryXmlModal visible={histXmlModalVisible} onClose={() => setHistXmlModalVisible(false)} xmlData={selectedRecord?.xml_data || ''} />
        </View>
    );
};

// ===== 고령자 모드 설정 화면 =====

const ElderlyModeScreen = ({ onBack }: { onBack: () => void }) => {
    const { elderlyMode, setElderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const ts = elderlyMode ? TOUCH_SIZE.elderly : TOUCH_SIZE.normal;

    return (
        <View style={styles.subScreenContainer}>
            <View style={styles.subScreenHeader}>
                <TouchableOpacity
                    onPress={onBack}
                    style={styles.backButton}
                    accessibilityLabel="뒤로 가기"
                    accessibilityRole="button"
                >
                    <Text style={[styles.backButtonText, elderlyMode && { fontSize: fs.lg }]}>{'< 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={[styles.subScreenTitle, elderlyMode && { fontSize: fs['3xl'] }]}>화면 설정</Text>
                <View style={{ width: 50 }} />
            </View>
            <ScrollView style={{ flex: 1, padding: 20 }}>
                {/* 고령자 모드 토글 */}
                <View style={{
                    backgroundColor: elderlyMode ? '#E3F2FD' : '#F8F9FA',
                    borderRadius: 16,
                    padding: 20,
                    marginBottom: 20,
                    borderWidth: elderlyMode ? 2 : 1,
                    borderColor: elderlyMode ? '#1565C0' : '#eee',
                }}>
                    <Text style={{
                        fontSize: fs['2xl'],
                        fontWeight: '700',
                        color: '#333',
                        marginBottom: 8,
                    }}>
                        큰 글씨 모드
                    </Text>
                    <Text style={{
                        fontSize: fs.base,
                        color: '#666',
                        lineHeight: fs.base * 1.6,
                        marginBottom: 16,
                    }}>
                        글자 크기를 키우고, 버튼을 크게 만들어{'\n'}
                        보기 편하게 설정합니다.
                    </Text>
                    <TouchableOpacity
                        style={{
                            backgroundColor: elderlyMode ? '#C62828' : '#1565C0',
                            borderRadius: 12,
                            paddingVertical: ts.minHeight > 40 ? 18 : 14,
                            alignItems: 'center',
                        }}
                        onPress={() => setElderlyMode(!elderlyMode)}
                        accessibilityLabel={elderlyMode ? '큰 글씨 모드 끄기' : '큰 글씨 모드 켜기'}
                        accessibilityRole="button"
                    >
                        <Text style={{
                            color: '#fff',
                            fontSize: fs.xl,
                            fontWeight: '700',
                        }}>
                            {elderlyMode ? '큰 글씨 모드 끄기' : '큰 글씨 모드 켜기'}
                        </Text>
                    </TouchableOpacity>
                </View>

                {/* 미리보기 */}
                <View style={{
                    backgroundColor: '#F8F9FA',
                    borderRadius: 16,
                    padding: 20,
                    marginBottom: 20,
                    borderWidth: 1,
                    borderColor: '#eee',
                }}>
                    <Text style={{
                        fontSize: fs['2xl'],
                        fontWeight: '700',
                        color: '#333',
                        marginBottom: 12,
                    }}>
                        미리보기
                    </Text>

                    {/* 예시 버튼 */}
                    <TouchableOpacity
                        style={{
                            backgroundColor: '#4A90E2',
                            borderRadius: 12,
                            paddingVertical: ts.padding,
                            minHeight: ts.minHeight,
                            alignItems: 'center',
                            justifyContent: 'center',
                            marginBottom: 12,
                        }}
                    >
                        <Text style={{ color: '#fff', fontSize: fs.lg, fontWeight: '700' }}>
                            버튼 예시
                        </Text>
                    </TouchableOpacity>

                    {/* 예시 텍스트들 */}
                    <Text style={{ fontSize: fs.lg, color: '#333', fontWeight: '700', marginBottom: 4 }}>
                        건물 이름 (제목)
                    </Text>
                    <Text style={{ fontSize: fs.base, color: '#555', marginBottom: 4 }}>
                        서울특별시 강남구 역삼동 123-4
                    </Text>
                    <Text style={{ fontSize: fs.sm, color: '#888' }}>
                        거리: 350m | 공장
                    </Text>
                </View>

                {/* 현재 모드 안내 */}
                <View style={{
                    backgroundColor: elderlyMode ? '#FFF8E1' : '#F5F5F5',
                    borderRadius: 12,
                    padding: 16,
                    marginBottom: 30,
                }}>
                    <Text style={{
                        fontSize: fs.md,
                        color: elderlyMode ? '#E65100' : '#888',
                        textAlign: 'center',
                        lineHeight: fs.md * 1.6,
                    }}>
                        {elderlyMode
                            ? '현재 큰 글씨 모드가 켜져 있습니다.\n글자와 버튼이 크게 표시됩니다.'
                            : '현재 기본 모드입니다.\n글자가 작게 느껴지면 큰 글씨 모드를 켜주세요.'}
                    </Text>
                </View>
            </ScrollView>
        </View>
    );
};

// ===== MoreScreen =====

const MoreScreen = ({ onMoveToMap }: { onMoveToMap: () => void }) => {
    const { elderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const ts = elderlyMode ? TOUCH_SIZE.elderly : TOUCH_SIZE.normal;
    const [currentView, setCurrentView] = useState<'menu' | 'search' | 'recent' | 'favorites' | 'registry' | 'settings'>('menu');
    if (currentView === 'search') return <PlaceSearchScreen onBack={() => setCurrentView('menu')} onMoveToMap={onMoveToMap} />;
    if (currentView === 'recent') return <RecentPlacesScreen onBack={() => setCurrentView('menu')} onMoveToMap={onMoveToMap} />;
    if (currentView === 'favorites') return <FavoritePlacesScreen onBack={() => setCurrentView('menu')} onMoveToMap={onMoveToMap} />;
    if (currentView === 'registry') return <RegistryHistoryScreen onBack={() => setCurrentView('menu')} />;
    if (currentView === 'settings') return <ElderlyModeScreen onBack={() => setCurrentView('menu')} />;
    return (
        <View style={styles.menuContainer}>
            <TouchableOpacity
                style={[styles.menuButton, { minHeight: ts.minHeight, padding: ts.padding }]}
                onPress={() => setCurrentView('search')}
                accessibilityLabel="장소 검색 화면으로 이동"
                accessibilityRole="button"
            >
                <Text style={[styles.menuButtonText, { fontSize: fs.xl }]}>장소 검색</Text>
            </TouchableOpacity>
            <TouchableOpacity
                style={[styles.menuButton, { minHeight: ts.minHeight, padding: ts.padding }]}
                onPress={() => setCurrentView('recent')}
                accessibilityLabel="최근 본 장소 화면으로 이동"
                accessibilityRole="button"
            >
                <Text style={[styles.menuButtonText, { fontSize: fs.xl }]}>최근 본 장소</Text>
            </TouchableOpacity>
            <TouchableOpacity
                style={[styles.menuButton, { minHeight: ts.minHeight, padding: ts.padding }]}
                onPress={() => setCurrentView('favorites')}
                accessibilityLabel="즐겨 찾는 장소 화면으로 이동"
                accessibilityRole="button"
            >
                <Text style={[styles.menuButtonText, { fontSize: fs.xl }]}>즐겨 찾는 장소</Text>
            </TouchableOpacity>
            <TouchableOpacity
                style={[styles.menuButton, {
                    backgroundColor: '#E3F2FD',
                    borderLeftWidth: 4,
                    borderLeftColor: '#1565C0',
                    minHeight: ts.minHeight,
                    padding: ts.padding,
                }]}
                onPress={() => setCurrentView('registry')}
                accessibilityLabel="등기 열람 이력 화면으로 이동"
                accessibilityRole="button"
            >
                <Text style={[styles.menuButtonText, { color: '#1565C0', fontSize: fs.xl }]}>등기 열람 이력</Text>
                <Text style={{ fontSize: fs.sm, color: '#1976D2', marginTop: 2 }}>소유자 실명 · 실거주지 확인 · CSV 내보내기</Text>
            </TouchableOpacity>
            <TouchableOpacity
                style={[styles.menuButton, {
                    backgroundColor: elderlyMode ? '#FFF8E1' : '#F1F8E9',
                    borderLeftWidth: 4,
                    borderLeftColor: elderlyMode ? '#E65100' : '#4CAF50',
                    minHeight: ts.minHeight,
                    padding: ts.padding,
                }]}
                onPress={() => setCurrentView('settings')}
                accessibilityLabel="화면 설정. 큰 글씨 모드를 켜거나 끌 수 있습니다"
                accessibilityRole="button"
            >
                <Text style={[styles.menuButtonText, {
                    color: elderlyMode ? '#E65100' : '#2E7D32',
                    fontSize: fs.xl,
                }]}>
                    화면 설정 {elderlyMode ? '(큰 글씨 켜짐)' : ''}
                </Text>
                <Text style={{ fontSize: fs.sm, color: elderlyMode ? '#BF360C' : '#558B2F', marginTop: 2 }}>
                    글자 크기 · 버튼 크기 조정
                </Text>
            </TouchableOpacity>
        </View>
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
                renderItem={({ item }) => (
                    <View style={[styles.listItemContainer, elderlyMode && { minHeight: 80 }]}>
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
                                    setRegion({ latitude: item.latitude, longitude: item.longitude, latitudeDelta: 0.002, longitudeDelta: 0.002 });
                                    onMoveToMap();
                                }}
                                accessibilityLabel={`${item.name} 지도에서 보기`}
                                accessibilityRole="button"
                            >
                                <Text style={{ color: '#4A90E2', fontSize: fs.md, fontWeight: '600' }}>보기</Text>
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
                ListFooterComponent={isLoadingMore ? <ActivityIndicator style={{ padding: 16 }} color="#4A90E2" /> : null}
                ListEmptyComponent={
                    <View style={styles.emptyContainer}>
                        <Text style={[styles.emptyText, { fontSize: fs.base, lineHeight: fs.base * 1.6 }]}>주변 1km 이내에 공장·창고·물류 건물이 없습니다.{'\n'}산업단지 주변으로 이동 후 새로고침 해주세요.</Text>
                    </View>
                }
            />
        </View>
    );
};

// ===== 메인 앱 =====

function AppContent() {
    const [currentTab, setCurrentTab] = useState('home');
    const mapRef = useRef<KakaoMapHandle>(null);
    const { region, setRegion, selectedMarker, setSelectedMarker, mapType, setMapType, propertyMarkers, setPropertyMarkers, saveRecentPlace, buildingFilter, clusteringEnabled, setClusteringEnabled, elderlyMode, setElderlyMode } = useMapStore();
    const fs = elderlyMode ? FONT_SCALE.elderly : FONT_SCALE.normal;
    const ts = elderlyMode ? TOUCH_SIZE.elderly : TOUCH_SIZE.normal;

    // 앱 시작 시 고령자 모드 복원
    useEffect(() => {
        AsyncStorage.getItem(ELDERLY_MODE_KEY).then(val => {
            if (val !== null) setElderlyMode(JSON.parse(val));
        }).catch(console.warn);
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
    const [registryRecord, setRegistryRecord] = useState<{ id: string; jibun_address?: string; xml_data?: string } | null>(null);
    const [isFavorite, setIsFavorite] = useState(false);

    // 로드뷰 상태
    const [streetViewVisible, setStreetViewVisible] = useState(false);

    // 사용자 위치
    const [userLocation, setUserLocation] = useState<{ latitude: number; longitude: number } | null>(null);

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

    // 클러스터링: 줌 레벨 임계치
    useEffect(() => {
        setClusteringEnabled(region.latitudeDelta > 0.008);
    }, [region.latitudeDelta]);

    // 필터링된 Supabase 매물 (면적/고잠재력)
    const filteredPropertyMarkers = useMemo(() => {
        return propertyMarkers.filter(p => {
            if (buildingFilter.minArea > 0 && (p.area === null || p.area < buildingFilter.minArea)) return false;
            if (buildingFilter.onlyHighPotential) {
                if (!p.area || p.area < SOLAR_MIN_AREA_MEDIUM) return false;
                const purposeOk = ['공장', '창고', '물류'].some(k => (p.purpose || '').includes(k));
                if (!purposeOk) return false;
            }
            return true;
        });
    }, [propertyMarkers, buildingFilter]);

    // 클러스터 계산
    const propertyClusters = useMemo(() => {
        if (!clusteringEnabled) return null;
        return clusterProperties(filteredPropertyMarkers, region.latitudeDelta);
    }, [filteredPropertyMarkers, clusteringEnabled, region.latitudeDelta]);

    // Supabase 매물 쿼리 (위치 기반)
    const { data: properties, refetch: refetchProperties } = useQuery({
        queryKey: ['properties', region.latitude.toFixed(3), region.longitude.toFixed(3)],
        queryFn: () => fetchPropertiesFromDB(region.latitude, region.longitude),
        enabled: true,
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
                    setRegion({ ...coords, latitudeDelta: 0.002, longitudeDelta: 0.002 });
                    setTimeout(() => mapRef.current?.animateToRegion({ ...coords, latitudeDelta: 0.002, longitudeDelta: 0.002 }), 300);
                }

                // 2단계: 정확한 현재 위치로 업데이트
                const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
                const coords = { latitude: location.coords.latitude, longitude: location.coords.longitude };
                setUserLocation(coords);
                setRegion({ ...coords, latitudeDelta: 0.002, longitudeDelta: 0.002 });
                setTimeout(() => mapRef.current?.animateToRegion({ ...coords, latitudeDelta: 0.002, longitudeDelta: 0.002 }), 300);
            } catch (error) {
                console.log("Location error:", error);
            }
        })();
    }, []);

    useEffect(() => {
        if (currentTab === 'home' && mapRef.current) {
            setTimeout(() => mapRef.current?.animateToRegion(region, 500), 100);
        }
    }, [currentTab, region]);

    const checkAndSetRegistryRecord = async (lat: number, lng: number) => {
        try {
            const delta = 0.001;
            const { data } = await supabase
                .from('registry_views')
                .select('id, jibun_address, xml_data')
                .gte('lat', lat - delta)
                .lte('lat', lat + delta)
                .gte('lng', lng - delta)
                .lte('lng', lng + delta)
                .order('viewed_at', { ascending: false })
                .limit(1);
            setRegistryRecord(data && data.length > 0 ? data[0] : null);
        } catch (_) {
            setRegistryRecord(null);
        }
    };

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
    }, [selectedMarker]);

    const handleGpsPress = async () => {
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
                mapRef.current?.animateToRegion(newRegion, 1000);
                setIsMapLoading(false);
            }, 1000);
        } catch (error) {
            setIsMapLoading(false);
            Alert.alert("오류", "위치 정보를 가져올 수 없습니다.");
        }
    };

    const handleRefreshRegistry = () => {
        Alert.alert(
            "등기부등본 갱신",
            "등기부등본 정보를 갱신하시겠습니까?\n(등기발급 비용발생함)",
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
                            await checkAndSetRegistryRecord(selectedMarker.latitude, selectedMarker.longitude);
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

    const changeMapType = (type: MapType) => {
        if (mapType === type) return;
        setLoadingMessage(type === 'cadastral' ? "지적도를 호출중입니다..." : "일반지도를 호출중입니다...");
        setIsMapLoading(true);
        setTimeout(() => { setMapType(type); setIsMapLoading(false); }, 1500);
    };

    const handleMapPress = async (coordinate: { latitude: number; longitude: number }) => {
        try {
            const addressResponse = await Location.reverseGeocodeAsync({
                latitude: coordinate.latitude,
                longitude: coordinate.longitude
            });
            let address = "주소 정보 없음";
            if (addressResponse.length > 0) {
                const addr = addressResponse[0];
                const city = addr.city || addr.region || "";
                const dist = addr.district || "";
                const street = addr.street || "";
                const name = addr.name !== street ? addr.name : "";
                address = `${city} ${dist} ${street} ${name}`.trim();
            }
            const building: Building = {
                id: `marker-${Date.now()}`,
                name: "선택된 위치",
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
    };

    const handlePropertyMarkerPress = (prop: Property) => {
        setSelectedProperty(prop);
        setPropertyModalVisible(true);
    };

    const handleMarkerPress = useCallback((markerId: string, markerType: string) => {
        if (markerType === 'property') {
            const propId = markerId.replace('prop-', '');
            const prop = propertyMarkers.find(p => String(p.property_id) === propId);
            if (prop) handlePropertyMarkerPress(prop);
        } else if (markerType === 'cluster') {
            const clusterId = markerId.replace('cluster-', '');
            const cluster = propertyClusters?.find(c => c.id === clusterId);
            if (cluster) {
                mapRef.current?.animateToRegion({
                    latitude: cluster.coordinate.latitude,
                    longitude: cluster.coordinate.longitude,
                    latitudeDelta: region.latitudeDelta / 3,
                    longitudeDelta: region.longitudeDelta / 3,
                }, 400);
            }
        }
    }, [propertyMarkers, propertyClusters, region]);

    const allMarkersForMap = useMemo(() => {
        const items: import('./KakaoMapView').MapMarkerItem[] = [];
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
                    <View style={styles.mapContainer}>
                        <KakaoMapView
                            ref={mapRef}
                            style={styles.map}
                            kakaoApiKey={KAKAO_API_KEY}
                            vworldApiKey={VWORLD_API_KEY}
                            initialRegion={region}
                            onRegionChangeComplete={(r) => setRegion(r)}
                            onPress={handleMapPress}
                            onMarkerPress={handleMarkerPress}
                            mapType={mapType}
                            selectedMarker={selectedMarker}
                            markers={allMarkersForMap}
                            userLocation={userLocation}
                            onLoadProgress={handleMapLoadProgress}
                        />

                        {/* 지도 타입 탭 */}
                        <View style={styles.mapTypeContainer}>
                            <TouchableOpacity
                                style={[
                                    styles.tabButton,
                                    elderlyMode && { paddingVertical: 12, paddingHorizontal: 18 },
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
                                    elderlyMode && { paddingVertical: 12, paddingHorizontal: 18 },
                                    mapType === 'cadastral' && styles.activeTabButton,
                                ]}
                                onPress={() => changeMapType('cadastral')}
                                accessibilityLabel="지적도로 전환"
                                accessibilityRole="button"
                                accessibilityState={{ selected: mapType === 'cadastral' }}
                            >
                                <Text style={[styles.tabButtonText, { fontSize: fs.md }, mapType === 'cadastral' && styles.activeTabButtonText]}>지적도</Text>
                            </TouchableOpacity>
                        </View>


                        {/* 현재 위치 버튼 */}
                        <TouchableOpacity
                            style={[styles.gpsButton, elderlyMode && { width: 60, height: 60, borderRadius: 30, bottom: elderlyMode ? 140 : 130 }]}
                            onPress={handleGpsPress}
                            accessibilityLabel="현재 위치로 이동"
                            accessibilityRole="button"
                        >
                            <Text style={[styles.gpsButtonText, elderlyMode && { fontSize: 30 }]}>🎯</Text>
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
                                        <Text style={[styles.bottomPanelCoord, { fontSize: fs.sm }]}>
                                            {selectedMarker.latitude.toFixed(6)}, {selectedMarker.longitude.toFixed(6)}
                                        </Text>
                                    </View>
                                    <View style={styles.bottomPanelIcons}>
                                        <TouchableOpacity
                                            style={[styles.bottomPanelIconBtn, elderlyMode && { width: 44, height: 44, borderRadius: 22 }]}
                                            onPress={handleToggleFavorite}
                                            accessibilityLabel={isFavorite ? '즐겨찾기 해제' : '즐겨찾기 추가'}
                                            accessibilityRole="button"
                                        >
                                            <Text style={[styles.bottomPanelIconText, { color: isFavorite ? '#FFD700' : '#aaa' }, elderlyMode && { fontSize: 24 }]}>★</Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity
                                            style={[styles.bottomPanelIconBtn, elderlyMode && { width: 44, height: 44, borderRadius: 22 }]}
                                            onPress={() => setSelectedMarker(null)}
                                            accessibilityLabel="선택 해제"
                                            accessibilityRole="button"
                                        >
                                            <Text style={[styles.bottomPanelIconText, { color: '#999', fontSize: elderlyMode ? 22 : 16 }]}>✕</Text>
                                        </TouchableOpacity>
                                    </View>
                                </View>
                                <View style={styles.bottomPanelButtons}>
                                    {/* 로드뷰 버튼 */}
                                    <TouchableOpacity
                                        style={styles.bottomPanelButtonRoadview}
                                        onPress={() => setStreetViewVisible(true)}
                                    >
                                        <Text style={styles.bottomPanelButtonText}>🗺️ 로드뷰</Text>
                                    </TouchableOpacity>

                                    <TouchableOpacity
                                        style={[
                                            styles.bottomPanelButtonRegistry,
                                            elderlyMode && { paddingVertical: 14, borderRadius: 10 },
                                            registryRecord ? { backgroundColor: '#1565C0' } : null,
                                        ]}
                                        onPress={() => {
                                            if (registryRecord) {
                                                handleRefreshRegistry();
                                            } else {
                                                setRegistryModalVisible(true);
                                            }
                                        }}
                                        accessibilityLabel={registryRecord ? '등기부등본 갱신, 조회 요금이 발생합니다' : '등기부등본 조회'}
                                        accessibilityRole="button"
                                    >
                                        <Text style={[styles.bottomPanelButtonText, { fontSize: fs.md }]}>
                                            {registryRecord ? '등기부등본갱신(조회요금 발생)' : '등기부등본 조회'}
                                        </Text>
                                    </TouchableOpacity>
                                </View>
                            </View>
                        )}
                    </View>
                );
            case 'list':
                return <BuildingListScreen onMoveToMap={() => setCurrentTab('home')} />;
            case 'more':
                return <MoreScreen onMoveToMap={() => setCurrentTab('home')} />;
            default:
                return null;
        }
    };

    return (
    <>
        <StatusBar barStyle="light-content" backgroundColor="#000" translucent={false} />
        <SafeAreaView style={styles.container}>
            {/* 네트워크 상태 말풍선 (모든 탭에서 표시) */}
            <NetworkBubble isOnline={isOnline} />

            <View style={[styles.header, elderlyMode && { height: 70 }]}>
                <View style={styles.headerIconWrap}>
                    <Text style={styles.headerIcon}>☀️</Text>
                </View>
                <Text
                    style={[styles.title, elderlyMode && { fontSize: fs['3xl'] }]}
                    accessibilityRole="header"
                >
                    태양광 영업지원 지도
                </Text>
            </View>

            {renderContent()}

            <View style={[styles.floatingMenu, elderlyMode && { height: 72, bottom: 40 }]}>
                <TouchableOpacity
                    style={styles.menuItem}
                    onPress={() => setCurrentTab('home')}
                    accessibilityLabel="홈 화면, 지도 보기"
                    accessibilityRole="tab"
                    accessibilityState={{ selected: currentTab === 'home' }}
                >
                    <Text style={[
                        styles.menuText,
                        { fontSize: fs.xl },
                        currentTab === 'home' && styles.activeMenuText,
                        elderlyMode && currentTab === 'home' && { color: COLORS_HIGH_CONTRAST.primary, fontWeight: '800' },
                    ]}>홈</Text>
                </TouchableOpacity>
                <TouchableOpacity
                    style={styles.menuItem}
                    onPress={() => setCurrentTab('list')}
                    accessibilityLabel="지도 주변 건물 목록"
                    accessibilityRole="tab"
                    accessibilityState={{ selected: currentTab === 'list' }}
                >
                    <Text style={[
                        styles.menuText,
                        { fontSize: fs.xl },
                        currentTab === 'list' && styles.activeMenuText,
                        elderlyMode && currentTab === 'list' && { color: COLORS_HIGH_CONTRAST.primary, fontWeight: '800' },
                    ]}>지도주변</Text>
                </TouchableOpacity>
                <TouchableOpacity
                    style={styles.menuItem}
                    onPress={() => setCurrentTab('more')}
                    accessibilityLabel="더보기 메뉴"
                    accessibilityRole="tab"
                    accessibilityState={{ selected: currentTab === 'more' }}
                >
                    <Text style={[
                        styles.menuText,
                        { fontSize: fs.xl },
                        currentTab === 'more' && styles.activeMenuText,
                        elderlyMode && currentTab === 'more' && { color: COLORS_HIGH_CONTRAST.primary, fontWeight: '800' },
                    ]}>더보기</Text>
                </TouchableOpacity>
            </View>

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

            {/* 배경 그라디언트 효과 */}
            <View style={splashStyles.bgTop} />
            <View style={splashStyles.bgBottom} />

            {/* 로고 영역 */}
            <View style={splashStyles.logoArea}>
                <View style={splashStyles.sunIcon}>
                    <Text style={splashStyles.sunEmoji}>☀️</Text>
                </View>
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
            <Text style={splashStyles.versionText}>v1.0</Text>
        </Animated.View>
    );
};

const splashStyles = StyleSheet.create({
    container: {
        ...StyleSheet.absoluteFillObject,
        zIndex: 9999,
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 80,
    },
    bgTop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: '#0D2B4E',
        bottom: '50%',
    },
    bgBottom: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: '#1A4A7A',
        top: '50%',
    },
    logoArea: {
        alignItems: 'center',
        marginTop: 40,
    },
    sunIcon: {
        width: 100,
        height: 100,
        borderRadius: 50,
        backgroundColor: 'rgba(255,200,0,0.15)',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 20,
        borderWidth: 2,
        borderColor: 'rgba(255,200,0,0.4)',
    },
    sunEmoji: {
        fontSize: 52,
    },
    appTitle: {
        fontSize: 28,
        fontWeight: '700',
        color: '#FFFFFF',
        letterSpacing: 1,
        marginBottom: 8,
    },
    appSubtitle: {
        fontSize: 15,
        color: 'rgba(255,255,255,0.65)',
        letterSpacing: 2,
    },
    loadingArea: {
        width: '75%',
        alignItems: 'center',
    },
    stageText: {
        fontSize: 13,
        color: 'rgba(255,255,255,0.7)',
        marginBottom: 10,
        letterSpacing: 0.5,
    },
    percentText: {
        fontSize: 36,
        fontWeight: '700',
        color: '#FFD700',
        marginBottom: 14,
    },
    progressTrack: {
        width: '100%',
        height: 6,
        backgroundColor: 'rgba(255,255,255,0.2)',
        borderRadius: 3,
        overflow: 'hidden',
    },
    progressFill: {
        height: '100%',
        backgroundColor: '#FFD700',
        borderRadius: 3,
    },
    versionText: {
        fontSize: 12,
        color: 'rgba(255,255,255,0.35)',
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
        backgroundColor: '#000',
        paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0,
    },
    header: {
        height: 60,
        backgroundColor: '#000',
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 10,
    },
    headerIconWrap: {
        position: 'absolute',
        left: 16,
        justifyContent: 'center',
        alignItems: 'center',
    },
    headerIcon: { fontSize: 22 },
    title: {
        color: '#fff',
        fontSize: 18,
        fontWeight: 'bold',
    },
    mapContainer: { flex: 1, width: '100%', height: '100%' },
    map: { flex: 1, width: '100%', height: '100%' },
    floatingMenu: {
        position: 'absolute',
        bottom: 50,
        left: 20,
        right: 20,
        backgroundColor: '#fff',
        borderRadius: 30,
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'center',
        height: 62,
        paddingHorizontal: 8,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 8,
        elevation: 10,
        zIndex: 10,
    },
    menuItem: { flex: 1, alignItems: 'center', justifyContent: 'center', height: '100%' },
    menuText: { fontSize: 14, color: '#888', fontWeight: '600' },
    activeMenuText: { color: '#000', fontWeight: 'bold' },
    gpsButton: {
        position: 'absolute',
        bottom: 130,
        right: 20,
        width: 50,
        height: 50,
        borderRadius: 25,
        backgroundColor: '#fff',
        justifyContent: 'center',
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 3.84,
        elevation: 5,
        zIndex: 11,
    },
    gpsButtonText: { fontSize: 24 },
    mapTypeContainer: {
        position: 'absolute',
        top: 20,
        left: 20,
        flexDirection: 'row',
        backgroundColor: '#fff',
        borderRadius: 8,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 2,
        elevation: 3,
        overflow: 'hidden',
    },
    tabButton: {
        paddingVertical: 8,
        paddingHorizontal: 14,
        backgroundColor: '#fff',
    },
    activeTabButton: { backgroundColor: '#000' },
    tabButtonText: { fontSize: 13, color: '#555', fontWeight: '600' },
    activeTabButtonText: { color: '#fff' },

    // 하단 패널
    bottomPanel: {
        position: 'absolute',
        bottom: 125,
        left: 16,
        right: 16,
        backgroundColor: '#fff',
        borderRadius: 16,
        padding: 16,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -2 },
        shadowOpacity: 0.15,
        shadowRadius: 4,
        elevation: 8,
        zIndex: 9,
    },
    bottomPanelHandle: {
        width: 40,
        height: 4,
        backgroundColor: '#ddd',
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
        width: 34,
        height: 34,
        borderRadius: 17,
        backgroundColor: '#F5F5F5',
        justifyContent: 'center',
        alignItems: 'center',
    },
    bottomPanelIconText: { fontSize: 18 },
    bottomPanelClose: {
        padding: 6,
    },
    bottomPanelCloseText: { fontSize: 16, color: '#999' },
    bottomPanelAddress: { fontSize: 14, color: '#333', fontWeight: '600', marginBottom: 4 },
    bottomPanelCoord: { fontSize: 12, color: '#888', marginBottom: 4 },
    bottomPanelButtons: { flexDirection: 'row', gap: 8 },
    bottomPanelButton: {
        flex: 1,
        paddingVertical: 10,
        backgroundColor: '#4A90E2',
        borderRadius: 8,
        alignItems: 'center',
    },
    bottomPanelButtonRoadview: {
        paddingVertical: 10,
        paddingHorizontal: 14,
        backgroundColor: '#2C3E50',
        borderRadius: 8,
        alignItems: 'center',
    },
    bottomPanelButtonRegistry: {
        flex: 1,
        paddingVertical: 10,
        backgroundColor: '#E67E22',
        borderRadius: 8,
        alignItems: 'center',
    },
    bottomPanelButtonText: { color: '#fff', fontSize: 12, fontWeight: '600', textAlign: 'center' },

    // 로딩 오버레이
    loadingOverlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 100,
    },
    loadingBox: {
        backgroundColor: '#fff',
        borderRadius: 16,
        padding: 24,
        width: width * 0.75,
        alignItems: 'center',
    },
    loadingText: { fontSize: 15, color: '#333', textAlign: 'center', marginBottom: 16 },
    progressBarContainer: { width: '100%', height: 6, backgroundColor: '#eee', borderRadius: 3, overflow: 'hidden' },
    progressBar: { height: '100%', backgroundColor: '#4A90E2', borderRadius: 3 },
    progressText: { fontSize: 12, color: '#888', marginTop: 8 },

    // 모달 (등기정보 Tilko)
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'flex-end',
    },
    modalContent: {
        backgroundColor: '#fff',
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        padding: 20,
        paddingBottom: 34,
    },
    modalTitle: { fontSize: 18, fontWeight: 'bold', color: '#333', marginBottom: 16, textAlign: 'center' },
    modalLabel: { fontSize: 13, color: '#888', fontWeight: '600', marginBottom: 4 },
    modalInput: {
        borderWidth: 1,
        borderColor: '#ddd',
        borderRadius: 8,
        padding: 10,
        fontSize: 14,
        marginBottom: 10,
    },
    modalSearchButton: {
        backgroundColor: '#4A90E2',
        paddingVertical: 12,
        borderRadius: 8,
        alignItems: 'center',
    },
    modalSearchButtonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
    modalResultBox: {
        backgroundColor: '#F5F5F5',
        borderRadius: 10,
        padding: 14,
        marginBottom: 16,
    },
    modalResultLabel: { fontSize: 12, color: '#888', fontWeight: '600', marginBottom: 2 },
    modalResultValue: { fontSize: 15, color: '#333', fontWeight: '600', marginBottom: 10 },
    modalErrorText: { fontSize: 14, color: '#E74C3C', textAlign: 'center' },
    modalCloseButton: {
        paddingVertical: 14,
        backgroundColor: '#eee',
        borderRadius: 10,
        alignItems: 'center',
        marginTop: 8,
    },
    modalCloseButtonText: { fontSize: 16, color: '#555', fontWeight: '600' },

    // PropertyDetailModal
    propModalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 16,
    },
    propModalTitle: { fontSize: 17, fontWeight: 'bold', color: '#333', flex: 1, marginRight: 10 },
    statusBadge: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 12,
    },
    statusBadgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
    propSection: {
        backgroundColor: '#F8F9FA',
        borderRadius: 12,
        padding: 14,
        marginBottom: 12,
    },
    propSectionTitle: { fontSize: 14, fontWeight: '700', color: '#333', marginBottom: 10 },
    propRow: {
        flexDirection: 'row',
        marginBottom: 8,
        alignItems: 'flex-start',
    },
    propLabel: { fontSize: 12, color: '#888', width: 80, flexShrink: 0, paddingTop: 2 },
    propValue: { fontSize: 13, color: '#333', flex: 1, lineHeight: 20 },
    statusGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        marginBottom: 14,
    },
    statusChip: {
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: 20,
        borderWidth: 1.5,
    },
    statusChipText: { fontSize: 13, fontWeight: '600' },
    memoInput: {
        borderWidth: 1,
        borderColor: '#ddd',
        borderRadius: 8,
        padding: 10,
        fontSize: 14,
        minHeight: 80,
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
        backgroundColor: '#F5F5F5',
    },
    exportButton: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        backgroundColor: '#4A90E2',
        borderRadius: 8,
    },
    exportButtonText: {
        color: '#fff',
        fontSize: 12,
        fontWeight: '700',
    },

    propCancelButton: {
        flex: 1,
        paddingVertical: 14,
        backgroundColor: '#F5F5F5',
        borderRadius: 10,
        alignItems: 'center',
    },
    propCancelButtonText: { fontSize: 15, color: '#555', fontWeight: '600' },
    propSaveButton: {
        flex: 2,
        paddingVertical: 14,
        backgroundColor: '#4A90E2',
        borderRadius: 10,
        alignItems: 'center',
    },
    propSaveButtonText: { fontSize: 15, color: '#fff', fontWeight: '700' },

    // 리스트 화면
    listContainer: { flex: 1, backgroundColor: '#fff' },
    listHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
    },
    listTitle: { fontSize: 15, fontWeight: '700', color: '#333' },
    refreshText: { fontSize: 14, color: '#4A90E2' },
    listItemContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        borderBottomWidth: 1,
        borderBottomColor: '#F0F0F0',
    },
    listItem: { flex: 1, padding: 16 },
    itemHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
    itemName: { fontSize: 15, fontWeight: '700', color: '#333', flex: 1 },
    itemDistance: { fontSize: 12, color: '#888', marginLeft: 8 },
    itemAddress: { fontSize: 13, color: '#666', marginTop: 2 },
    itemDate: { fontSize: 12, color: '#aaa', marginTop: 2 },
    categoryBadge: {
        alignSelf: 'flex-start',
        backgroundColor: '#E3F2FD',
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 4,
        marginBottom: 4,
    },
    categoryBadgeText: { fontSize: 11, color: '#1565C0', fontWeight: '600' },
    listItemActions: {
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        paddingRight: 12,
        gap: 8,
    },
    listItemIconBtn: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: '#F5F5F5',
        justifyContent: 'center',
        alignItems: 'center',
    },
    listItemIconText: { fontSize: 18 },
    moveButton: {
        flex: 1,
        paddingVertical: 8,
        backgroundColor: '#4A90E2',
        borderRadius: 6,
        alignItems: 'center',
    },
    moveButtonText: { color: '#fff', fontSize: 13, fontWeight: '600' },
    favoriteButton: {
        flex: 1,
        paddingVertical: 8,
        backgroundColor: '#F39C12',
        borderRadius: 6,
        alignItems: 'center',
    },
    favoriteButtonText: { color: '#fff', fontSize: 13, fontWeight: '600' },

    // 서브 화면
    subScreenContainer: { flex: 1, backgroundColor: '#fff' },
    subScreenHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
    },
    subScreenTitle: { fontSize: 17, fontWeight: '700', color: '#333' },
    backButton: { padding: 4 },
    backButtonText: { fontSize: 15, color: '#4A90E2' },
    searchContainer: {
        flexDirection: 'row',
        padding: 12,
        gap: 8,
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
    },
    searchInput: {
        flex: 1,
        borderWidth: 1,
        borderColor: '#ddd',
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        fontSize: 14,
    },
    searchButton: {
        backgroundColor: '#4A90E2',
        paddingHorizontal: 16,
        borderRadius: 8,
        justifyContent: 'center',
    },
    searchButtonText: { color: '#fff', fontWeight: '600', fontSize: 14 },
    clearButton: { padding: 8, justifyContent: 'center' },
    clearButtonText: { color: '#999', fontSize: 14 },
    viewLocationButton: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        marginRight: 8,
        backgroundColor: '#4A90E2',
        borderRadius: 6,
    },
    viewLocationButtonText: { color: '#fff', fontSize: 13, fontWeight: '600' },

    // 다음 주소검색
    daumSearchButton: {
        marginHorizontal: 12,
        marginTop: 12,
        marginBottom: 4,
        paddingVertical: 13,
        backgroundColor: '#FAE100',
        borderRadius: 10,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: '#e8cf00',
    },
    daumSearchButtonText: {
        fontSize: 15,
        fontWeight: '700',
        color: '#3C1E1E',
    },
    daumModalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
        backgroundColor: '#fff',
    },
    daumModalTitle: { fontSize: 17, fontWeight: '700', color: '#333' },
    daumModalClose: {
        paddingVertical: 6,
        paddingHorizontal: 12,
        backgroundColor: '#F44336',
        borderRadius: 8,
    },
    daumModalCloseText: { color: '#fff', fontSize: 14, fontWeight: '600' },

    // 위치 버튼 (검색결과 옆)
    locationButton: {
        paddingHorizontal: 10,
        paddingVertical: 10,
        marginRight: 10,
        backgroundColor: '#4A90E2',
        borderRadius: 8,
        minWidth: 62,
        alignItems: 'center',
    },
    locationButtonText: { color: '#fff', fontSize: 12, fontWeight: '700', textAlign: 'center', lineHeight: 17 },

    // 다음 주소검색 확인 카드
    pendingCard: {
        marginHorizontal: 12,
        marginTop: 10,
        backgroundColor: '#EEF6FF',
        borderRadius: 12,
        padding: 14,
        borderWidth: 1.5,
        borderColor: '#4A90E2',
    },
    pendingCardBadge: {
        alignSelf: 'flex-start',
        backgroundColor: '#4A90E2',
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 3,
        marginBottom: 8,
    },
    pendingCardBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
    pendingCardName: { fontSize: 15, fontWeight: '700', color: '#1a1a1a', marginBottom: 4 },
    pendingCardAddress: { fontSize: 13, color: '#555', marginBottom: 4 },
    pendingCardCoord: { fontSize: 11, color: '#999', marginBottom: 12 },
    pendingCardButtons: { flexDirection: 'row', gap: 10 },
    pendingCancelButton: {
        flex: 1,
        paddingVertical: 10,
        backgroundColor: '#eee',
        borderRadius: 8,
        alignItems: 'center',
    },
    pendingCancelButtonText: { fontSize: 14, color: '#666', fontWeight: '600' },
    pendingConfirmButton: {
        flex: 2,
        paddingVertical: 10,
        backgroundColor: '#4A90E2',
        borderRadius: 8,
        alignItems: 'center',
    },
    pendingConfirmButtonText: { fontSize: 14, color: '#fff', fontWeight: '700' },
    deleteButton: { paddingHorizontal: 12, paddingVertical: 8 },
    deleteButtonText: { fontSize: 18 },
    emptyContainer: { padding: 40, alignItems: 'center' },
    emptyText: { fontSize: 14, color: '#aaa', textAlign: 'center', lineHeight: 22 },
    loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },

    // 더보기 메뉴
    menuContainer: { flex: 1, padding: 16, gap: 12 },
    menuButton: {
        padding: 18,
        backgroundColor: '#F8F9FA',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: '#eee',
    },
    menuButtonText: { fontSize: 16, color: '#333', fontWeight: '600' },

    // 등기 조회내역 배지
    registryOwnerBadge: {
        backgroundColor: '#E3F2FD',
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 10,
    },
    registryOwnerBadgeText: { fontSize: 11, color: '#1565C0', fontWeight: '700' },
    registryUnknownBadge: {
        backgroundColor: '#F5F5F5',
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 10,
    },
    registryUnknownBadgeText: { fontSize: 11, color: '#999' },
    registryOwnerAddr: { fontSize: 12, color: '#555', marginBottom: 2 },

    // 스켈레톤
    skeletonBox: {
        backgroundColor: '#E0E0E0',
        borderRadius: 4,
    },
    loaderFooter: { padding: 16, alignItems: 'center' },
});
