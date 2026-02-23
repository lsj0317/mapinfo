import 'react-native-url-polyfill/auto';
import React, { useState, useEffect, useRef } from 'react';
import {
    StyleSheet, Text, View, SafeAreaView, TouchableOpacity,
    Platform, StatusBar, Alert, FlatList, Animated,
    ActivityIndicator, Dimensions, TextInput, Modal, ScrollView,
} from 'react-native';
import MapView, { WMSTile, PROVIDER_DEFAULT, Region, Marker } from 'react-native-maps';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { VWORLD_API_KEY, TILKO_API_KEY, IROS_USER_ID, IROS_USER_PASSWORD, EMONEY_NO1, EMONEY_NO2, EMONEY_PWD } from '@env';
import forge from 'node-forge';
import { supabase, DUMMY_PROPERTIES, type Property, type SalesStatus } from './lib/supabase';

const { width, height } = Dimensions.get('window');
const RECENT_PLACES_KEY = 'recent_places';
const FAVORITE_PLACES_KEY = 'favorite_places';
const REGISTRY_CACHE_KEY = 'registry_cache';

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
        // Supabase 미설정(URL 없음) 또는 오류 시 더미 데이터 반환
        console.warn('Supabase 조회 실패, 더미데이터 사용:', error.message);
        return DUMMY_PROPERTIES.filter(
            p => Math.abs(p.lat - lat) < delta && Math.abs(p.lng - lng) < delta
        );
    }

    // DB에 데이터 없으면 더미데이터 반환
    return (data && data.length > 0) ? data : DUMMY_PROPERTIES;
}

// Supabase 영업상태 업데이트
async function updateSalesStatus(propertyId: string, status: SalesStatus, memo: string | null): Promise<void> {
    const { error } = await supabase
        .from('properties')
        .update({ sales_status: status, sales_memo: memo })
        .eq('property_id', propertyId);

    if (error) {
        console.warn('Supabase 업데이트 실패 (더미모드):', error.message);
        // 더미데이터 모드: 로컬에서 업데이트
        const idx = DUMMY_PROPERTIES.findIndex(p => p.property_id === propertyId);
        if (idx >= 0) {
            DUMMY_PROPERTIES[idx].sales_status = status;
            DUMMY_PROPERTIES[idx].sales_memo = memo;
        }
    }
}

// ===== IROS 등기 열람 Supabase 함수 =====

async function checkIROSCache(lat: number, lng: number): Promise<any | null> {
    try {
        const { data } = await supabase
            .from('registry_views')
            .select('*')
            .gte('lat', lat - 0.0002)
            .lte('lat', lat + 0.0002)
            .gte('lng', lng - 0.0002)
            .lte('lng', lng + 0.0002)
            .order('viewed_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        return data;
    } catch {
        return null;
    }
}

async function saveIROSView(payload: {
    lat: number;
    lng: number;
    road_address: string;
    jibun_address: string;
    owner_name?: string;
    owner_address?: string;
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

    // 더미데이터 모드 (GPS 버튼 누를 때 오산시 테스트 데이터 로드)
    isDummyMode: boolean;
    setDummyMode: (v: boolean) => void;

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

    isDummyMode: false,
    setDummyMode: (v) => set({ isDummyMode: v }),

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

            responses.forEach((json) => {
                if (!json || json.response.status === "NOT_FOUND" || !json.response.result) return;
                const items = json.response.result.items;
                totalItemCount += items.length;

                items.forEach((item: any) => {
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
                    fallbackJson.response.result.items.forEach((item: any) => {
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

async function fetchRegistryInfo(pin: string): Promise<{ owner: string; address: string }> {
    const { encryptAES, encAesKey } = await createTilkoEncryption();
    const body = {
        Auth: {
            UserId: encryptAES(IROS_USER_ID),
            UserPassword: encryptAES(IROS_USER_PASSWORD),
        },
        Pin: encryptAES(pin),
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
        const errorDetail = registryJson.ErrorLog || registryJson.TargetMessage || '';
        throw new Error(registryJson.Message + (errorDetail ? ` (${errorDetail})` : '') || '등기정보 조회 실패');
    }

    const xmlData = registryJson.XmlData || '';
    const ownerMatch = xmlData.match(/<owner_nm>([^<]*)<\/owner_nm>/);
    const addrMatch = xmlData.match(/<rd_addr>([^<]*)<\/rd_addr>/) || xmlData.match(/<jibun_addr>([^<]*)<\/jibun_addr>/);

    return {
        owner: ownerMatch?.[1] || '정보 없음',
        address: addrMatch?.[1] || '정보 없음',
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
        throw new Error(searchJson.ErrorLog || searchJson.Message || '고유번호 검색 실패');
    }
    const dataList = (searchJson.Result && searchJson.Result.DataList) || searchJson.DataList || [];
    if (dataList.length === 0) throw new Error('해당 주소에 대한 등기 정보를 찾을 수 없습니다.');
    return dataList.map((item: any) => ({
        uniqueNo: item.pin_land || item.pin || item.wk_pin || '',
        realtyType: item.real_cls_cd || '',
        addrFull: item.real_indi_cont || '',
        isSpecial: item.pin_mid_spe_yn === 'Y',
    }));
}

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
                        <Text style={styles.propModalTitle} numberOfLines={1}>
                            {property.building_name || property.road_address || '부동산 정보'}
                        </Text>
                        <View style={[styles.statusBadge, { backgroundColor: statusColor }]}>
                            <Text style={styles.statusBadgeText}>{property.sales_status}</Text>
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

                        {/* 영업상태 관리 섹션 */}
                        <View style={styles.propSection}>
                            <Text style={styles.propSectionTitle}>영업상태 관리</Text>

                            <View style={styles.statusGrid}>
                                {SALES_STATUSES.map(s => (
                                    <TouchableOpacity
                                        key={s}
                                        style={[
                                            styles.statusChip,
                                            { borderColor: SALES_STATUS_COLORS[s] },
                                            editStatus === s && { backgroundColor: SALES_STATUS_COLORS[s] },
                                        ]}
                                        onPress={() => setEditStatus(s)}
                                    >
                                        <Text style={[
                                            styles.statusChipText,
                                            { color: editStatus === s ? '#fff' : SALES_STATUS_COLORS[s] },
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
                        <TouchableOpacity style={styles.propCancelButton} onPress={onClose}>
                            <Text style={styles.propCancelButtonText}>닫기</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.propSaveButton, isSaving && { opacity: 0.6 }]}
                            onPress={handleSave}
                            disabled={isSaving}
                        >
                            {isSaving ? (
                                <ActivityIndicator color="#fff" size="small" />
                            ) : (
                                <Text style={styles.propSaveButtonText}>저장</Text>
                            )}
                        </TouchableOpacity>
                    </View>
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
    const [fromCache, setFromCache] = useState(false);
    const [directMode, setDirectMode] = useState(false);
    const [directPin, setDirectPin] = useState('');

    useEffect(() => {
        if (visible && marker && !directMode) handleAutoSearch();
    }, [visible, marker]);

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
            setResult(info);
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
                // Supabase에 소유자 정보 포함 저장
                saveIROSView({
                    lat: marker.latitude,
                    lng: marker.longitude,
                    road_address: marker.address || '',
                    jibun_address: marker.address || '',
                    owner_name: info.owner !== '정보 없음' ? info.owner : undefined,
                    owner_address: info.address !== '정보 없음' ? info.address : undefined,
                }).catch(console.warn);
            }
        } catch (e: any) {
            setError(e.message || '등기정보 조회 중 오류가 발생했습니다.');
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
            setResult(info);
            setStatus('');
            await saveRegistryCache(marker.latitude, marker.longitude, {
                pnu: pnuResult.pnu,
                jibunAddr: pnuResult.jibunAddr,
                uniqueNo: targetUniqueNo,
                owner: info.owner,
                address: info.address,
                cachedAt: Date.now(),
            });
            // Supabase에 소유자 정보 포함 저장
            saveIROSView({
                lat: marker.latitude,
                lng: marker.longitude,
                road_address: marker.address || '',
                jibun_address: pnuResult.jibunAddr || '',
                owner_name: info.owner !== '정보 없음' ? info.owner : undefined,
                owner_address: info.address !== '정보 없음' ? info.address : undefined,
            }).catch(console.warn);
        } catch (e: any) {
            setError(e.message || '등기정보 조회 중 오류가 발생했습니다.');
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
        setDirectMode(false);
        setDirectPin('');
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
                        </View>
                    ) : null}

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
    // 다음 주소검색 후 확인 대기 중인 결과
    const [pendingResult, setPendingResult] = useState<Building | null>(null);
    const { setRegion, setSelectedMarker } = useMapStore();

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
                setSearchResults(json.response.result.items.map((item: any) => ({
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
    const handleDaumMessage = async (event: any) => {
        const data = JSON.parse(event.nativeEvent.data);
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
                <TouchableOpacity onPress={onBack} style={styles.backButton}>
                    <Text style={styles.backButtonText}>{'< 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={styles.subScreenTitle}>장소 검색</Text>
                <View style={{ width: 50 }} />
            </View>

            {/* 다음 주소검색 버튼 */}
            <TouchableOpacity
                style={styles.daumSearchButton}
                onPress={() => setDaumModalVisible(true)}
            >
                <Text style={styles.daumSearchButtonText}>🏠 다음 주소 검색</Text>
            </TouchableOpacity>

            {/* 장소명 검색 */}
            <View style={styles.searchContainer}>
                <TextInput
                    style={styles.searchInput}
                    placeholder="장소명으로 검색 (공장, 창고 등)"
                    value={searchText}
                    onChangeText={setSearchText}
                    onSubmitEditing={handleSearch}
                    returnKeyType="search"
                />
                <TouchableOpacity onPress={handleSearch} style={styles.searchButton}>
                    <Text style={styles.searchButtonText}>검색</Text>
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
                        <View style={styles.listItemContainer}>
                            <View style={styles.listItem}>
                                <Text style={styles.itemName} numberOfLines={1}>{item.name}</Text>
                                <Text style={styles.itemAddress} numberOfLines={2}>{item.address}</Text>
                            </View>
                            <TouchableOpacity
                                style={styles.locationButton}
                                onPress={() => moveToLocation(item)}
                            >
                                <Text style={styles.locationButtonText}>{'지도에서\n보기'}</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                    ListEmptyComponent={
                        !pendingResult ? (
                            <View style={styles.emptyContainer}>
                                <Text style={styles.emptyText}>
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
    const { setRegion, setSelectedMarker, removeRecentPlace } = useMapStore();

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
                <TouchableOpacity onPress={onBack} style={styles.backButton}>
                    <Text style={styles.backButtonText}>{'< 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={styles.subScreenTitle}>최근 본 장소</Text>
                <View style={{ width: 50 }} />
            </View>
            <View style={styles.searchContainer}>
                <TextInput style={styles.searchInput} placeholder="장소 검색..." value={searchText} onChangeText={setSearchText} />
                {searchText.length > 0 && <TouchableOpacity onPress={() => setSearchText('')} style={styles.clearButton}><Text style={styles.clearButtonText}>X</Text></TouchableOpacity>}
            </View>
            <FlatList
                data={filtered}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => (
                    <View style={styles.listItemContainer}>
                        <TouchableOpacity style={styles.listItem} onPress={() => {
                            setSelectedMarker(item);
                            setRegion({ latitude: item.latitude, longitude: item.longitude, latitudeDelta: 0.002, longitudeDelta: 0.002 });
                            onMoveToMap();
                        }}>
                            <Text style={styles.itemName}>{item.name}</Text>
                            <Text style={styles.itemAddress}>{item.address}</Text>
                            <Text style={styles.itemDate}>{item.timestamp ? new Date(item.timestamp).toLocaleDateString() : ''}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.deleteButton} onPress={() => {
                            Alert.alert("삭제 확인", "삭제하시겠습니까?", [
                                { text: "취소", style: "cancel" },
                                { text: "확인", onPress: async () => { await removeRecentPlace(item.id); loadPlaces(); } }
                            ]);
                        }}>
                            <Text style={styles.deleteButtonText}>🗑️</Text>
                        </TouchableOpacity>
                    </View>
                )}
                ListEmptyComponent={<View style={styles.emptyContainer}><Text style={styles.emptyText}>{searchText ? "검색 결과가 없습니다." : "최근 본 장소가 없습니다."}</Text></View>}
            />
        </View>
    );
};

// ===== FavoritePlacesScreen =====

const FavoritePlacesScreen = ({ onBack, onMoveToMap }: { onBack: () => void; onMoveToMap: () => void }) => {
    const [places, setPlaces] = useState<Building[]>([]);
    const [searchText, setSearchText] = useState('');
    const { setRegion, setSelectedMarker, removeFavoritePlace } = useMapStore();

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
                <TouchableOpacity onPress={onBack} style={styles.backButton}>
                    <Text style={styles.backButtonText}>{'< 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={styles.subScreenTitle}>즐겨 찾는 장소</Text>
                <View style={{ width: 50 }} />
            </View>
            <View style={styles.searchContainer}>
                <TextInput style={styles.searchInput} placeholder="장소 검색..." value={searchText} onChangeText={setSearchText} />
                {searchText.length > 0 && <TouchableOpacity onPress={() => setSearchText('')} style={styles.clearButton}><Text style={styles.clearButtonText}>X</Text></TouchableOpacity>}
            </View>
            <FlatList
                data={filtered}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => (
                    <View style={styles.listItemContainer}>
                        <TouchableOpacity style={styles.listItem} onPress={() => {
                            setSelectedMarker(item);
                            setRegion({ latitude: item.latitude, longitude: item.longitude, latitudeDelta: 0.002, longitudeDelta: 0.002 });
                            onMoveToMap();
                        }}>
                            <Text style={styles.itemName}>{item.name}</Text>
                            <Text style={styles.itemAddress}>{item.address}</Text>
                            <Text style={styles.itemDate}>{item.timestamp ? new Date(item.timestamp).toLocaleDateString() : ''}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.deleteButton} onPress={() => {
                            Alert.alert("삭제 확인", "즐겨찾기에서 삭제하시겠습니까?", [
                                { text: "취소", style: "cancel" },
                                { text: "확인", onPress: async () => { await removeFavoritePlace(item.id); loadPlaces(); } }
                            ]);
                        }}>
                            <Text style={styles.deleteButtonText}>🗑️</Text>
                        </TouchableOpacity>
                    </View>
                )}
                ListEmptyComponent={<View style={styles.emptyContainer}><Text style={styles.emptyText}>{searchText ? "검색 결과가 없습니다." : "즐겨 찾는 장소가 없습니다."}</Text></View>}
            />
        </View>
    );
};

// ===== RegistryHistoryScreen (등기 열람 이력) =====

const RegistryHistoryScreen = ({ onBack }: { onBack: () => void }) => {
    const [records, setRecords] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchText, setSearchText] = useState('');
    const [selectedRecord, setSelectedRecord] = useState<any | null>(null);
    const [detailVisible, setDetailVisible] = useState(false);

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

    return (
        <View style={styles.subScreenContainer}>
            {/* 헤더 */}
            <View style={styles.subScreenHeader}>
                <TouchableOpacity onPress={onBack} style={styles.backButton}>
                    <Text style={styles.backButtonText}>{'< 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={styles.subScreenTitle}>등기 열람 이력</Text>
                <TouchableOpacity onPress={loadHistory} style={{ paddingRight: 12 }}>
                    <Text style={{ color: '#4A90E2', fontSize: 13, fontWeight: '600' }}>새로고침</Text>
                </TouchableOpacity>
            </View>

            {/* 검색 */}
            <View style={styles.searchContainer}>
                <TextInput
                    style={styles.searchInput}
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

            {/* 건수 요약 */}
            {!isLoading && (
                <View style={{ paddingHorizontal: 16, paddingVertical: 6, backgroundColor: '#F5F5F5' }}>
                    <Text style={{ fontSize: 12, color: '#888' }}>
                        총 {filtered.length}건 | 소유자 확인: {filtered.filter(r => r.owner_name).length}건
                    </Text>
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
                                        <Text style={{ fontSize: 14, color: '#E65100', lineHeight: 24 }}>
                                            수신: {selectedRecord.owner_name}{'\n'}
                                            주소: {selectedRecord.owner_address}
                                        </Text>
                                    </View>
                                )}
                            </ScrollView>
                        )}
                        <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
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
        </View>
    );
};

// ===== MoreScreen =====

const MoreScreen = ({ onMoveToMap }: { onMoveToMap: () => void }) => {
    const [currentView, setCurrentView] = useState<'menu' | 'search' | 'recent' | 'favorites' | 'registry'>('menu');
    if (currentView === 'search') return <PlaceSearchScreen onBack={() => setCurrentView('menu')} onMoveToMap={onMoveToMap} />;
    if (currentView === 'recent') return <RecentPlacesScreen onBack={() => setCurrentView('menu')} onMoveToMap={onMoveToMap} />;
    if (currentView === 'favorites') return <FavoritePlacesScreen onBack={() => setCurrentView('menu')} onMoveToMap={onMoveToMap} />;
    if (currentView === 'registry') return <RegistryHistoryScreen onBack={() => setCurrentView('menu')} />;
    return (
        <View style={styles.menuContainer}>
            <TouchableOpacity style={styles.menuButton} onPress={() => setCurrentView('search')}><Text style={styles.menuButtonText}>장소 검색</Text></TouchableOpacity>
            <TouchableOpacity style={styles.menuButton} onPress={() => setCurrentView('recent')}><Text style={styles.menuButtonText}>최근 본 장소</Text></TouchableOpacity>
            <TouchableOpacity style={styles.menuButton} onPress={() => setCurrentView('favorites')}><Text style={styles.menuButtonText}>즐겨 찾는 장소</Text></TouchableOpacity>
            <TouchableOpacity
                style={[styles.menuButton, { backgroundColor: '#E3F2FD', borderLeftWidth: 4, borderLeftColor: '#1565C0' }]}
                onPress={() => setCurrentView('registry')}
            >
                <Text style={[styles.menuButtonText, { color: '#1565C0' }]}>등기 열람 이력</Text>
                <Text style={{ fontSize: 12, color: '#1976D2', marginTop: 2 }}>소유자 실명 · 실거주지 확인</Text>
            </TouchableOpacity>
        </View>
    );
};

// ===== BuildingListScreen =====

const BuildingListScreen = ({ onMoveToMap }: { onMoveToMap: () => void }) => {
    const { region, buildings, isLoading, isLoadingMore, fetchBuildings, lastFetchedRegion, page, hasMore, setRegion, setSelectedMarker, saveRecentPlace, saveFavoritePlace } = useMapStore();
    const [expandedId, setExpandedId] = useState<string | null>(null);

    useEffect(() => {
        const shouldFetch = !lastFetchedRegion ||
            Math.abs(lastFetchedRegion.latitude - region.latitude) > 0.001 ||
            Math.abs(lastFetchedRegion.longitude - region.longitude) > 0.001;
        if (shouldFetch) fetchBuildings(region, 1);
    }, []);

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
                <Text style={styles.listTitle}>주변 공장·창고·물류 (1km 이내)</Text>
                <TouchableOpacity onPress={() => fetchBuildings(region, 1)}>
                    <Text style={styles.refreshText}>새로고침</Text>
                </TouchableOpacity>
            </View>
            <FlatList
                data={buildings}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => (
                    <View style={styles.listItemContainer}>
                        <TouchableOpacity style={styles.listItem} onPress={() => setExpandedId(expandedId === item.id ? null : item.id)} activeOpacity={0.7}>
                            <View style={styles.itemHeader}>
                                <Text style={styles.itemName}>{item.name}</Text>
                                <Text style={styles.itemDistance}>{item.distance}m</Text>
                            </View>
                            {item.category ? <View style={styles.categoryBadge}><Text style={styles.categoryBadgeText}>{item.category}</Text></View> : null}
                            <Text style={styles.itemAddress}>{item.address}</Text>
                        </TouchableOpacity>
                        {expandedId === item.id && (
                            <View style={styles.accordionContent}>
                                <TouchableOpacity style={styles.moveButton} onPress={async () => {
                                    await saveRecentPlace(item);
                                    setSelectedMarker(item);
                                    setRegion({ latitude: item.latitude, longitude: item.longitude, latitudeDelta: 0.002, longitudeDelta: 0.002 });
                                    onMoveToMap();
                                }}><Text style={styles.moveButtonText}>위치</Text></TouchableOpacity>
                                <TouchableOpacity style={styles.favoriteButton} onPress={() => saveFavoritePlace(item)}><Text style={styles.favoriteButtonText}>즐겨찾기</Text></TouchableOpacity>
                            </View>
                        )}
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
                        <Text style={styles.emptyText}>주변 1km 이내에 공장·창고·물류 건물이 없습니다.{'\n'}산업단지 주변으로 이동 후 새로고침 해주세요.</Text>
                    </View>
                }
            />
        </View>
    );
};

// ===== IROS 온라인 등기소 자동화 Modal =====
// 실제 사이트 구조 (WebSquare 프레임워크):
//   메인 → wfm_header(헤더프레임) + wfm_content(콘텐츠프레임)
//   로그인 버튼(헤더): id="btn_login" class="btn-login"
//   로그인 폼(콘텐츠): #sbx_user_id(ID searchbox) + #sct_mbr_pw(PW)
//   로그인 제출: id="btn_login" class="btn-solid large"
//   홈 주소검색: #sbx_rlrg_addr + #btn_srch

type IROSStep = 'loading' | 'clickLogin' | 'fillLogin' | 'goRealty' | 'fillAddr' | 'select' | 'done' | 'manual';

const IROS_STEP_INFO: Record<IROSStep, { label: string; isAuto: boolean }> = {
    loading:    { label: '인터넷 등기소 접속 중...', isAuto: true },
    clickLogin: { label: '로그인 버튼 클릭 중...', isAuto: true },
    fillLogin:  { label: '아이디 · 비밀번호 자동 입력 중...', isAuto: true },
    goRealty:   { label: '부동산 열람/발급 메뉴 이동 중...', isAuto: true },
    fillAddr:   { label: '주소 자동 입력 중...', isAuto: true },
    select:     { label: '목록에서 빨간 [열람] 버튼을 눌러주세요', isAuto: false },
    done:       { label: '열람 완료 · 저장되었습니다 ✓', isAuto: false },
    manual:     { label: '수동으로 진행해 주세요\n(로그인 후 부동산 열람 메뉴 이동)', isAuto: false },
};

const IROSRegistryModal = ({
    visible, onClose, marker, roadAddress, jibunAddress,
}: {
    visible: boolean;
    onClose: () => void;
    marker: Building | null;
    roadAddress: string;
    jibunAddress: string;
}) => {
    const webViewRef = useRef<WebView>(null);
    const [step, setStepState] = useState<IROSStep>('loading');
    const [cachedData, setCachedData] = useState<any | null>(null);
    const [isCheckingCache, setIsCheckingCache] = useState(true);
    const stepRef = useRef<IROSStep>('loading');
    const [debugInfo, setDebugInfo] = useState('');
    const detectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const searchAddress = jibunAddress || roadAddress;

    const setStep = (newStep: IROSStep) => {
        stepRef.current = newStep;
        setStepState(newStep);
    };

    useEffect(() => {
        if (visible && marker) {
            setIsCheckingCache(true);
            setCachedData(null);
            setStep('loading');
            checkIROSCache(marker.latitude, marker.longitude).then(cached => {
                setCachedData(cached);
                setIsCheckingCache(false);
            });
        }
        if (!visible) {
            setStep('loading');
            setCachedData(null);
            setIsCheckingCache(true);
            if (detectTimerRef.current) clearTimeout(detectTimerRef.current);
        }
    }, [visible, marker]);

    const injectJS = (code: string) => {
        webViewRef.current?.injectJavaScript(code + '\ntrue;');
    };

    const scheduleDetect = (delayMs: number) => {
        if (detectTimerRef.current) clearTimeout(detectTimerRef.current);
        detectTimerRef.current = setTimeout(() => {
            detectTimerRef.current = null;
            injectJS(DETECT_JS);
        }, delayMs);
    };

    // ── 공통 헬퍼 ──────────────────────────────────────────────────────
    // WebSquare는 iframe(wfm_header / wfm_content / wfm_footer)을 사용
    // _q / _qa : 모든 하위 프레임 재귀 탐색
    // _inner   : WebSquare 컨테이너(div) 내부의 실제 <input> 추출
    // _wsVal   : WebSquare 데이터 바인딩 우회 값 주입
    const FRAME_HELPER = `
var _q=function(sel,w){
  w=w||window;var el=null;
  try{el=w.document.querySelector(sel);}catch(e){}
  if(el)return el;
  for(var i=0;i<(w.frames||[]).length;i++){try{var r=_q(sel,w.frames[i]);if(r)return r;}catch(e){}}
  return null;
};
var _qa=function(sel,w){
  w=w||window;var arr=[];
  try{w.document.querySelectorAll(sel).forEach(function(e){arr.push(e);});}catch(e){}
  for(var i=0;i<(w.frames||[]).length;i++){try{_qa(sel,w.frames[i]).forEach(function(e){arr.push(e);});}catch(e){}}
  return arr;
};
var _inner=function(container){
  if(!container)return null;
  if(container.tagName==='INPUT')return container;
  return container.querySelector('input')||container;
};
var _wsVal=function(el,val){
  // native setter로 값 주입 (이벤트 최소화)
  try{
    var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    s.call(el,val);
  }catch(e){el.value=val;}
  // input 이벤트만 발생 (change/blur는 WebSquare가 값 초기화 트리거할 수 있어 제외)
  try{el.dispatchEvent(new Event('input',{bubbles:true}));}catch(e){}
};`;

    // ── DETECT_JS : 페이지 상태 감지 ─────────────────────────────────
    // WebSquare 컴포넌트 ID 기준으로 현재 단계 판별
    const DETECT_JS = `(function(){
  ${FRAME_HELPER}
  var url=window.location.href;

  // 로그인 폼 감지 (WebSquare 렌더링 완료 여부와 무관하게 최대한 감지)
  // #sbx_user_id: ID 입력 searchbox 컨테이너
  // #sct_mbr_pw : PW 입력 secret 컨테이너
  // fallback    : password input 존재 여부 (WebSquare 버전 무관)
  var idBox = _q('#sbx_user_id');
  var pwBox = _q('#sct_mbr_pw') || _q('input[type="password"]');
  var hasLoginForm = !!(pwBox && (idBox || _q('input[type="text"]')));

  // 헤더 로그인 버튼 (class: btn-login, NOT btn-solid)
  // btn-solid는 로그인 폼의 제출 버튼 → 구별 필요
  var hasLoginBtn = _qa('#btn_login,button,a').some(function(el){
    var cls=(el.className||'');
    var t=(el.textContent||'').replace(/\\s+/g,'');
    if(cls.includes('btn-solid'))return false;
    return cls.includes('btn-login')||t==='로그인';
  });

  // 홈 주소 검색창 (#sbx_rlrg_addr) → 로그인 완료 후 홈에서 바로 검색 가능
  var addrBox = _q('#sbx_rlrg_addr');
  var hasAddrInput = !!addrBox;

  // 열람 목록 (결과 리스트의 열람 버튼)
  var hasList = _qa('button,a').some(function(el){
    var t=(el.textContent||'').trim();
    return t==='열람'||t==='열람하기';
  });

  // 열람 뷰어 도달
  var hasPdf = !!_q('object[type="application/pdf"],embed[type="application/pdf"]');
  var isViewer = /[Vv]iewer/i.test(url)||/issueRgst/i.test(url)||hasPdf;

  window.ReactNativeWebView.postMessage(JSON.stringify({
    type:'PAGE_DETECT',
    url:url.replace('https://','').slice(0,55),
    hasLoginForm:hasLoginForm,
    hasLoginBtn:hasLoginBtn,
    hasAddrInput:hasAddrInput,
    hasList:hasList,
    isViewer:isViewer
  }));
})();`;

    // ── CLICK_HEADER_LOGIN_JS : 헤더의 로그인 버튼 클릭 ─────────────
    // 헤더 프레임(wfm_header)에 있는 btn_login (class: btn-login)
    // 클릭 시 콘텐츠 프레임이 로그인 페이지(/ui/pm20/mbrinfo/Pm20R0Login.xml)로 전환됨
    const CLICK_HEADER_LOGIN_JS = `(function(){
  ${FRAME_HELPER}
  var btn = _qa('#btn_login,button,a').find(function(el){
    var cls=(el.className||'');
    var t=(el.textContent||'').replace(/\\s+/g,'');
    if(cls.includes('btn-solid'))return false;
    return cls.includes('btn-login')||t==='로그인';
  });
  if(btn){
    btn.click();
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'HEADER_LOGIN_CLICKED'}));
  } else {
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'HEADER_LOGIN_NOT_FOUND'}));
  }
})();`;

    // ── FILL_LOGIN_JS : 로그인 폼 자동 입력 ──────────────────────────
    // 전략: script 태그를 로그인 iframe에 직접 삽입 → 해당 프레임 컨텍스트에서 scwin 접근
    // scwin이 outer window에서 안 보이는 이유: 프레임 컨텍스트가 달라서가 아니라
    // 초기화 타이밍 or window property가 아닌 closure 변수이기 때문.
    // script 태그 삽입 시 해당 프레임의 global scope에서 실행 → scwin 접근 가능.
    const FILL_LOGIN_JS = `(function(){
  ${FRAME_HELPER}
  var UID='${IROS_USER_ID.trim()}';
  var UPW='${IROS_USER_PASSWORD.trim()}';
  var attempt=0;

  function nset(el,val){
    try{
      // 요소가 속한 프레임의 HTMLInputElement.prototype 사용 (cross-frame 호환)
      var fw2=el.ownerDocument&&el.ownerDocument.defaultView||window;
      var s=Object.getOwnPropertyDescriptor(fw2.HTMLInputElement.prototype,'value').set;
      s.call(el,val);
    }catch(e){el.value=val;}
  }

  // 로그인 폼(#sbx_user_id or #sct_mbr_pw or password input)이 있는 가장 깊은 프레임 탐색
  function findLoginWin(){
    function scan(w){
      var found=null;
      try{
        if(w.document.querySelector('#sbx_user_id,#sct_mbr_pw,input[type=password]'))found=w;
      }catch(e){}
      for(var i=0;i<(w.frames||[]).length;i++){
        try{var r=scan(w.frames[i]);if(r)return r;}catch(e){}
      }
      return found;
    }
    return scan(window);
  }

  // 타이핑 시뮬레이션 (outer window에서 DOM 값 직접 설정용)
  function typeInto(el,str){
    el.focus&&el.focus();
    nset(el,'');
    try{el.dispatchEvent(new Event('input',{bubbles:true}));}catch(e){}
    for(var i=0;i<str.length;i++){
      var ch=str[i],kc=ch.charCodeAt(0),nv=str.slice(0,i+1);
      try{el.dispatchEvent(new KeyboardEvent('keydown',{key:ch,keyCode:kc,which:kc,bubbles:true,cancelable:true}));}catch(e){}
      nset(el,nv);
      try{el.dispatchEvent(new InputEvent('input',{inputType:'insertText',data:ch,bubbles:true}));}catch(e){}
      try{el.dispatchEvent(new KeyboardEvent('keyup',{key:ch,keyCode:kc,which:kc,bubbles:true,cancelable:true}));}catch(e){}
    }
    try{el.dispatchEvent(new Event('change',{bubbles:true}));}catch(e){}
  }

  // 핵심: 해당 프레임의 document에 script 태그를 삽입하여 그 프레임의 JS 컨텍스트에서 실행
  // → scwin이 그 프레임의 global이라면 정상 접근 가능
  function execInLoginFrame(fw,uid,upw){
    // XHR 인터셉트 코드: WebSquare가 빈 값으로 서버 요청해도 올바른 값으로 교체
    // URL-encoded 및 JSON 양식 모두 처리
    // JSON.stringify로 안전하게 문자열 임베딩 (백슬래시/따옴표 자동 처리)
    var uidJson=JSON.stringify(uid);
    var upwJson=JSON.stringify(upw);
    var xhrPatch='(function(){'
      +'if(window.__xhrPatched)return;window.__xhrPatched=true;'
      +'var _uid='+uidJson+';'
      +'var _upw='+upwJson+';'
      +'var oOpen=XMLHttpRequest.prototype.open,oSend=XMLHttpRequest.prototype.send;'
      +'XMLHttpRequest.prototype.open=function(m,u){this.__url=u;return oOpen.apply(this,arguments);};'
      +'XMLHttpRequest.prototype.send=function(body){'
      +'  if(body&&typeof body==="string"){'
      // URL-encoded 방식: key=value 쌍 교체
      +'    var pairs=body.split("&");'
      +'    pairs=pairs.map(function(p){'
      +'      var eq=p.indexOf("="),k=eq>=0?p.slice(0,eq).toLowerCase():"",v=eq>=0?p.slice(eq+1):"";'
      +'      if(k==="mbr_id"||k==="user_id"||k==="userid"||k==="id")return k+"="+encodeURIComponent(_uid);'
      +'      if(k==="mbr_pw"||k==="password"||k==="pw"||k==="passwd")return k+"="+encodeURIComponent(_upw);'
      +'      return p;'
      +'    });'
      +'    body=pairs.join("&");'
      // JSON 방식 처리
      +'    try{'
      +'      if(body.charAt(0)==="{"){'
      +'        var j=JSON.parse(body),ch=false;'
      +'        ["mbr_id","user_id","userId","id"].forEach(function(k){if(k in j){j[k]=_uid;ch=true;}});'
      +'        ["mbr_pw","password","pw","passwd"].forEach(function(k){if(k in j){j[k]=_upw;ch=true;}});'
      +'        if(ch)body=JSON.stringify(j);'
      +'      }'
      +'    }catch(e){}'
      +'  }'
      +'  return oSend.call(this,body);'
      +'};'
      // fetch 인터셉터: WebSquare가 fetch로 요청하는 경우 대비
      +'if(!window.__fetchPatched){window.__fetchPatched=true;'
      +'var _oFetch=window.fetch;'
      +'window.fetch=function(url,opts){'
      +'  if(opts&&opts.body){'
      +'    var b=opts.body;'
      +'    if(typeof b==="string"&&b.length>0){'
      +'      var pairs=b.split("&");'
      +'      var didReplace=false;'
      +'      pairs=pairs.map(function(p){'
      +'        var eq=p.indexOf("=");'
      +'        if(eq<0)return p;'
      +'        var k=decodeURIComponent(p.slice(0,eq)).toLowerCase();'
      +'        if(k==="mbr_id"||k==="user_id"||k==="userid"||k==="id"){didReplace=true;return p.slice(0,eq+1)+encodeURIComponent(_uid);}'
      +'        if(k==="mbr_pw"||k==="user_pw"||k==="password"||k==="pw"||k==="passwd"){didReplace=true;return p.slice(0,eq+1)+encodeURIComponent(_upw);}'
      +'        return p;'
      +'      });'
      +'      if(didReplace)opts=Object.assign({},opts,{body:pairs.join("&")});'
      +'      try{'
      +'        if(b.charAt(0)==="{"){var j=JSON.parse(b),ch=false;'
      +'          ["mbr_id","user_id","userId","id"].forEach(function(k){if(k in j){j[k]=_uid;ch=true;}});'
      +'          ["mbr_pw","user_pw","password","pw"].forEach(function(k){if(k in j){j[k]=_upw;ch=true;}});'
      +'          if(ch)opts=Object.assign({},opts,{body:JSON.stringify(j)});'
      +'        }'
      +'      }catch(e){}'
      +'    }'
      +'  }'
      +'  return _oFetch.apply(this,arguments);'
      +'};}'
      +'})();';

    // scwin + DOM 컴포넌트 참조 + 글로벌 스캔을 모두 시도하는 로그인 코드
    var scwinCode='(function(){'
      +'var _uid='+uidJson+';'
      +'var _upw='+upwJson+';'
      +'var _t=0,_idC=null,_pwC=null;'
      // 즉시 진단 메시지 전송: 프레임 내부 가용 글로벌 파악
      +'(function(){'
      +'  var _el=document.querySelector("#sbx_user_id");'
      +'  var _pp=["_comp","_widget","__comp","wgComp","_w2comp","w2c","__widget","_scope","component"];'
      +'  var _ep=_el?_pp.filter(function(p){return !!_el[p];}).join(","):"noEl";'
      +'  var _gk=[];'
      +'  try{_gk=Object.keys(window).filter(function(k){return k.length<20&&(k.indexOf("scwin")>=0||k.indexOf("login")>=0||k.indexOf("Login")>=0||k==="w2"||k==="pageScope"||typeof window[k]==="function"&&k.length<12);}).slice(0,12);}catch(e){}'
      +'  try{(window.top||window).ReactNativeWebView.postMessage(JSON.stringify({'
      +'    type:"FRAME_DIAG",'
      +'    sType:typeof scwin,'
      +'    hasW2:typeof w2!=="undefined",'
      +'    hasBtnFn:typeof btn_login_onclick!=="undefined",'
      +'    elProps:_ep,'
      +'    globals:_gk.join(",")'
      +'  }));}catch(e){}'
      +'})();'

      // WebSquare가 DOM 요소에 붙여두는 컴포넌트 참조 탐색
      +'function _getComp(el){'
      +'  if(!el)return null;'
      +'  var pp=["_comp","_widget","__comp","wgComp","_w2comp","w2c","__widget","_scope","component","__scope","_component"];'
      +'  for(var i=0;i<pp.length;i++){if(el[pp[i]])return el[pp[i]];}'
      +'  return null;'
      +'}'

      // 컴포넌트에 setValue + getValue 오버라이드 적용
      +'function _patch(comp,val){'
      +'  if(!comp)return false;'
      +'  try{if(typeof comp.setValue==="function"){comp.setValue(val);}}catch(e){}'
      +'  try{comp.getValue=function(){return val;};}catch(e){'
      +'    try{'
      +'      var p=Object.getPrototypeOf(comp),orig=p&&p.getValue,ref=comp;'
      +'      p.getValue=function(){return(this===ref)?val:(orig?orig.call(this):"");};'
      +'    }catch(e2){}'
      +'  }'
      +'  ["_value","_mvalue","__value","_inputValue","_sValue"].forEach(function(k){'
      +'    try{if(k in comp)comp[k]=val;}catch(e){}'
      +'  });'
      +'  return true;'
      +'}'

      // 컴포넌트 찾기 및 패치 (매 폴링마다 재시도)
      +'function _patchAll(){'
      +'  var idEl=document.querySelector("#sbx_user_id");'
      +'  var pwEl=document.querySelector("#sct_mbr_pw");'
      +'  if(!_idC)_idC=_getComp(idEl);'
      +'  if(!_pwC)_pwC=_getComp(pwEl);'
      +'  try{if(!_idC&&typeof w2!=="undefined"&&w2&&w2.getComponent){_idC=w2.getComponent("sbx_user_id");_pwC=w2.getComponent("sct_mbr_pw");}}catch(e){}'
      +'  try{if(!_idC&&typeof scwin!=="undefined"&&scwin){_idC=scwin.sbx_user_id;_pwC=scwin.sct_mbr_pw;}}catch(e){}'
      +'  _patch(_idC,_uid);_patch(_pwC,_upw);'
      +'}'

      // scwin 또는 btn_login_onclick을 가진 객체 탐색
      +'function _findSw(){'
      +'  try{if(typeof scwin!=="undefined"&&scwin&&typeof scwin.btn_login_onclick==="function")return scwin;}catch(e){}'
      +'  try{if(typeof btn_login_onclick==="function")return {btn_login_onclick:btn_login_onclick,sbx_user_id:_idC,sct_mbr_pw:_pwC};}catch(e){}'
      +'  try{'
      +'    var keys=Object.keys(window);'
      +'    for(var ki=0;ki<keys.length;ki++){'
      +'      var v=window[keys[ki]];'
      +'      if(v&&typeof v==="object"&&typeof v.btn_login_onclick==="function")return v;'
      +'    }'
      +'  }catch(e){}'
      +'  return null;'
      +'}'

      +'function _go(){'
      +'  _patchAll();'
      +'  var sw=_findSw();'
      // ① 실제 dma_login DataModel 탐색: sw 또는 window 프로퍼티에서 .set/.get 가진 객체
      +'  var _realDm=null;'
      +'  try{'
      +'    var _dmKeys=["dma_login","dm_login","dma_mbr","dma_Mbr","dma_member","dma_Login"];'
      +'    for(var _di=0;_di<_dmKeys.length;_di++){'
      +'      var _dn=_dmKeys[_di];'
      +'      var _cand=(sw&&sw[_dn])||window[_dn]||null;'
      +'      if(_cand&&typeof _cand.set==="function"&&typeof _cand.get==="function"){_realDm=_cand;break;}'
      +'    }'
      +'    if(_realDm){'
      +'      ["user_id","mbr_id","id","userId","loginId"].forEach(function(k){try{_realDm.set(k,_uid);}catch(e){}});'
      +'      ["user_pw","mbr_pw","password","pw","passwd","userPw","loginPw"].forEach(function(k){try{_realDm.set(k,_upw);}catch(e){}});'
      +'    }'
      +'  }catch(e){}'
      // ② scwin 컴포넌트 getValue 직접 오버라이드 (comp:0/0 우회)
      +'  try{'
      +'    var _cpPairs=[["sbx_user_id","sct_mbr_pw"],["sbx_id","sbx_pw"],["sbx_login_id","sbx_login_pw"]];'
      +'    for(var _pi=0;_pi<_cpPairs.length;_pi++){'
      +'      var _cid=sw&&sw[_cpPairs[_pi][0]],_cpw=sw&&sw[_cpPairs[_pi][1]];'
      +'      if(_cid||_cpw){'
      +'        if(_cid){try{_cid.getValue=function(){return _uid;};}catch(e){} try{if(typeof _cid.setValue==="function")_cid.setValue(_uid);}catch(e){} try{_cid._value=_uid;}catch(e){}}'
      +'        if(_cpw){try{_cpw.getValue=function(){return _upw;};}catch(e){} try{if(typeof _cpw.setValue==="function")_cpw.setValue(_upw);}catch(e){} try{_cpw._value=_upw;}catch(e){}}'
      +'        break;'
      +'      }'
      +'    }'
      +'  }catch(e){}'
      +'  var _dmType=typeof dma_login;'
      +'  var info="t:"+_t+" comp:"+(_idC?"1":"0")+"/"+(_pwC?"1":"0")+" sw:"+(sw?"1":"0")+" dm:"+(_realDm?"1":"0")+"("+_dmType+")";'
      +'  if(sw&&typeof sw.btn_login_onclick==="function"){'
      // btn_login_onclick 소스 확인
      +'    var _fnSrc="";'
      +'    try{_fnSrc=sw.btn_login_onclick.toString().slice(0,200);}catch(e){}'
      +'    setTimeout(function(){'
      +'      var _fnSrc2="";'
      +'      try{_fnSrc2=sw.btn_login_onclick.toString();}catch(e){}'
      // 가짜 dma_login DataModel (올바른 ID/PW 반환 + WebSquare 내부 메서드 포함)
      +'      var _fakeDm={'
      +'        _d:{},'
      +'        set:function(k,v){this._d[k]=v;return this;},'
      +'        get:function(k){'
      +'          var kl=(k||"").toLowerCase();'
      +'          if(kl==="user_id"||kl==="id"||kl==="mbr_id"||kl==="loginid"||kl==="login_id")return _uid;'
      +'          if(kl.indexOf("pw")>=0||kl.indexOf("pass")>=0||kl.indexOf("secret")>=0)return _upw;'
      +'          return this._d[k]!==undefined?this._d[k]:"";'
      +'        },'
      +'        getCount:function(){return 1;},'
      +'        getRowCount:function(){return 1;},'
      +'        setRowNum:function(){return this;},'
      +'        getRowNum:function(){return 0;},'
      +'        validate:function(){return true;},'
      +'        isValid:function(){return true;},'
      +'        isNullData:function(){return false;},'
      +'        isNullValue:function(k){'
      +'          var kl=(k||"").toLowerCase();'
      +'          if(kl==="user_id"||kl==="id"||kl==="mbr_id"||kl==="loginid")return false;'
      +'          if(kl.indexOf("pw")>=0||kl.indexOf("pass")>=0)return false;'
      +'          return true;'
      +'        },'
      +'        getJSON:function(){return {"user_id":_uid,"mbr_id":_uid,"id":_uid,"user_pw":_upw,"mbr_pw":_upw,"password":_upw};},'
      +'        serialize:function(){return "user_id="+encodeURIComponent(_uid)+"&user_pw="+encodeURIComponent(_upw)+"&mbr_id="+encodeURIComponent(_uid)+"&mbr_pw="+encodeURIComponent(_upw);}'
      +'      };'
      // ③ 실행 전략: direct → fn_inject → orig_fallback 순서로 시도
      +'      var _method2="none";'
      // 전략A: btn_login_onclick 직접 호출 (컴포넌트 & DM 이미 패치됨)
      +'      try{'
      +'        sw.btn_login_onclick.call(window,null);'
      +'        _method2="direct";'
      +'      }catch(eA){'
      // 전략B: new Function으로 dma_login 파라미터화 (클로저 섀도잉)
      +'        try{'
      +'          var _bs=_fnSrc2.indexOf("{")+1,_be=_fnSrc2.lastIndexOf("}");'
      +'          if(_bs>0&&_be>_bs){'
      +'            var _body=_fnSrc2.slice(_bs,_be);'
      +'            var _nf=new Function("dma_login","e",_body);'
      +'            _nf.call(window,_fakeDm,null);'
      +'            _method2="fn_inject";'
      +'          }'
      +'        }catch(eB){'
      // 전략C: 원본 함수 호출 (XHR 인터셉터가 자격증명 교체)
      +'          try{sw.btn_login_onclick();}catch(eC){}'
      +'          _method2="orig_fallback";'
      +'        }'
      +'      }'
      // DOM 값도 재설정 (안전망)
      +'      var _iDom=document.querySelector("#sbx_user_id input,input[type=text]");'
      +'      var _pDom=document.querySelector("#sct_mbr_pw input,input[type=password]");'
      +'      if(_iDom){try{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(_iDom,_uid);}catch(e){_iDom.value=_uid;}}'
      +'      if(_pDom){try{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(_pDom,_upw);}catch(e){_pDom.value=_upw;}}'
      +'      try{(window.top||window).ReactNativeWebView.postMessage(JSON.stringify({type:"LOGIN_SUBMITTED",method:_method2,info:info,fnSrc:_fnSrc}));}catch(e){}'
      +'    },800);'
      +'  } else if(++_t<20){'
      +'    setTimeout(_go,500);'
      +'  } else {'
      // 10초 후에도 scwin 없으면: 컴포넌트 최종 패치 후 DOM 버튼 클릭
      +'    _patchAll();'
      +'    var btns=Array.prototype.slice.call(document.querySelectorAll("button,input[type=submit],a"));'
      +'    var btn=null;'
      +'    for(var bi=0;bi<btns.length;bi++){'
      +'      var bcls=(btns[bi].className||""),btx=(btns[bi].textContent||btns[bi].value||"").trim();'
      +'      if(bcls.indexOf("btn-solid")>=0||btx==="로그인"){btn=btns[bi];break;}'
      +'    }'
      // DOM input 값도 재설정
      +'    var idIn=document.querySelector("#sbx_user_id input,input[type=text]");'
      +'    var pwIn2=document.querySelector("#sct_mbr_pw input,input[type=password]");'
      +'    if(idIn)idIn.value=_uid;'
      +'    if(pwIn2)pwIn2.value=_upw;'
      +'    var info2=info+" btn:"+(btn?"found":"none");'
      +'    if(btn){'
      +'      try{btn.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,view:window}));}catch(e){btn.click();}'
      +'      try{(window.top||window).ReactNativeWebView.postMessage(JSON.stringify({type:"LOGIN_SUBMITTED",method:"dom",info:info2}));}catch(e){}'
      +'    } else {'
      +'      if(pwIn2){"keydown,keypress,keyup".split(",").forEach(function(ev){try{pwIn2.dispatchEvent(new KeyboardEvent(ev,{key:"Enter",keyCode:13,which:13,bubbles:true}));}catch(e){}}); }'
      +'      try{(window.top||window).ReactNativeWebView.postMessage(JSON.stringify({type:"LOGIN_SUBMITTED",method:"enter",info:info2}));}catch(e){}'
      +'    }'
      +'  }'
      +'}'
      +'_go();'
      +'})();';

    var fullCode=xhrPatch+scwinCode;

    // 방법1: script 태그 삽입 (가장 확실하게 프레임 컨텍스트에서 실행됨)
    try{
      var s=fw.document.createElement('script');
      s.textContent=fullCode;
      (fw.document.head||fw.document.body||fw.document.documentElement).appendChild(s);
      try{s.parentNode.removeChild(s);}catch(e){}
      return 'tag';
    }catch(e){}
    // 방법2: new Function (프레임의 Function 생성자 사용 → 프레임 컨텍스트)
    try{
      (new fw.Function(fullCode))();
      return 'fn';
    }catch(e){}
    return 'fail';
  }

  function tryFill(){
    attempt++;
    var fw=findLoginWin();
    if(!fw){
      if(attempt<20){setTimeout(tryFill,800);return;}
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'LOGIN_FORM_MISSING'}));
      return;
    }

    // DOM inputs 직접 찾기 (fw 프레임 내)
    var idIn=null,pwIn=null;
    try{
      idIn=fw.document.querySelector('#sbx_user_id input,#sbx_user_id [type=text]')
          ||fw.document.querySelector('input[type=text]');
      pwIn=fw.document.querySelector('#sct_mbr_pw input,#sct_mbr_pw [type=password]')
          ||fw.document.querySelector('input[type=password]');
    }catch(e){}

    if(!idIn||!pwIn){
      if(attempt<20){setTimeout(tryFill,800);return;}
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'LOGIN_FORM_MISSING'}));
      return;
    }

    // ① 타이핑 시뮬레이션 (DOM 값 설정 + WebSquare input 이벤트 핸들러 트리거)
    typeInto(idIn,UID);
    typeInto(pwIn,UPW);

    // ② 프레임 내부 컨텍스트에서 scwin 접근 + XHR 인터셉트 (비동기, 최대 10초 폴링)
    var injResult=execInLoginFrame(fw,UID,UPW);

    window.ReactNativeWebView.postMessage(JSON.stringify({
      type:'FILL_DEBUG',
      info:'inj:'+injResult+' idLen:'+idIn.value.length+' pwLen:'+pwIn.value.length
    }));
  }

  tryFill();
})();`;

    // ── FILL_ADDR_JS : 주소 검색창 자동 입력 ────────────────────────
    // 홈(#sbx_rlrg_addr) 및 부동산 열람/발급 페이지 모두 지원
    // 보이는(offsetParent≠null) 텍스트 입력을 placeholder/id 기준으로 탐색
    const FILL_ADDR_JS = `(function(){
  ${FRAME_HELPER}
  var addr='${searchAddress.replace(/'/g, "\\'")}';
  var addrBox=_q('#sbx_rlrg_addr')||_q('[id*="rlrg_addr"],[id*="Rlrg"]');
  var inp=_inner(addrBox)||_qa('input[type="text"]').find(function(el){
    if(el.offsetParent===null)return false;
    var ph=(el.placeholder||'').toLowerCase();
    var id=(el.id||'').toLowerCase();
    return ph.includes('주소')||ph.includes('지번')||ph.includes('건물명')||ph.includes('도로명')
           ||id.includes('addr')||id.includes('rlrg');
  })||_qa('input[type="text"]').find(function(el){
    return el.offsetParent!==null; // 최후 fallback: 첫 번째 보이는 텍스트 입력
  });
  if(inp){
    _wsVal(inp,addr);
    setTimeout(function(){
      var btn=_q('#btn_srch')
        ||_q('[id*="srch"][id*="btn"],[id*="btn"][id*="srch"],[class*="btn-srch"],[class*="btn_srch"]')
        ||_qa('button,input[type="submit"],input[type="button"]').find(function(el){
            var t=(el.textContent||el.value||'').trim();
            return t==='검색'||t==='조회'||t.includes('검색')||t.includes('조회');
          });
      if(btn){
        btn.click();
        window.ReactNativeWebView.postMessage(JSON.stringify({type:'ADDR_SEARCHED',addr:addr}));
      } else {
        // 검색 버튼 없으면 Enter 키 이벤트로 대체
        try{
          ['keydown','keypress','keyup'].forEach(function(ev){
            inp.dispatchEvent(new KeyboardEvent(ev,{key:'Enter',keyCode:13,bubbles:true,cancelable:true}));
          });
          window.ReactNativeWebView.postMessage(JSON.stringify({type:'ADDR_SEARCHED',addr:addr,method:'enter'}));
        }catch(e2){
          window.ReactNativeWebView.postMessage(JSON.stringify({type:'NO_SEARCH_BTN'}));
        }
      }
    },600);
  } else {
    var inputs=_qa('input').map(function(el){
      return{t:el.type,id:el.id,ph:(el.placeholder||'').slice(0,20),vis:el.offsetParent!==null};
    });
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'NO_ADDR_INPUT',inputs:inputs.slice(0,10)}));
  }
})();`;

    // ── GO_REALTY_JS : 부동산 열람/발급 메뉴 이동 ───────────────────
    // WebSquare 메뉴 ID '01010000' = 부동산 열람/발급
    // 방법1: Pm20ComMenu.gfn_openMenu('01010000') 직접 호출
    // 방법2: userData3="main01" 속성 버튼 클릭
    // 방법3: 텍스트 "부동산 열람/발급" 메뉴 항목 클릭
    // 방법4: 홈 검색창이 보이면 메뉴 이동 없이 직접 검색 (REALTY_USE_HOME_SEARCH)
    const GO_REALTY_JS = `(function(){
  ${FRAME_HELPER}
  var ok=false;
  var wins=[window];
  for(var fi=0;fi<(window.frames||[]).length;fi++){try{wins.push(window.frames[fi]);}catch(e){}}

  // 방법1: Pm20ComMenu.gfn_openMenu('01010000')
  for(var wi=0;wi<wins.length;wi++){
    try{
      var fw=wins[wi];
      if(typeof fw.Pm20ComMenu!=='undefined'&&typeof fw.Pm20ComMenu.gfn_openMenu==='function'){
        fw.Pm20ComMenu.gfn_openMenu('01010000');
        ok=true;break;
      }
    }catch(e){}
  }

  // 방법2: userData3="main01" 속성
  if(!ok){
    var ud=_qa('[usrdata3="main01"],[userData3="main01"]').find(function(el){return !!el;});
    if(ud){ud.click();ok=true;}
  }

  // 방법3: "부동산 열람/발급" 텍스트
  if(!ok){
    var menuEl=_qa('button,a,li,span,div,td').find(function(el){
      var t=(el.textContent||'').replace(/\\s+/g,'');
      return t==='부동산열람/발급'||t==='부동산열람·발급'||
             (t.includes('열람')&&t.includes('부동산')&&t.length<20);
    });
    if(menuEl){menuEl.click();ok=true;}
  }

  // 방법4: 홈 #sbx_rlrg_addr이 있으면 직접 검색 사용
  if(!ok&&_q('#sbx_rlrg_addr')){
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'REALTY_USE_HOME_SEARCH'}));
    return;
  }

  window.ReactNativeWebView.postMessage(JSON.stringify({
    type:ok?'REALTY_MENU_CLICKED':'REALTY_MENU_NOT_FOUND'
  }));
})();`;

    // ── HIGHLIGHT_JS : 열람 버튼 강조 표시 ───────────────────────────
    const HIGHLIGHT_JS = `(function(){
  ${FRAME_HELPER}
  [window].concat(Array.from({length:(window.frames||[]).length},function(_,i){
    try{return window.frames[i];}catch(e){return null;}
  })).filter(Boolean).forEach(function(w){
    try{
      var s=w.document.createElement('style');
      s.textContent='@keyframes iros-p{0%{opacity:1;transform:scale(1)}50%{opacity:.8;transform:scale(1.06)}100%{opacity:1;transform:scale(1)}}.iros-hl{background:#E53935!important;color:#fff!important;font-weight:bold!important;border:3px solid #B71C1C!important;padding:10px 18px!important;border-radius:8px!important;font-size:15px!important;animation:iros-p 1.2s infinite!important;display:inline-block!important;margin:4px!important;}';
      w.document.head&&w.document.head.appendChild(s);
    }catch(e){}
  });
  var count=0;
  _qa('a,button,input[type="button"]').forEach(function(el){
    var t=(el.textContent||el.value||'').trim();
    if(t==='열람'||t==='열람하기'){el.classList.add('iros-hl');count++;}
  });
  window.ReactNativeWebView.postMessage(JSON.stringify({type:'HIGHLIGHT_DONE',count:count}));
})();`;

    // ── 이벤트 핸들러 ──────────────────────────────────────────────────

    const handleLoadEnd = (e: any) => {
        const url = e.nativeEvent.url || '';
        if (!url.includes('iros.go.kr')) return;
        // WebSquare 초기화 대기: 2초 후 1차, 5초 후 2차(loading 상태면)
        scheduleDetect(2000);
        setTimeout(() => {
            if (stepRef.current === 'loading') injectJS(DETECT_JS);
        }, 5000);
    };

    const handleNavigationStateChange = (navState: any) => {
        const url = navState.url || '';
        if (!url.includes('iros.go.kr')) return;
        scheduleDetect(1500);
    };

    // ── 상태 기계 ──────────────────────────────────────────────────────
    // loading    → (hasLoginBtn) → clickLogin
    //            → (hasLoginForm) → fillLogin
    //            → (hasAddrInput) → fillAddr (이미 로그인된 경우)
    // clickLogin → CLICK_HEADER_LOGIN_JS → HEADER_LOGIN_CLICKED
    //           → poll → (hasLoginForm) → fillLogin
    // fillLogin  → FILL_LOGIN_JS 내부 폴링(최대 15회×800ms)
    //           → LOGIN_SUBMITTED → goRealty
    // goRealty   → PAGE_DETECT (hasAddrInput=홈 확인) → GO_REALTY_JS
    //           → REALTY_MENU_CLICKED   → fillAddr (2초 대기)
    //           → REALTY_USE_HOME_SEARCH → fillAddr (즉시)
    //           → REALTY_MENU_NOT_FOUND → fillAddr (재감지)
    // fillAddr   → FILL_ADDR_JS → ADDR_SEARCHED → select
    // select     → HIGHLIGHT_JS → 사용자가 열람 버튼 클릭 → done
    const handleMessage = (event: any) => {
        try {
            const msg = JSON.parse(event.nativeEvent.data);
            const cur = stepRef.current;

            if (msg.type === 'PAGE_DETECT') {
                setDebugInfo(
                    `${(msg.url||'').slice(0,40)}\n` +
                    `로그인폼:${msg.hasLoginForm?'✓':'✗'} ` +
                    `로그인버튼:${msg.hasLoginBtn?'✓':'✗'} ` +
                    `주소창:${msg.hasAddrInput?'✓':'✗'} ` +
                    `열람목록:${msg.hasList?'✓':'✗'}`
                );
                if (cur === 'done' || cur === 'manual') return;

                // 1. 열람 뷰어 → 완료
                if (msg.isViewer) {
                    setStep('done');
                    if (marker) saveIROSView({ lat: marker.latitude, lng: marker.longitude, road_address: roadAddress, jibun_address: jibunAddress }).catch(console.warn);
                    return;
                }
                // 2. 열람 목록 → 하이라이트
                if (msg.hasList && cur !== 'select') {
                    setStep('select');
                    setTimeout(() => injectJS(HIGHLIGHT_JS), 300);
                    return;
                }
                // 3. 주소 검색창 감지
                if (msg.hasAddrInput) {
                    if (cur === 'goRealty') {
                        // 홈 페이지 로드 확인 → 부동산 열람/발급 메뉴 이동 시도
                        setTimeout(() => injectJS(GO_REALTY_JS), 500);
                        return;
                    }
                    if (cur !== 'fillAddr' && cur !== 'select') {
                        // 이미 로그인된 상태에서 홈 도달 (캐시 없는 재열람 등)
                        setStep('fillAddr');
                        setTimeout(() => injectJS(FILL_ADDR_JS), 500);
                        return;
                    }
                }
                // 3-b. goRealty 중 홈도 안 보임 → 계속 폴링
                if (cur === 'goRealty' && !msg.hasAddrInput && !msg.hasLoginBtn && !msg.hasLoginForm) {
                    scheduleDetect(1500);
                    return;
                }
                // 3-c. goRealty 중 로그인 폼이 다시 보임 → 로그인 실패, 재시도
                if (cur === 'goRealty' && msg.hasLoginForm) {
                    setStep('fillLogin');
                    setTimeout(() => injectJS(FILL_LOGIN_JS), 600);
                    return;
                }
                // 4. 로그인 폼 노출 → 자동 입력 (아직 FILL_LOGIN_JS 실행 전일 때만)
                if (msg.hasLoginForm && cur !== 'fillLogin') {
                    setStep('fillLogin');
                    setTimeout(() => injectJS(FILL_LOGIN_JS), 400);
                    return;
                }
                // 5. 헤더 로그인 버튼 → 클릭해서 로그인 페이지로 이동
                if (msg.hasLoginBtn && cur === 'loading') {
                    setStep('clickLogin');
                    setTimeout(() => injectJS(CLICK_HEADER_LOGIN_JS), 400);
                    return;
                }
                // 6. clickLogin 상태 → 로그인 폼이 아직 없으면 계속 폴링
                //    WebSquare는 AJAX로 콘텐츠를 교체하므로 handleLoadEnd가 재발화 안 됨
                if (cur === 'clickLogin' && !msg.hasLoginForm) {
                    scheduleDetect(1500);
                    return;
                }
                // 7. 아무것도 없음 + loading 상태 → WebSquare 아직 렌더링 중, 대기
            }

            if (msg.type === 'HEADER_LOGIN_CLICKED') {
                // WebSquare는 AJAX로 콘텐츠 교체 → handleLoadEnd 재발화 없음
                // 로그인 XML 렌더링 대기: 2s 후 1차, 4s 후 2차, 7s 후 3차 감지
                scheduleDetect(2000);
                setTimeout(() => { if (stepRef.current === 'clickLogin') injectJS(DETECT_JS); }, 4000);
                setTimeout(() => { if (stepRef.current === 'clickLogin') injectJS(DETECT_JS); }, 7000);
            }
            if (msg.type === 'HEADER_LOGIN_NOT_FOUND') {
                // 로그인 버튼이 없음 = 이미 로그인 상태 → 주소창 탐색
                scheduleDetect(500);
            }
            if (msg.type === 'LOGIN_SUBMITTED') {
                // 로그인 제출됨 → 홈 로드 대기 후 부동산 열람/발급 메뉴 이동
                // fnSrc: btn_login_onclick 소스 첫 200자 (어떻게 값을 읽는지 확인용)
                const fnPreview = (msg.fnSrc || '').slice(0, 160).replace(/\s+/g, ' ');
                setDebugInfo(`제출:${msg.method} ${msg.info||''}\nfn:${fnPreview}`);
                setStep('goRealty');
                // 로그인 후 홈 로딩 대기: 2s / 4s / 7s / 12s 다중 폴링
                scheduleDetect(2000);
                setTimeout(() => { if (stepRef.current === 'goRealty') injectJS(DETECT_JS); }, 4000);
                setTimeout(() => { if (stepRef.current === 'goRealty') injectJS(DETECT_JS); }, 7000);
                setTimeout(() => { if (stepRef.current === 'goRealty') injectJS(DETECT_JS); }, 12000);
            }
            if (msg.type === 'REALTY_MENU_CLICKED') {
                // WebSquare AJAX로 부동산 열람/발급 페이지 로드 중 → 2초 후 주소 입력
                setStep('fillAddr');
                setTimeout(() => injectJS(FILL_ADDR_JS), 2000);
            }
            if (msg.type === 'REALTY_USE_HOME_SEARCH') {
                // 홈 검색창 직접 사용
                setStep('fillAddr');
                setTimeout(() => injectJS(FILL_ADDR_JS), 300);
            }
            if (msg.type === 'REALTY_MENU_NOT_FOUND') {
                // 메뉴 이동 실패 → 현재 페이지에서 주소 검색 시도
                setStep('fillAddr');
                scheduleDetect(500);
            }
            if (msg.type === 'FILL_DEBUG') {
                setDebugInfo(`주입: ${msg.info || ''}`);
            }
            if (msg.type === 'LOGIN_NO_BTN') {
                // 버튼 미발견 → 상태 표시만 (반복 재시도 제거: 무한 깜빡임 방지)
                setDebugInfo(`버튼없음 (수동 로그인 필요)`);
            }
            if (msg.type === 'LOGIN_FORM_MISSING') {
                const inputList = (msg.inputs || []).map((i: any) => `${i.t}#${i.id||i.nm||'?'}`).join(' ');
                setDebugInfo(`폼없음:[${inputList}]`);
                setStep('manual');
                Alert.alert(
                    '자동 로그인 실패',
                    `로그인 폼을 찾지 못했습니다.\nID: ${IROS_USER_ID}\n\n직접 로그인 후 부동산 열람 메뉴로 이동해 주세요.`
                );
            }
            if (msg.type === 'ADDR_SEARCHED') {
                setStep('select');
                scheduleDetect(2000);
            }
            if (msg.type === 'NO_SEARCH_BTN') {
                scheduleDetect(1500);
            }
            if (msg.type === 'NO_ADDR_INPUT') {
                const inputList = (msg.inputs || []).map((i: any) =>
                    `${i.t}#${i.id||'?'}[${i.ph||''}]${i.vis?'V':'H'}`).join(' ');
                setDebugInfo(`주소창없음:[${inputList}]`);
                setStep('manual');
                Alert.alert('주소 직접 입력', `검색창에 아래 주소를 입력해 주세요:\n\n${searchAddress}`);
            }
            if (msg.type === 'HIGHLIGHT_DONE' && msg.count === 0 && cur === 'select') {
                setTimeout(() => injectJS(HIGHLIGHT_JS), 2000);
            }
            // 로그인 프레임 내부 진단: scwin/w2/컴포넌트 접근성 파악
            if (msg.type === 'FRAME_DIAG') {
                setDebugInfo(
                    `프레임진단: scwin=${msg.sType} w2=${msg.hasW2?'Y':'N'} btnFn=${msg.hasBtnFn?'Y':'N'}\n` +
                    `elProps:[${msg.elProps||'없음'}] globals:[${(msg.globals||'').slice(0,60)}]`
                );
            }
        } catch { }
    };

    if (!visible) return null;

    // 캐시 확인 중 로딩
    if (isCheckingCache) {
        return (
            <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
                <View style={styles.modalOverlay}>
                    <View style={styles.loadingBox}>
                        <ActivityIndicator size="large" color="#4A90E2" />
                        <Text style={[styles.loadingText, { marginTop: 16 }]}>기존 조회 내역 확인 중...</Text>
                    </View>
                </View>
            </Modal>
        );
    }

    // 이미 조회한 주소 → 캐시 표시
    if (cachedData) {
        return (
            <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
                <View style={styles.modalOverlay}>
                    <View style={[styles.modalContent, { paddingBottom: 34 }]}>
                        <Text style={styles.modalTitle}>🏛️ 이미 열람한 주소</Text>
                        <View style={styles.irosCacheCard}>
                            <Text style={styles.irosCacheDate}>
                                조회일: {new Date(cachedData.viewed_at).toLocaleDateString('ko-KR')}{' '}
                                {new Date(cachedData.viewed_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                            </Text>
                            <Text style={styles.irosCacheName}>{cachedData.road_address || '(도로명 없음)'}</Text>
                            <Text style={styles.irosCacheAddr}>{cachedData.jibun_address}</Text>
                        </View>
                        <Text style={styles.irosCacheNotice}>
                            이미 열람한 주소입니다.{'\n'}재열람 시 추가 비용이 발생할 수 있습니다.
                        </Text>
                        <View style={styles.propModalButtons}>
                            <TouchableOpacity style={styles.propCancelButton} onPress={onClose}>
                                <Text style={styles.propCancelButtonText}>닫기</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.propSaveButton}
                                onPress={() => { setCachedData(null); setStep('loading'); }}
                            >
                                <Text style={styles.propSaveButtonText}>재열람</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>
        );
    }

    // 실제 WebView 자동화 모달
    return (
        <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
            <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
                {/* 헤더 */}
                <View style={styles.irosHeader}>
                    <TouchableOpacity onPress={onClose} style={styles.irosCloseBtn}>
                        <Text style={styles.irosCloseBtnText}>✕</Text>
                    </TouchableOpacity>
                    <Text style={styles.irosHeaderTitle}>🏛️ 인터넷 등기소</Text>
                    <View style={{ width: 40 }} />
                </View>

                {/* 단계 안내 배너 */}
                <View style={[
                    styles.irosBanner,
                    (step === 'select' || step === 'manual') ? styles.irosBannerWarn :
                    step === 'done'   ? styles.irosBannerSuccess :
                    styles.irosBannerInfo,
                ]}>
                    {IROS_STEP_INFO[step].isAuto && (
                        <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
                    )}
                    <Text style={[
                        styles.irosBannerText,
                        (step === 'select' || step === 'manual') && { color: '#BF360C' },
                    ]}>
                        {IROS_STEP_INFO[step].label}
                    </Text>
                </View>

                {/* 검색 주소 + 디버그 정보 */}
                <View style={styles.irosAddressBar}>
                    <View style={{ flex: 1 }}>
                        {searchAddress.length > 0 && (
                            <Text style={styles.irosAddressBarText} numberOfLines={1}>
                                <Text style={styles.irosAddressBarLabel}>주소 </Text>
                                {searchAddress}
                            </Text>
                        )}
                        {debugInfo.length > 0 && (
                            <Text style={styles.irosDebugText} numberOfLines={2}>{debugInfo}</Text>
                        )}
                    </View>
                </View>

                {/* WebView */}
                <WebView
                    ref={webViewRef}
                    source={{ uri: 'https://m.iros.go.kr/' }}
                    onLoadEnd={handleLoadEnd}
                    onNavigationStateChange={handleNavigationStateChange}
                    onMessage={handleMessage}
                    javaScriptEnabled
                    domStorageEnabled
                    sharedCookiesEnabled
                    thirdPartyCookiesEnabled
                    originWhitelist={['*']}
                    mixedContentMode="always"
                    onShouldStartLoadWithRequest={(request) => {
                        const url = request.url;
                        // http/https 이동만 허용, intent:// / iros:// 등 딥링크 차단
                        if (url.startsWith('http://') || url.startsWith('https://')) {
                            return true;
                        }
                        return false;
                    }}
                    style={{ flex: 1 }}
                />
            </SafeAreaView>
        </Modal>
    );
};

// ===== 메인 앱 =====

function AppContent() {
    const [currentTab, setCurrentTab] = useState('home');
    const mapRef = useRef<MapView>(null);
    const { region, setRegion, selectedMarker, setSelectedMarker, mapType, setMapType, propertyMarkers, setPropertyMarkers, isDummyMode, setDummyMode } = useMapStore();

    const [isMapLoading, setIsMapLoading] = useState(false);
    const [loadingMessage, setLoadingMessage] = useState('');
    const [registryModalVisible, setRegistryModalVisible] = useState(false);
    const [selectedProperty, setSelectedProperty] = useState<Property | null>(null);
    const [propertyModalVisible, setPropertyModalVisible] = useState(false);
    const [irosModalVisible, setIrosModalVisible] = useState(false);
    const [irosRoadAddr, setIrosRoadAddr] = useState('');
    const [irosJibunAddr, setIrosJibunAddr] = useState('');

    // Supabase 매물 쿼리 (위치 기반)
    const { data: properties, refetch: refetchProperties } = useQuery({
        queryKey: ['properties', region.latitude.toFixed(3), region.longitude.toFixed(3)],
        queryFn: () => fetchPropertiesFromDB(region.latitude, region.longitude),
        enabled: isDummyMode, // 더미모드 활성화 시에만 조회
    });

    useEffect(() => {
        if (properties) setPropertyMarkers(properties);
    }, [properties]);

    // 앱 시작 시 위치 권한 요청 및 현재 위치 설정
    useEffect(() => {
        (async () => {
            if (region.latitude === 37.5665 && region.longitude === 126.9780) {
                try {
                    const { status } = await Location.requestForegroundPermissionsAsync();
                    if (status === 'granted') {
                        const location = await Location.getCurrentPositionAsync({});
                        setRegion({
                            latitude: location.coords.latitude,
                            longitude: location.coords.longitude,
                            latitudeDelta: 0.002,
                            longitudeDelta: 0.002,
                        });
                    }
                } catch (error) {
                    console.log("Location permission error");
                }
            }
        })();
    }, []);

    useEffect(() => {
        if (currentTab === 'home' && mapRef.current) {
            setTimeout(() => mapRef.current?.animateToRegion(region, 500), 100);
        }
    }, [currentTab, region]);

    // GPS 버튼: 더미데이터 모드 - 오산시 테스트 위치로 이동하여 매물 마커 표시
    const handleGpsPress = () => {
        Alert.alert(
            "위치 옵션",
            "어떤 방식으로 위치를 이동하시겠습니까?",
            [
                { text: "취소", style: "cancel" },
                {
                    text: "현재 위치",
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
                    }
                },
                {
                    text: "더미데이터 테스트 (오산시)",
                    onPress: () => {
                        // 오산시 가수동 일대로 이동하여 더미 매물 마커 표시
                        const dummyRegion = {
                            latitude: 37.1496,
                            longitude: 127.0700,
                            latitudeDelta: 0.008,
                            longitudeDelta: 0.008,
                        };
                        setLoadingMessage("더미데이터를 불러오는 중...");
                        setIsMapLoading(true);
                        setDummyMode(true);

                        setTimeout(() => {
                            setRegion(dummyRegion);
                            setSelectedMarker(null);
                            mapRef.current?.animateToRegion(dummyRegion, 1000);
                            setIsMapLoading(false);
                        }, 1000);
                    }
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

    const handleMapPress = async (e: any) => {
        const coordinate = e.nativeEvent.coordinate;
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
            setSelectedMarker({
                id: `marker-${Date.now()}`,
                name: "선택된 위치",
                address,
                distance: 0,
                latitude: coordinate.latitude,
                longitude: coordinate.longitude,
            });
            // IROS 열람용 정밀 지번주소 VWorld에서 백그라운드 조회
            setIrosRoadAddr(address);
            setIrosJibunAddr('');
            fetchPNU(coordinate.latitude, coordinate.longitude)
                .then(({ jibunAddr }) => setIrosJibunAddr(jibunAddr))
                .catch(() => { });
        } catch (error) {
            console.log("Reverse geocoding error", error);
        }
    };

    const handlePropertyMarkerPress = (prop: Property) => {
        setSelectedProperty(prop);
        setPropertyModalVisible(true);
    };

    const renderContent = () => {
        switch (currentTab) {
            case 'home':
                return (
                    <View style={styles.mapContainer}>
                        <MapView
                            ref={mapRef}
                            style={styles.map}
                            provider={PROVIDER_DEFAULT}
                            initialRegion={region}
                            onRegionChangeComplete={(r) => setRegion(r)}
                            showsUserLocation={true}
                            onPress={handleMapPress}
                        >
                            {mapType === 'cadastral' && (
                                <WMSTile
                                    urlTemplate={`https://api.vworld.kr/req/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&FORMAT=image/png&TRANSPARENT=true&LAYERS=lp_pa_cbnd_bonbun,lp_pa_cbnd_bubun&STYLES=,&CRS=EPSG:900913&BBOX={minX},{minY},{maxX},{maxY}&WIDTH={width}&HEIGHT={height}&key=${VWORLD_API_KEY}`}
                                    maximumZ={19}
                                    minimumZ={14}
                                    zIndex={1}
                                    opacity={0.7}
                                    tileSize={256}
                                />
                            )}

                            {/* 일반 선택 마커 */}
                            {selectedMarker && (
                                <Marker
                                    coordinate={{ latitude: selectedMarker.latitude, longitude: selectedMarker.longitude }}
                                />
                            )}

                            {/* Supabase/더미 매물 마커 */}
                            {propertyMarkers.map((prop) => {
                                const color = SALES_STATUS_COLORS[prop.sales_status] || '#9E9E9E';
                                return (
                                    <Marker
                                        key={prop.property_id}
                                        coordinate={{ latitude: prop.lat, longitude: prop.lng }}
                                        pinColor={color}
                                        title={prop.building_name || prop.road_address || '매물'}
                                        description={`${prop.sales_status} | ${prop.purpose || ''}`}
                                        onPress={() => handlePropertyMarkerPress(prop)}
                                    />
                                );
                            })}
                        </MapView>

                        {/* 지도 타입 탭 */}
                        <View style={styles.mapTypeContainer}>
                            <TouchableOpacity
                                style={[styles.tabButton, mapType === 'standard' && styles.activeTabButton]}
                                onPress={() => changeMapType('standard')}
                            >
                                <Text style={[styles.tabButtonText, mapType === 'standard' && styles.activeTabButtonText]}>일반지도</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[styles.tabButton, mapType === 'cadastral' && styles.activeTabButton]}
                                onPress={() => changeMapType('cadastral')}
                            >
                                <Text style={[styles.tabButtonText, mapType === 'cadastral' && styles.activeTabButtonText]}>지적도</Text>
                            </TouchableOpacity>
                        </View>

                        {/* 더미모드 뱃지 */}
                        {isDummyMode && (
                            <View style={styles.dummyBadge}>
                                <Text style={styles.dummyBadgeText}>더미데이터 모드</Text>
                                <TouchableOpacity onPress={() => { setDummyMode(false); setPropertyMarkers([]); }}>
                                    <Text style={styles.dummyBadgeClose}>✕</Text>
                                </TouchableOpacity>
                            </View>
                        )}

                        {/* GPS 버튼 */}
                        <TouchableOpacity style={styles.gpsButton} onPress={handleGpsPress}>
                            <Text style={styles.gpsButtonText}>📍</Text>
                        </TouchableOpacity>

                        <LoadingOverlay visible={isMapLoading} message={loadingMessage} />

                        {/* 선택된 일반 마커 하단 패널 */}
                        {selectedMarker && !propertyModalVisible && (
                            <View style={styles.bottomPanel}>
                                <View style={styles.bottomPanelHandle} />
                                <TouchableOpacity style={styles.bottomPanelClose} onPress={() => setSelectedMarker(null)}>
                                    <Text style={styles.bottomPanelCloseText}>X</Text>
                                </TouchableOpacity>
                                <Text style={styles.bottomPanelAddress}>{selectedMarker.address}</Text>
                                <Text style={styles.bottomPanelCoord}>
                                    {selectedMarker.latitude.toFixed(6)}, {selectedMarker.longitude.toFixed(6)}
                                </Text>
                                <View style={styles.bottomPanelButtons}>
                                    <TouchableOpacity
                                        style={styles.bottomPanelButtonRegistry}
                                        onPress={() => setRegistryModalVisible(true)}
                                    >
                                        <Text style={styles.bottomPanelButtonText}>등기정보 (Tilko)</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                        style={styles.bottomPanelButtonIros}
                                        onPress={() => setIrosModalVisible(true)}
                                    >
                                        <Text style={styles.bottomPanelButtonText}>🏛️ 온라인 등기 열람</Text>
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
        <SafeAreaView style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title}>태양광 영업지원 지도</Text>
            </View>

            {renderContent()}

            <View style={styles.floatingMenu}>
                <TouchableOpacity style={styles.menuItem} onPress={() => setCurrentTab('home')}>
                    <Text style={[styles.menuText, currentTab === 'home' && styles.activeMenuText]}>홈</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.menuItem} onPress={() => setCurrentTab('list')}>
                    <Text style={[styles.menuText, currentTab === 'list' && styles.activeMenuText]}>지도주변</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.menuItem} onPress={() => setCurrentTab('more')}>
                    <Text style={[styles.menuText, currentTab === 'more' && styles.activeMenuText]}>더보기</Text>
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

            {/* 온라인 등기소 열람 Modal */}
            <IROSRegistryModal
                visible={irosModalVisible}
                onClose={() => setIrosModalVisible(false)}
                marker={selectedMarker}
                roadAddress={irosRoadAddr}
                jibunAddress={irosJibunAddr}
            />
        </SafeAreaView>
    );
}

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
        backgroundColor: '#fff',
        paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0,
    },
    header: {
        height: 60,
        backgroundColor: '#4A90E2',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 10,
    },
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
        left: 30,
        right: 30,
        backgroundColor: '#fff',
        borderRadius: 30,
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'center',
        height: 60,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 3.84,
        elevation: 5,
        zIndex: 10,
    },
    menuItem: { flex: 1, alignItems: 'center', justifyContent: 'center', height: '100%' },
    menuText: { fontSize: 16, color: '#888', fontWeight: '600' },
    activeMenuText: { color: '#4A90E2', fontWeight: 'bold' },
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
    activeTabButton: { backgroundColor: '#4A90E2' },
    tabButtonText: { fontSize: 13, color: '#555', fontWeight: '600' },
    activeTabButtonText: { color: '#fff' },

    // 더미모드 뱃지
    dummyBadge: {
        position: 'absolute',
        top: 20,
        right: 20,
        backgroundColor: '#FF9800',
        borderRadius: 8,
        paddingVertical: 6,
        paddingHorizontal: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        elevation: 4,
    },
    dummyBadgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
    dummyBadgeClose: { color: '#fff', fontSize: 14, fontWeight: '700', marginLeft: 6 },

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
    bottomPanelClose: {
        position: 'absolute',
        top: 12,
        right: 12,
        padding: 6,
    },
    bottomPanelCloseText: { fontSize: 16, color: '#999' },
    bottomPanelAddress: { fontSize: 14, color: '#333', fontWeight: '600', marginBottom: 4, marginRight: 30 },
    bottomPanelCoord: { fontSize: 12, color: '#888', marginBottom: 12 },
    bottomPanelButtons: { flexDirection: 'row', gap: 8 },
    bottomPanelButton: {
        flex: 1,
        paddingVertical: 10,
        backgroundColor: '#4A90E2',
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
    bottomPanelButtonIros: {
        flex: 1,
        paddingVertical: 10,
        backgroundColor: '#6A1B9A',
        borderRadius: 8,
        alignItems: 'center',
    },
    bottomPanelButtonText: { color: '#fff', fontSize: 12, fontWeight: '600', textAlign: 'center' },

    // IROS 온라인 등기소
    irosHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
        backgroundColor: '#fff',
    },
    irosHeaderTitle: { fontSize: 17, fontWeight: '700', color: '#333' },
    irosCloseBtn: {
        width: 36, height: 36, borderRadius: 18,
        backgroundColor: '#f0f0f0',
        alignItems: 'center', justifyContent: 'center',
    },
    irosCloseBtnText: { fontSize: 16, color: '#555', fontWeight: '700' },
    irosBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    irosBannerInfo:    { backgroundColor: '#1565C0' },
    irosBannerWarn:    { backgroundColor: '#FFF3E0', borderBottomWidth: 2, borderBottomColor: '#E65100' },
    irosBannerSuccess: { backgroundColor: '#2E7D32' },
    irosBannerError:   { backgroundColor: '#C62828' },
    irosBannerText: {
        fontSize: 13, fontWeight: '600', color: '#fff',
        lineHeight: 18, flex: 1,
    },
    irosAddressBar: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#F5F5F5',
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
        gap: 8,
    },
    irosAddressBarLabel: { fontSize: 11, color: '#4A90E2', fontWeight: '700' },
    irosAddressBarText: { fontSize: 12, color: '#444' },
    irosDebugText: { fontSize: 10, color: '#888', marginTop: 2 },

    // IROS 캐시 카드
    irosCacheCard: {
        backgroundColor: '#E8F5E9',
        padding: 14,
        borderRadius: 10,
        marginBottom: 12,
        borderLeftWidth: 4,
        borderLeftColor: '#4CAF50',
    },
    irosCacheDate:   { fontSize: 11, color: '#2E7D32', fontWeight: '700', marginBottom: 6 },
    irosCacheName:   { fontSize: 14, color: '#1a1a1a', fontWeight: '700', marginBottom: 4 },
    irosCacheAddr:   { fontSize: 12, color: '#555' },
    irosCacheNotice: { fontSize: 13, color: '#888', textAlign: 'center', marginBottom: 16, lineHeight: 20 },

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
    accordionContent: {
        flexDirection: 'row',
        padding: 8,
        gap: 8,
    },
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

    // 스켈레톤
    skeletonBox: {
        backgroundColor: '#E0E0E0',
        borderRadius: 4,
    },
    loaderFooter: { padding: 16, alignItems: 'center' },
});
