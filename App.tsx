import 'react-native-url-polyfill/auto';
import React, { useState, useEffect, useRef } from 'react';
import {
    StyleSheet, Text, View, SafeAreaView, TouchableOpacity,
    Platform, StatusBar, Alert, FlatList, Animated,
    ActivityIndicator, Dimensions, TextInput, Modal, ScrollView,
} from 'react-native';
import MapView, { WMSTile, PROVIDER_DEFAULT, Region, Marker } from 'react-native-maps';
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
    if (registryJson.Status === 'Error' || (registryJson.Message && registryJson.Message !== 'OK')) {
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

async function fetchUniqueNoByAddress(addr: string): Promise<{ uniqueNo: string; realtyType: string; addrFull: string }[]> {
    const { encAesKey } = await createTilkoEncryption();
    const searchRes = await fetch('https://api.tilko.net/api/v2.0/Iros2/RetrieveSmplSrchList', {
        method: 'POST',
        headers: {
            'API-KEY': TILKO_API_KEY,
            'ENC-KEY': encAesKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ Address: addr, KindClsFlag: '0', Page: '1' }),
    });
    const searchJson = await searchRes.json();
    if (!searchJson.Message || searchJson.Message !== 'OK') {
        throw new Error(searchJson.ErrorLog || searchJson.Message || '고유번호 검색 실패');
    }
    const dataList = searchJson.DataList || [];
    if (dataList.length === 0) throw new Error('해당 주소에 대한 등기 정보를 찾을 수 없습니다.');
    return dataList.map((item: any) => ({
        uniqueNo: item.pin || item.wk_pin || '',
        realtyType: item.real_cls_cd || '',
        addrFull: item.real_indi_cont || '',
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
            const validItem = uniqueNoList.find(i => i.uniqueNo && i.realtyType === '집합건물')
                || uniqueNoList.find(i => i.uniqueNo && i.realtyType === '건물')
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
        <Animated.View style={[styles.loadingOverlay, { opacity: fadeAnim }]}>
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

// ===== PlaceSearchScreen =====

const PlaceSearchScreen = ({ onBack, onMoveToMap }: { onBack: () => void; onMoveToMap: () => void }) => {
    const [searchText, setSearchText] = useState('');
    const [searchResults, setSearchResults] = useState<Building[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const { setRegion, setSelectedMarker } = useMapStore();

    const handleSearch = async () => {
        if (!searchText.trim()) return;
        setIsLoading(true);
        try {
            let url = `https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=20&page=1&query=${encodeURIComponent(searchText)}&type=place&format=json&errorformat=json&key=${VWORLD_API_KEY}`;
            let response = await fetch(url);
            let json = await response.json();
            if (json.response.status === "NOT_FOUND" || !json.response.result) {
                url = `https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=20&page=1&query=${encodeURIComponent(searchText)}&type=address&format=json&errorformat=json&key=${VWORLD_API_KEY}`;
                response = await fetch(url);
                json = await response.json();
            }
            if (json.response.status === "NOT_FOUND" || !json.response.result) {
                setSearchResults([]);
            } else {
                setSearchResults(json.response.result.items.map((item: any) => ({
                    id: item.id,
                    name: item.title || item.address.road || item.address.parcel,
                    address: item.address.road || item.address.parcel,
                    distance: 0,
                    latitude: parseFloat(item.point.y),
                    longitude: parseFloat(item.point.x),
                })));
            }
        } catch (error) {
            Alert.alert("오류", "검색 중 문제가 발생했습니다.");
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <View style={styles.subScreenContainer}>
            <View style={styles.subScreenHeader}>
                <TouchableOpacity onPress={onBack} style={styles.backButton}>
                    <Text style={styles.backButtonText}>{'< 뒤로'}</Text>
                </TouchableOpacity>
                <Text style={styles.subScreenTitle}>장소 검색</Text>
                <View style={{ width: 50 }} />
            </View>
            <View style={styles.searchContainer}>
                <TextInput
                    style={styles.searchInput}
                    placeholder="도로명 또는 지번 주소 입력"
                    value={searchText}
                    onChangeText={setSearchText}
                    onSubmitEditing={handleSearch}
                />
                <TouchableOpacity onPress={handleSearch} style={styles.searchButton}>
                    <Text style={styles.searchButtonText}>검색</Text>
                </TouchableOpacity>
            </View>
            {isLoading ? (
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color="#4A90E2" />
                </View>
            ) : (
                <FlatList
                    data={searchResults}
                    keyExtractor={(item) => item.id}
                    renderItem={({ item }) => (
                        <View style={styles.listItemContainer}>
                            <View style={styles.listItem}>
                                <Text style={styles.itemName}>{item.name}</Text>
                                <Text style={styles.itemAddress}>{item.address}</Text>
                            </View>
                            <TouchableOpacity style={styles.viewLocationButton} onPress={() => {
                                Alert.alert("지도 이동", "해당 위치를 지도에서 보시겠습니까?", [
                                    { text: "취소", style: "cancel" },
                                    { text: "예", onPress: () => {
                                        setSelectedMarker(item);
                                        setRegion({ latitude: item.latitude, longitude: item.longitude, latitudeDelta: 0.002, longitudeDelta: 0.002 });
                                        onMoveToMap();
                                    }}
                                ]);
                            }}>
                                <Text style={styles.viewLocationButtonText}>위치보기</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                    ListEmptyComponent={<View style={styles.emptyContainer}><Text style={styles.emptyText}>검색 결과가 없습니다.</Text></View>}
                />
            )}
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

// ===== MoreScreen =====

const MoreScreen = ({ onMoveToMap }: { onMoveToMap: () => void }) => {
    const [currentView, setCurrentView] = useState<'menu' | 'search' | 'recent' | 'favorites'>('menu');
    if (currentView === 'search') return <PlaceSearchScreen onBack={() => setCurrentView('menu')} onMoveToMap={onMoveToMap} />;
    if (currentView === 'recent') return <RecentPlacesScreen onBack={() => setCurrentView('menu')} onMoveToMap={onMoveToMap} />;
    if (currentView === 'favorites') return <FavoritePlacesScreen onBack={() => setCurrentView('menu')} onMoveToMap={onMoveToMap} />;
    return (
        <View style={styles.menuContainer}>
            <TouchableOpacity style={styles.menuButton} onPress={() => setCurrentView('search')}><Text style={styles.menuButtonText}>장소 검색</Text></TouchableOpacity>
            <TouchableOpacity style={styles.menuButton} onPress={() => setCurrentView('recent')}><Text style={styles.menuButtonText}>최근 본 장소</Text></TouchableOpacity>
            <TouchableOpacity style={styles.menuButton} onPress={() => setCurrentView('favorites')}><Text style={styles.menuButtonText}>즐겨 찾는 장소</Text></TouchableOpacity>
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
                                        <Text style={styles.bottomPanelButtonText}>등기정보 확인 (Tilko)</Text>
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
    bottomPanelButtonText: { color: '#fff', fontSize: 13, fontWeight: '600' },

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
