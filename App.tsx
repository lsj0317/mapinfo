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
import { supabase, type Property, type SalesStatus } from './lib/supabase';

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
        uniqueNo: item.pin || item.wk_pin || '',
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
        setXmlData('');
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
    const [histXmlModalVisible, setHistXmlModalVisible] = useState(false);

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
    const { region, buildings, isLoading, isLoadingMore, fetchBuildings, lastFetchedRegion, page, hasMore, setRegion, setSelectedMarker, saveRecentPlace } = useMapStore();
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
                        <View style={styles.listItem}>
                            <View style={styles.itemHeader}>
                                <Text style={styles.itemName}>{item.name}</Text>
                                <Text style={styles.itemDistance}>{item.distance}m</Text>
                            </View>
                            {item.category ? <View style={styles.categoryBadge}><Text style={styles.categoryBadgeText}>{item.category}</Text></View> : null}
                            <Text style={styles.itemAddress}>{item.address}</Text>
                        </View>
                        <View style={styles.listItemActions}>
                            <TouchableOpacity style={[styles.listItemIconBtn, { paddingHorizontal: 10, width: 'auto' as any }]} onPress={async () => {
                                await saveRecentPlace(item);
                                setSelectedMarker(item);
                                setRegion({ latitude: item.latitude, longitude: item.longitude, latitudeDelta: 0.002, longitudeDelta: 0.002 });
                                onMoveToMap();
                            }}>
                                <Text style={{ color: '#4A90E2', fontSize: 13, fontWeight: '600' }}>보기</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.listItemIconBtn} onPress={() => toggleFavorite(item)}>
                                <Text style={[styles.listItemIconText, { color: favoriteIds.has(item.id) ? '#FFD700' : '#aaa' }]}>★</Text>
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
                        <Text style={styles.emptyText}>주변 1km 이내에 공장·창고·물류 건물이 없습니다.{'\n'}산업단지 주변으로 이동 후 새로고침 해주세요.</Text>
                    </View>
                }
            />
        </View>
    );
};

// ===== 메인 앱 =====

function AppContent() {
    const [currentTab, setCurrentTab] = useState('home');
    const mapRef = useRef<MapView>(null);
    const { region, setRegion, selectedMarker, setSelectedMarker, mapType, setMapType, propertyMarkers, setPropertyMarkers, saveRecentPlace } = useMapStore();

    const [isMapLoading, setIsMapLoading] = useState(false);
    const [loadingMessage, setLoadingMessage] = useState('');
    const [registryModalVisible, setRegistryModalVisible] = useState(false);
    const [selectedProperty, setSelectedProperty] = useState<Property | null>(null);
    const [propertyModalVisible, setPropertyModalVisible] = useState(false);
    const [registryRecord, setRegistryRecord] = useState<{ id: string; jibun_address?: string; xml_data?: string } | null>(null);
    const [isFavorite, setIsFavorite] = useState(false);

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
                            Alert.alert("오류", e.message || "갱신 중 오류가 발생했습니다.");
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
                            showsMyLocationButton={false}
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


                        {/* 현재 위치 버튼 */}
                        <TouchableOpacity style={styles.gpsButton} onPress={handleGpsPress}>
                            <Text style={styles.gpsButtonText}>🎯</Text>
                        </TouchableOpacity>

                        <LoadingOverlay visible={isMapLoading} message={loadingMessage} />

                        {/* 선택된 일반 마커 하단 패널 */}
                        {selectedMarker && !propertyModalVisible && (
                            <View style={styles.bottomPanel}>
                                <View style={styles.bottomPanelHandle} />
                                <View style={styles.bottomPanelTopRow}>
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.bottomPanelAddress}>{selectedMarker.address}</Text>
                                        <Text style={styles.bottomPanelCoord}>
                                            {selectedMarker.latitude.toFixed(6)}, {selectedMarker.longitude.toFixed(6)}
                                        </Text>
                                    </View>
                                    <View style={styles.bottomPanelIcons}>
                                        <TouchableOpacity style={styles.bottomPanelIconBtn} onPress={handleToggleFavorite}>
                                            <Text style={[styles.bottomPanelIconText, { color: isFavorite ? '#FFD700' : '#aaa' }]}>★</Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity style={styles.bottomPanelIconBtn} onPress={() => setSelectedMarker(null)}>
                                            <Text style={[styles.bottomPanelIconText, { color: '#999', fontSize: 16 }]}>✕</Text>
                                        </TouchableOpacity>
                                    </View>
                                </View>
                                <View style={styles.bottomPanelButtons}>
                                    <TouchableOpacity
                                        style={[styles.bottomPanelButtonRegistry, registryRecord ? { backgroundColor: '#1565C0' } : null]}
                                        onPress={() => {
                                            if (registryRecord) {
                                                handleRefreshRegistry();
                                            } else {
                                                setRegistryModalVisible(true);
                                            }
                                        }}
                                    >
                                        <Text style={styles.bottomPanelButtonText}>
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
