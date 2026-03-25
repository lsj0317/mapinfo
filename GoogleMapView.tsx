import React, { forwardRef, useImperativeHandle, useRef, useState, useEffect } from 'react';
import { View, Text } from 'react-native';
import MapView, { Marker, WMSTile, PROVIDER_GOOGLE } from 'react-native-maps';

export interface MapRegion {
    latitude: number;
    longitude: number;
    latitudeDelta: number;
    longitudeDelta: number;
}

export interface MapMarkerItem {
    id: string;
    latitude: number;
    longitude: number;
    type: 'building' | 'property' | 'cluster';
    color?: string;
    title?: string;
    count?: number;
}

export interface GoogleMapHandle {
    animateToRegion: (region: MapRegion, duration?: number) => void;
}

interface Props {
    style?: object;
    vworldApiKey?: string;
    initialRegion: MapRegion;
    onRegionChangeComplete?: (region: MapRegion) => void;
    onPress?: (coordinate: { latitude: number; longitude: number }) => void;
    onMarkerPress?: (id: string, markerType: string) => void;
    mapType?: 'standard' | 'cadastral';
    selectedMarker?: { latitude: number; longitude: number } | null;
    markers?: MapMarkerItem[];
    userLocation?: { latitude: number; longitude: number } | null;
    userHeading?: number | null;
    headingMode?: boolean;
    directionLabel?: string;
    onReady?: () => void;
    onLoadProgress?: (stage: 'sdkLoaded' | 'mapReady') => void;
}

// latitudeDelta < 0.04 ≈ zoom 14+ (지적도 표시 기준)
const CADASTRAL_MIN_LAT_DELTA = 0.04;

const GoogleMapView = forwardRef<GoogleMapHandle, Props>((props, ref) => {
    const mapRef = useRef<MapView>(null);
    const [latDelta, setLatDelta] = useState(props.initialRegion.latitudeDelta);

    useImperativeHandle(ref, () => ({
        animateToRegion(region: MapRegion, duration = 400) {
            mapRef.current?.animateToRegion(region, duration);
        },
    }));

    // heading 모드: 지도를 사용자 방향에 맞춰 회전
    useEffect(() => {
        if (props.headingMode && props.userHeading != null && mapRef.current) {
            const camera = {
                heading: props.userHeading,
                pitch: 0,
                zoom: 17,
            };
            (mapRef.current as any).animateCamera?.({ ...camera }, { duration: 300 });
        } else if (!props.headingMode && mapRef.current) {
            // heading 모드 해제 시 북쪽으로 복원
            (mapRef.current as any).animateCamera?.({ heading: 0, pitch: 0 }, { duration: 300 });
        }
    }, [props.headingMode, props.userHeading]);

    const showCadastral = props.mapType === 'cadastral' && !!props.vworldApiKey && latDelta < CADASTRAL_MIN_LAT_DELTA;

    const googleMapType = 'standard';

    return (
        <MapView
            ref={mapRef}
            provider={PROVIDER_GOOGLE}
            mapType={googleMapType}
            style={[{ flex: 1 }, props.style]}
            initialRegion={props.initialRegion}
            onRegionChangeComplete={(region) => {
                setLatDelta(region.latitudeDelta);
                props.onRegionChangeComplete?.(region);
            }}
            onPress={(e) => props.onPress?.(e.nativeEvent.coordinate)}
            onMapReady={() => {
                props.onLoadProgress?.('sdkLoaded');
                props.onLoadProgress?.('mapReady');
                props.onReady?.();
            }}
            showsUserLocation={true}
            showsMyLocationButton={false}
        >
            {/* VWorld 지적도 WMS 오버레이 - zoom 14+ 에서만 표시 */}
            {showCadastral && (
                <>
                    <WMSTile
                        urlTemplate={`https://api.vworld.kr/req/wms?key=${props.vworldApiKey}&SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=lp_pa_cbnd_bonbun&STYLES=lp_pa_cbnd_bonbun_line&CRS=EPSG:900913&BBOX={minX},{minY},{maxX},{maxY}&WIDTH=512&HEIGHT=512&FORMAT=image/png&TRANSPARENT=true`}
                        tileSize={512}
                        opacity={0.75}
                        zIndex={2}
                    />
                    <WMSTile
                        urlTemplate={`https://api.vworld.kr/req/wms?key=${props.vworldApiKey}&SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=lp_pa_cbnd_bubun&STYLES=lp_pa_cbnd_bubun_line&CRS=EPSG:900913&BBOX={minX},{minY},{maxX},{maxY}&WIDTH=512&HEIGHT=512&FORMAT=image/png&TRANSPARENT=true`}
                        tileSize={512}
                        opacity={0.75}
                        zIndex={3}
                    />
                </>
            )}

            {/* 마커 목록 */}
            {props.markers?.map((m) => (
                <Marker
                    key={m.id}
                    coordinate={{ latitude: m.latitude, longitude: m.longitude }}
                    pinColor={m.color || '#FF5722'}
                    title={m.title}
                    onPress={() => props.onMarkerPress?.(m.id, m.type)}
                />
            ))}

            {/* 선택된 마커 (파란 핀) */}
            {props.selectedMarker && (
                <Marker
                    coordinate={props.selectedMarker}
                    pinColor="#1976D2"
                />
            )}

            {/* 커스텀 사용자 위치 마커: 파란 원 + 방향 화살표 + 방위 말풍선 */}
            {props.userLocation && (
                <Marker
                    coordinate={props.userLocation}
                    anchor={{ x: 0.5, y: 0.4 }}
                    flat={true}
                    tracksViewChanges={true}
                >
                    <View style={{ alignItems: 'center', width: 80 }}>
                        {/* 파란 원 + 방향 부채꼴 */}
                        <View style={{ width: 60, height: 60, alignItems: 'center', justifyContent: 'center' }}>
                            {/* 방향 부채꼴 (heading이 있을 때만) */}
                            {props.userHeading != null && (
                                <View style={{
                                    position: 'absolute', width: 60, height: 60,
                                    alignItems: 'center', justifyContent: 'center',
                                    transform: [{ rotate: `${props.userHeading}deg` }],
                                }}>
                                    <View style={{
                                        position: 'absolute', top: 0,
                                        width: 0, height: 0,
                                        borderLeftWidth: 14, borderRightWidth: 14, borderBottomWidth: 22,
                                        borderLeftColor: 'transparent', borderRightColor: 'transparent',
                                        borderBottomColor: 'rgba(66,133,244,0.25)',
                                    }} />
                                </View>
                            )}
                            {/* 외곽 흰색 링 + 파란 원 */}
                            <View style={{
                                width: 22, height: 22, borderRadius: 11,
                                backgroundColor: '#FFFFFF',
                                alignItems: 'center', justifyContent: 'center',
                                elevation: 4, shadowColor: '#000', shadowOpacity: 0.25,
                                shadowOffset: { width: 0, height: 2 }, shadowRadius: 4,
                            }}>
                                <View style={{
                                    width: 16, height: 16, borderRadius: 8,
                                    backgroundColor: '#4285F4',
                                }} />
                            </View>
                        </View>

                        {/* 방위 말풍선 */}
                        {props.directionLabel ? (
                            <View style={{ alignItems: 'center', marginTop: -2 }}>
                                {/* 말풍선 꼬리 (위쪽 삼각형) */}
                                <View style={{
                                    width: 0, height: 0,
                                    borderLeftWidth: 5, borderRightWidth: 5, borderBottomWidth: 5,
                                    borderLeftColor: 'transparent', borderRightColor: 'transparent',
                                    borderBottomColor: '#18181B',
                                }} />
                                {/* 말풍선 본체 */}
                                <View style={{
                                    backgroundColor: '#18181B', borderRadius: 6,
                                    paddingHorizontal: 8, paddingVertical: 3,
                                }}>
                                    <Text style={{ color: '#FAFAFA', fontSize: 9, fontWeight: '700' }}>
                                        현재방향 : {props.directionLabel}
                                    </Text>
                                </View>
                            </View>
                        ) : null}
                    </View>
                </Marker>
            )}
        </MapView>
    );
});

export default GoogleMapView;
